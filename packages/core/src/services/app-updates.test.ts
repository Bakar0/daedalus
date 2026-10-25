import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "../config";
import { compareVersions, isNewerVersion } from "../versions";
import { AppUpdateService, chooseUpdate, updateFeeds } from "./app-updates";

describe("compareVersions", () => {
  test("compares each part as a number", () => {
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("v0.8.1", "0.8.0")).toBe(true);
    expect(isNewerVersion("0.8.0", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.7.9", "0.8.0")).toBe(false);
  });

  test("orders a release above its betas and betas by number", () => {
    const ascending = [
      "0.31.0",
      "0.32.0-beta.1",
      "0.32.0-beta.2",
      "0.32.0-beta.10",
      "0.32.0",
      "0.32.1-beta.1",
    ];
    for (let index = 1; index < ascending.length; index += 1) {
      expect(isNewerVersion(ascending[index]!, ascending[index - 1]!)).toBe(
        true,
      );
      expect(isNewerVersion(ascending[index - 1]!, ascending[index]!)).toBe(
        false,
      );
    }
    expect(compareVersions("0.32.0-beta.2", "0.32.0-beta.2")).toBe(0);
  });

  test("follows semver for other prerelease shapes", () => {
    expect(isNewerVersion("1.0.0-beta", "1.0.0-alpha.9")).toBe(true);
    expect(isNewerVersion("1.0.0-rc.1", "1.0.0-beta.11")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.1", "1.0.0-beta")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.x", "1.0.0-beta.9")).toBe(true);
  });

  test("never treats an unparsable version as newer", () => {
    expect(isNewerVersion("", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.9.0", "unknown")).toBe(false);
    expect(isNewerVersion("0.9", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.9.0-", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.9.0-beta..1", "0.8.0")).toBe(false);
    expect(compareVersions("0.9.0", "nonsense")).toBeUndefined();
  });
});

describe("chooseUpdate", () => {
  const stable = (version: string) =>
    ({ feed: "stable", version, updateAvailable: true }) as const;
  const beta = (version: string) =>
    ({ feed: "beta", version, updateAvailable: true }) as const;

  test("offers the highest version newer than the running one", () => {
    expect(
      chooseUpdate("0.31.0", [stable("0.31.0"), beta("0.32.0-beta.1")]),
    ).toEqual(beta("0.32.0-beta.1"));
    expect(
      chooseUpdate("0.32.0-beta.2", [stable("0.32.0"), beta("0.32.0-beta.2")]),
    ).toEqual(stable("0.32.0"));
  });

  test("stable wins a tie", () => {
    expect(chooseUpdate("0.31.0", [stable("0.32.0"), beta("0.32.0")])).toEqual(
      stable("0.32.0"),
    );
  });

  test("offers nothing older, equal, or with the running bundle's hash", () => {
    expect(chooseUpdate("0.32.0-beta.1", [stable("0.31.0")])).toBeUndefined();
    expect(chooseUpdate("0.31.0", [stable("0.31.0")])).toBeUndefined();
    expect(
      chooseUpdate("0.31.0", [
        { feed: "stable", version: "0.32.0", updateAvailable: false },
      ]),
    ).toBeUndefined();
  });

  test("reads the beta feed only with beta updates on", () => {
    expect(updateFeeds(false)).toEqual(["stable"]);
    expect(updateFeeds(true)).toEqual(["stable", "beta"]);
  });
});

describe("AppUpdateService", () => {
  test("is off until set, and the setting is stored", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const service = new AppUpdateService(
        await loadConfig({ DAEDALUS_HOME: home }),
      );
      expect(await service.betaUpdates()).toBe(false);
      expect(await service.setBetaUpdates(true)).toBe(true);
      expect(await Bun.file(`${home}/config.json`).json()).toMatchObject({
        betaUpdatesEnabled: true,
      });
      expect(
        (await loadConfig({ DAEDALUS_HOME: home })).betaUpdatesEnabled,
      ).toBe(true);
    });
  });

  test("the app sees a change the CLI made without restarting", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      // Two processes, each with its own config: the app's, loaded at launch,
      // and the CLI's.
      const appConfig = await loadConfig({ DAEDALUS_HOME: home });
      const app = new AppUpdateService(appConfig);
      const cli = new AppUpdateService(
        await loadConfig({ DAEDALUS_HOME: home }),
      );
      await cli.setBetaUpdates(true);
      expect(await app.feeds()).toEqual(["stable", "beta"]);
      expect(appConfig.betaUpdatesEnabled).toBe(true);
      await cli.setBetaUpdates(false);
      expect(await app.feeds()).toEqual(["stable"]);
    });
  });

  test("an unreadable config means stable only, not a failed check", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const service = new AppUpdateService(
        await loadConfig({ DAEDALUS_HOME: home }),
      );
      await service.setBetaUpdates(true);
      await Bun.write(`${home}/config.json`, "{ not json");
      expect(await service.feeds()).toEqual(["stable"]);
    });
  });
});

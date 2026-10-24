import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  buildChannel,
  channelHome,
  channelIdentifier,
  channelName,
  DEFAULT_REMOTE_RELAY,
  loadConfig,
  updateSettings,
} from "./config";

describe("loadConfig", () => {
  test("uses DAEDALUS_HOME without touching the real home", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      expect(config.home).toBe(home);
      expect(config.workspaceRoot).toBe(`${home}/workspaces`);
      expect(config.repositoryRoot).toBe(`${home}/repos`);
      expect(config.workspaceInstructionFilesEnabled).toBe(true);
      expect(await Bun.file(`${home}/config.json`).exists()).toBe(false);
    });
  });

  test("persists the workspace instruction preference without replacing other settings", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        `${home}/config.json`,
        JSON.stringify({ customSetting: "keep-me" }),
      );
      const config = await loadConfig({ DAEDALUS_HOME: home });
      await updateSettings(config, () => ({
        workspaceInstructionFilesEnabled: false,
      }));
      expect(config.workspaceInstructionFilesEnabled).toBe(false);
      expect(await Bun.file(`${home}/config.json`).json()).toMatchObject({
        customSetting: "keep-me",
        workspaceInstructionFilesEnabled: false,
      });
      expect(
        (await loadConfig({ DAEDALUS_HOME: home }))
          .workspaceInstructionFilesEnabled,
      ).toBe(false);
    });
  });

  test("keeps both keys when two saves run at once", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      await Promise.all([
        updateSettings(config, () => ({ focusMode: true })),
        updateSettings(config, (current) => ({
          skillOverrides: { ...current.skillOverrides, loud: "off" },
        })),
        updateSettings(config, (current) => ({
          skillOverrides: { ...current.skillOverrides, quiet: "off" },
        })),
      ]);
      expect(await Bun.file(`${home}/config.json`).json()).toMatchObject({
        focusMode: true,
        skillOverrides: { loud: "off", quiet: "off" },
      });
      expect(config.skillOverrides).toEqual({ loud: "off", quiet: "off" });
    });
  });

  test("keeps a nested entry another writer added between two saves", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      const profile = (id: string) => ({
        id,
        provider: "claude" as const,
        name: id,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await updateSettings(config, (current) => ({
        accounts: [...current.accounts, profile("app-one")],
      }));
      // The CLI is another process: it writes the file, not this config.
      const stored = await Bun.file(`${home}/config.json`).json();
      await Bun.write(
        `${home}/config.json`,
        JSON.stringify({
          ...stored,
          accounts: [...stored.accounts, profile("cli-two")],
          focusMode: true,
          customSetting: "keep-me",
        }),
      );
      await updateSettings(config, (current) => ({
        accounts: [...current.accounts, profile("app-three")],
      }));
      // A setting the other writer changed follows the file too.
      expect(config.focusMode).toBe(true);
      const ids = (accounts: { id: string }[]) => accounts.map((a) => a.id);
      const reloaded = await loadConfig({ DAEDALUS_HOME: home });
      expect(ids(reloaded.accounts)).toEqual([
        "app-one",
        "cli-two",
        "app-three",
      ]);
      expect(ids(config.accounts)).toEqual(ids(reloaded.accounts));
      expect(await Bun.file(`${home}/config.json`).json()).toMatchObject({
        customSetting: "keep-me",
      });
    });
  });

  test("removes a field returned as undefined from the file", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      await updateSettings(config, () => ({ claudeOutputStyleWritten: "x" }));
      await updateSettings(config, () => ({
        claudeOutputStyleWritten: undefined,
      }));
      expect(await Bun.file(`${home}/config.json`).json()).not.toHaveProperty(
        "claudeOutputStyleWritten",
      );
      expect(config.claudeOutputStyleWritten).toBeUndefined();
    });
  });

  test("a failed save does not block the next one", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      const failing = updateSettings(config, () => {
        throw new Error("nope");
      });
      await expect(failing).rejects.toThrow("nope");
      await updateSettings(config, () => ({ focusMode: true }));
      expect(await Bun.file(`${home}/config.json`).json()).toMatchObject({
        focusMode: true,
      });
    });
  });

  test("keeps phone access off until it is turned on", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      expect(config.remoteEnabled).toBe(false);
      expect(config.remoteRelay).toBe(DEFAULT_REMOTE_RELAY);
      await updateSettings(config, () => ({ remoteEnabled: true }));
      const reloaded = await loadConfig({
        DAEDALUS_HOME: home,
        DAEDALUS_REMOTE_RELAY: "ws://127.0.0.1:8787",
      });
      expect(reloaded.remoteEnabled).toBe(true);
      expect(reloaded.remoteRelay).toBe("ws://127.0.0.1:8787");
    });
  });
});

test("keeps non-stable channels out of the stable home", () => {
  // Same home would mean two apps on one SQLite file.
  expect(channelHome("dev", "/Users/x/.daedalus")).toBe(
    "/Users/x/.daedalus-dev",
  );
  expect(channelHome("canary", "/Users/x/.daedalus")).toBe(
    "/Users/x/.daedalus-canary",
  );
  // Stable is the home everything already points at, and an unpackaged run
  // (no version.json, so no channel) must not be relocated either.
  expect(channelHome("stable", "/Users/x/.daedalus")).toBe(
    "/Users/x/.daedalus",
  );
  expect(channelHome(undefined, "/Users/x/.daedalus")).toBe(
    "/Users/x/.daedalus",
  );
  // Daedalus exports DAEDALUS_HOME into every agent session it starts, so an
  // agent that builds a dev app and opens it hands the *stable* home straight
  // to it. An inherited home must still be pushed onto the channel's own home
  // rather than honoured as though someone had chosen it.
  expect(channelHome("dev", "/Users/x/.daedalus")).toBe(
    "/Users/x/.daedalus-dev",
  );
  // Re-applying the suffix must not stack it.
  expect(channelHome("dev", "/Users/x/.daedalus-dev")).toBe(
    "/Users/x/.daedalus-dev",
  );
});

test("names every home other than the stable one apart from the rest", () => {
  expect(channelName("/Users/x/.daedalus")).toBe("stable");
  expect(channelName("/Users/x/.daedalus-dev")).toBe("dev");
  // A dev build run with DAEDALUS_HOME=~/.daedalus-cloudtest. Read as stable,
  // it took over the stable app's skill links and pointed them at its own CLI.
  // Read as dev, it would fight the real ~/.daedalus-dev the same way.
  const cloudtest = channelHome("dev", "/Users/x/.daedalus-cloudtest");
  expect(channelName(cloudtest)).toBe("cloudtest-dev");
  expect(channelName("/Users/x/.daedalus-lifecycle-try-dev")).toBe(
    "lifecycle-try-dev",
  );
  expect(channelName("/Users/x/.daedalus-dev/")).toBe("dev");
  // A dev build pointed somewhere else entirely still ends its home in -dev.
  expect(channelName("/tmp/scratch/home-dev")).toBe("home-dev");
  // A stable build's own choice of home, or an unpackaged run's.
  expect(channelName("/tmp/scratch/home")).toBe("stable");
  expect(channelName("/Users/x/.daedalus-work-2")).toBe("stable");
  expect(channelIdentifier("/Users/x/.daedalus-work-2")).toBe(
    "dev.daedalus.app",
  );
});

test("raises the app that owns a home, however that home is named", () => {
  expect(buildChannel("/Users/x/.daedalus")).toBe("stable");
  expect(buildChannel("/Users/x/.daedalus-cloudtest-dev")).toBe("dev");
  expect(channelIdentifier("/Users/x/.daedalus")).toBe("dev.daedalus.app");
  expect(channelIdentifier("/Users/x/.daedalus-dev")).toBe(
    "dev.daedalus.app.dev",
  );
  expect(channelIdentifier("/Users/x/.daedalus-cloudtest-dev")).toBe(
    "dev.daedalus.app.dev",
  );
  expect(channelIdentifier("/Users/x/.daedalus-canary")).toBe(
    "dev.daedalus.app.canary",
  );
});

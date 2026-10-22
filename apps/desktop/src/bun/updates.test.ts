import { describe, expect, test } from "vitest";
import type { AppUpdateDto } from "@daedalus/protocol";
import {
  FIRST_UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateController,
  type AppUpdater,
} from "./updates";

function harness(
  options: {
    channel?: string;
    current?: string;
    latest?: string;
    updateAvailable?: boolean;
    checkError?: string;
    downloadReady?: boolean;
    dismissed?: string;
    /** "Get beta updates"; the beta feed's answer is `beta`. */
    betaUpdates?: boolean;
    beta?: { latest?: string; updateAvailable?: boolean; checkError?: string };
    /** Each check waits on this, so a test can hold one open. */
    checkGate?: () => Promise<void>;
  } = {},
) {
  const published: Array<AppUpdateDto | null> = [];
  const timers: Array<{ ms: number; repeating: boolean }> = [];
  const calls: string[] = [];
  let dismissed = options.dismissed;
  const updater: AppUpdater = {
    local: async () => ({
      version: options.current ?? "0.8.0",
      channel: options.channel ?? "stable",
    }),
    check: async (feed) => {
      calls.push(`check:${feed}`);
      await options.checkGate?.();
      calls.push(`checked:${feed}`);
      const answer =
        feed === "beta"
          ? (options.beta ?? {})
          : {
              latest: options.latest ?? "0.9.0",
              updateAvailable: options.updateAvailable,
              checkError: options.checkError,
            };
      return {
        version: answer.latest ?? "",
        updateAvailable: answer.updateAvailable ?? true,
        ...(answer.checkError ? { error: answer.checkError } : {}),
      };
    },
    download: async (feed) => {
      calls.push(`download:${feed}`);
      return { ready: options.downloadReady ?? true };
    },
    apply: async () => {
      calls.push("apply");
    },
  };
  const controller = new UpdateController({
    updater,
    feeds: async () => (options.betaUpdates ? ["stable", "beta"] : ["stable"]),
    readDismissed: async () => dismissed,
    writeDismissed: async (version) => {
      dismissed = version;
    },
    publish: (update) => published.push(update),
    beforeRestart: async () => {
      calls.push("beforeRestart");
    },
    setTimer: (_callback, ms) => timers.push({ ms, repeating: false }),
    setRepeatingTimer: (_callback, ms) => timers.push({ ms, repeating: true }),
  });
  return {
    controller,
    published,
    timers,
    calls,
    dismissed: () => dismissed,
  };
}

describe("UpdateController", () => {
  test("offers a newer release", async () => {
    const { controller, published } = harness();
    await controller.check();
    expect(published.at(-1)).toEqual({
      state: "available",
      currentVersion: "0.8.0",
      version: "0.9.0",
    });
  });

  test("a different build of the same version is not an update", async () => {
    // Electrobun reports one whenever the hashes differ, which every local
    // `app:install` build does.
    const { controller, published } = harness({ latest: "0.8.0" });
    await controller.check();
    expect(published.at(-1)).toBeNull();
  });

  test("an older release is not offered to a newer local build", async () => {
    const { controller, published } = harness({
      current: "0.9.1",
      latest: "0.9.0",
    });
    await controller.check();
    expect(published.at(-1)).toBeNull();
  });

  test("a background check that fails says nothing", async () => {
    const { controller, published } = harness({ checkError: "offline" });
    await controller.check();
    expect(published).toEqual([]);
  });

  test("a check from the menu always answers", async () => {
    const upToDate = harness({ latest: "0.8.0" });
    await upToDate.controller.check({ manual: true });
    expect(upToDate.published.at(-1)).toEqual({
      state: "current",
      currentVersion: "0.8.0",
    });

    const offline = harness({ checkError: "offline" });
    await offline.controller.check({ manual: true });
    expect(offline.published.at(-1)).toMatchObject({
      state: "error",
      message: "Could not check for updates: offline",
    });
  });

  test("Later hides that version until a newer one ships", async () => {
    const { controller, published, dismissed } = harness();
    await controller.check();
    await controller.dismiss("0.9.0");
    expect(dismissed()).toBe("0.9.0");
    await controller.check();
    expect(published.at(-1)).toBeNull();
    // Asking from the menu still shows it.
    await controller.check({ manual: true });
    expect(published.at(-1)).toMatchObject({ state: "available" });
  });

  test("a dismissed version does not hide a newer one", async () => {
    const { controller, published } = harness({
      latest: "0.9.1",
      dismissed: "0.9.0",
    });
    await controller.check();
    expect(published.at(-1)).toMatchObject({ version: "0.9.1" });
  });

  test("Update downloads, cleans up, then replaces the app", async () => {
    const { controller, published, calls } = harness();
    await controller.check();
    await controller.install();
    expect(calls).toEqual([
      "check:stable",
      "checked:stable",
      "download:stable",
      "beforeRestart",
      "apply",
    ]);
    expect(published.map((update) => update?.state)).toContain("downloading");
    expect(published.map((update) => update?.state)).toContain("restarting");
  });

  test("a failed download leaves the app as it is and says so", async () => {
    const { controller, published, calls } = harness({ downloadReady: false });
    await controller.check();
    await controller.install();
    expect(calls).not.toContain("apply");
    expect(published.at(-1)).toMatchObject({
      state: "error",
      version: "0.9.0",
    });
  });

  test("an apply that returns reports the install as failed", async () => {
    const { controller, published } = harness();
    await controller.check();
    await controller.install();
    // The fake apply returns instead of quitting, which is what the real one
    // does when it gives up.
    expect(published.at(-1)).toMatchObject({
      state: "error",
      message:
        "Could not install Daedalus 0.9.0. The current version is unchanged.",
    });
  });

  test("install does nothing without an offer", async () => {
    const { controller, calls } = harness({ latest: "0.8.0" });
    await controller.check();
    await controller.install();
    expect(calls).toEqual(["check:stable", "checked:stable"]);
  });

  test("dev builds never check", async () => {
    const { controller, timers, calls, published } = harness({
      channel: "dev",
    });
    await controller.start();
    expect(timers).toEqual([]);
    await controller.check();
    expect(calls).toEqual([]);
    expect(published).toEqual([]);
  });

  test("stable builds check shortly after launch and then periodically", async () => {
    const { controller, timers } = harness();
    await controller.start();
    expect(timers).toEqual([
      { ms: FIRST_UPDATE_CHECK_DELAY_MS, repeating: false },
      { ms: UPDATE_CHECK_INTERVAL_MS, repeating: true },
    ]);
  });
});

describe("UpdateController with beta updates", () => {
  test("off, the beta feed is never read", async () => {
    const { controller, published, calls } = harness({
      beta: { latest: "0.10.0-beta.1" },
    });
    await controller.check();
    expect(calls).toEqual(["check:stable", "checked:stable"]);
    expect(published.at(-1)).toMatchObject({ version: "0.9.0" });
  });

  test("on, a beta newer than stable is offered and downloaded from the beta feed", async () => {
    const { controller, published, calls } = harness({
      betaUpdates: true,
      beta: { latest: "0.10.0-beta.1" },
    });
    await controller.check();
    expect(published.at(-1)).toEqual({
      state: "available",
      currentVersion: "0.8.0",
      version: "0.10.0-beta.1",
    });
    await controller.install();
    expect(calls).toEqual([
      "check:stable",
      "checked:stable",
      "check:beta",
      "checked:beta",
      "download:beta",
      "beforeRestart",
      "apply",
    ]);
  });

  test("on, a stable release past the beta wins", async () => {
    const { controller, published, calls } = harness({
      betaUpdates: true,
      current: "0.10.0-beta.2",
      latest: "0.10.0",
      beta: { latest: "0.10.0-beta.2" },
    });
    await controller.check();
    expect(published.at(-1)).toMatchObject({ version: "0.10.0" });
    await controller.install();
    expect(calls).toContain("download:stable");
  });

  test("a newer beta replaces an older one", async () => {
    const { controller, published } = harness({
      betaUpdates: true,
      current: "0.10.0-beta.1",
      latest: "0.9.0",
      beta: { latest: "0.10.0-beta.2" },
    });
    await controller.check();
    expect(published.at(-1)).toMatchObject({ version: "0.10.0-beta.2" });
  });

  test("turning beta off never offers the older stable release", async () => {
    const { controller, published } = harness({
      current: "0.10.0-beta.2",
      latest: "0.9.0",
    });
    await controller.check({ manual: true });
    expect(published.at(-1)).toEqual({
      state: "current",
      currentVersion: "0.10.0-beta.2",
    });
  });

  test("a missing beta feed leaves the stable answer standing", async () => {
    const { controller, published } = harness({
      betaUpdates: true,
      beta: { checkError: "HTTP 404" },
    });
    await controller.check({ manual: true });
    expect(published.at(-1)).toMatchObject({
      state: "available",
      version: "0.9.0",
    });
  });

  test("an unreachable stable feed still lets a beta through", async () => {
    const { controller, published } = harness({
      betaUpdates: true,
      checkError: "HTTP 500",
      beta: { latest: "0.10.0-beta.1" },
    });
    await controller.check();
    expect(published.at(-1)).toMatchObject({ version: "0.10.0-beta.1" });
  });

  test("an install clicked during a check waits for it and takes its offer", async () => {
    const gates: Array<() => void> = [];
    let hold = false;
    const { controller, calls } = harness({
      betaUpdates: true,
      beta: { latest: "0.10.0-beta.1" },
      checkGate: () =>
        hold
          ? new Promise<void>((resolve) => gates.push(resolve))
          : Promise.resolve(),
    });
    const until = async (condition: () => boolean) => {
      while (!condition())
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await controller.check();
    calls.length = 0;
    hold = true;
    const checking = controller.check();
    const installing = controller.install();
    await until(() => gates.length === 1);
    // The check is still reading stable; nothing has been downloaded.
    expect(calls).toEqual(["check:stable"]);
    gates[0]!();
    await until(() => gates.length === 2);
    expect(calls).not.toContain("download:beta");
    gates[1]!();
    await checking;
    await installing;
    expect(calls).toEqual([
      "check:stable",
      "checked:stable",
      "check:beta",
      "checked:beta",
      "download:beta",
      "beforeRestart",
      "apply",
    ]);
  });

  test("a manual check reports the first failure when no feed answers", async () => {
    const { controller, published } = harness({
      betaUpdates: true,
      checkError: "offline",
      beta: { checkError: "offline too" },
    });
    await controller.check({ manual: true });
    expect(published.at(-1)).toMatchObject({
      state: "error",
      message: "Could not check for updates: offline",
    });
  });
});

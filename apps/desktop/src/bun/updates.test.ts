import { describe, expect, test } from "vitest";
import type { AppUpdateDto } from "@daedalus/protocol";
import {
  FIRST_UPDATE_CHECK_DELAY_MS,
  isNewerVersion,
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
    check: async () => {
      calls.push("check");
      return {
        version: options.latest ?? "0.9.0",
        updateAvailable: options.updateAvailable ?? true,
        ...(options.checkError ? { error: options.checkError } : {}),
      };
    },
    download: async () => {
      calls.push("download");
      return { ready: options.downloadReady ?? true };
    },
    apply: async () => {
      calls.push("apply");
    },
  };
  const controller = new UpdateController({
    updater,
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

describe("isNewerVersion", () => {
  test("compares each part as a number", () => {
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("v0.8.1", "0.8.0")).toBe(true);
    expect(isNewerVersion("0.8.0", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.7.9", "0.8.0")).toBe(false);
  });

  test("never treats an unparsable version as newer", () => {
    expect(isNewerVersion("", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.9.0-beta.1", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.9.0", "unknown")).toBe(false);
  });
});

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
    expect(calls).toEqual(["check", "download", "beforeRestart", "apply"]);
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
    expect(calls).toEqual(["check"]);
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

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "../config";
import {
  cachedIdleSampler,
  PresenceService,
  PRESENCE_MAX_AGE_MS,
  WINDOW_HEARTBEAT_GRACE_MS,
} from "./presence";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("PresenceService", () => {
  test("publishes a heartbeat that later readers can see", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const presence = new PresenceService(
        await loadConfig({ DAEDALUS_HOME: home }),
      );
      await presence.publish({
        appForeground: true,
        workspaceId: "workspace-1",
        sessionId: "session-1",
      });
      const state = await presence.read();
      expect(state.appRunning).toBe(true);
      expect(state.appForeground).toBe(true);
      expect(state.sessionId).toBe("session-1");
    });
  });

  test("a stale heartbeat from a dead process means no app", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      const presence = new PresenceService(config, { isAlive: () => false });
      await presence.publish({
        appForeground: true,
        workspaceId: null,
        sessionId: null,
      });
      const state = await presence.read(Date.now() + PRESENCE_MAX_AGE_MS + 1);
      expect(state.appRunning).toBe(false);
      expect(state.appForeground).toBe(false);
    });
  });

  test("a stale heartbeat from a live process means a busy app in the background", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      const seen: number[] = [];
      const presence = new PresenceService(config, {
        isAlive: (pid) => {
          seen.push(pid);
          return true;
        },
      });
      await presence.publish({
        appForeground: true,
        workspaceId: "workspace-1",
        sessionId: "session-1",
      });
      const state = await presence.read(Date.now() + PRESENCE_MAX_AGE_MS + 1);
      expect(seen).toEqual([process.pid]);
      expect(state.appRunning).toBe(true);
      // Nothing that old says where the user is looking.
      expect(state.appForeground).toBe(false);
      expect(state.sessionId).toBeNull();
      expect(state.workspaceId).toBe("workspace-1");
    });
  });

  test("a file from before pids were recorded still reads as no app once stale", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      await Bun.write(
        join(home, "presence.json"),
        JSON.stringify({
          appForeground: true,
          workspaceId: null,
          sessionId: null,
          userIdleSeconds: 0,
          observedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const presence = new PresenceService(config, { isAlive: () => true });
      expect((await presence.read()).appRunning).toBe(false);
    });
  });

  test("the idle sampler answers at once and refreshes in the background", async () => {
    let calls = 0;
    let clock = 0;
    const sampler = cachedIdleSampler(
      async () => {
        calls += 1;
        return 42;
      },
      1_000,
      () => clock,
    );
    expect(await sampler()).toBe(0);
    await sleep(5);
    expect(await sampler()).toBe(42);
    expect(calls).toBe(1);
    clock = 999;
    await sampler();
    expect(calls).toBe(1);
    clock = 1_000;
    await sampler();
    await sleep(5);
    expect(calls).toBe(2);
  });

  test("the host stands in for a window that has gone quiet", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const presence = new PresenceService(
        await loadConfig({ DAEDALUS_HOME: home }),
      );
      const start = Date.now();
      await presence.publish(
        { appForeground: true, workspaceId: "workspace-1", sessionId: "s-1" },
        start,
      );
      // The window is still reporting: nothing to do.
      expect(
        await presence.keepAlive(start + WINDOW_HEARTBEAT_GRACE_MS - 1),
      ).toBeUndefined();
      // Then it stops, as a closed or throttled window does. The heartbeat
      // keeps going, as a running app nobody is looking at.
      const later = start + WINDOW_HEARTBEAT_GRACE_MS;
      const state = await presence.keepAlive(later);
      expect(state?.appRunning).toBe(true);
      expect(state?.appForeground).toBe(false);
      expect(state?.workspaceId).toBe("workspace-1");
      expect(state?.sessionId).toBeNull();
      const read = await presence.read(later + PRESENCE_MAX_AGE_MS - 1);
      expect(read.appRunning).toBe(true);
      expect(read.appForeground).toBe(false);
    });
  });

  test("the host heartbeat says running, never that the window was launched", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const presence = new PresenceService(
        await loadConfig({ DAEDALUS_HOME: home }),
      );
      // A host that has never heard from a window at all still counts as an
      // app: the launch itself is the first thing it can vouch for.
      const state = await presence.keepAlive();
      expect(state?.appRunning).toBe(true);
      expect(state?.appForeground).toBe(false);
      expect(state?.workspaceId).toBeNull();
    });
  });

  test("reads as offline when the app has never run", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const presence = new PresenceService(
        await loadConfig({ DAEDALUS_HOME: home }),
      );
      expect((await presence.read()).appRunning).toBe(false);
    });
  });

  test("persists focus mode without dropping the rest of the settings", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({ agents: { shell: { executable: "sh", args: [] } } }),
      );
      const config = await loadConfig({ DAEDALUS_HOME: home });
      expect(config.focusMode).toBe(false);
      await new PresenceService(config).setFocusMode(true);
      const reloaded = await loadConfig({ DAEDALUS_HOME: home });
      expect(reloaded.focusMode).toBe(true);
      expect(reloaded.agents.shell?.executable).toBe("sh");
    });
  });
});

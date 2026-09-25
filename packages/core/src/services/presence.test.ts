import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "../config";
import {
  PresenceService,
  PRESENCE_MAX_AGE_MS,
  WINDOW_HEARTBEAT_GRACE_MS,
} from "./presence";

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

  test("a stale heartbeat means no app, not an app in the background", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      const presence = new PresenceService(config);
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

  test("with a sidecar attached, publish forwards and nothing is written here", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const presence = new PresenceService(
        await loadConfig({ DAEDALUS_HOME: home }),
      );
      const sent: unknown[] = [];
      let stopped = 0;
      presence.attachHeartbeat({
        send: (report) => sent.push(report),
        stop: () => {
          stopped += 1;
        },
      });
      const report = {
        appForeground: true,
        workspaceId: "w",
        sessionId: "s",
      };
      const state = await presence.publish(report);
      expect(state.appRunning).toBe(true);
      expect(sent).toEqual([report]);
      // The sidecar owns the file now.
      expect((await presence.read()).appRunning).toBe(false);
      expect(await presence.keepAlive(Date.now() + 60_000)).toBeUndefined();
      await presence.retire();
      expect(stopped).toBe(1);
      expect(presence.heartbeatAttached).toBe(false);
      // Detached, it writes for itself again.
      await presence.publish(report);
      expect((await presence.read()).appRunning).toBe(true);
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

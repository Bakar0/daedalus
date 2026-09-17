import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "../config";
import { PresenceService, PRESENCE_MAX_AGE_MS } from "./presence";

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

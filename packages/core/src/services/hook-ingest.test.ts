import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  createApplicationContext,
  ingestHook,
  ingestStatusLine,
  readActivityRecord,
  writeActivityRecord,
  type ApplicationContext,
} from "../index";

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
    this.sessions.add(launch.session);
  }
  async hasSession(session: string) {
    return this.sessions.has(session);
  }
  async listSessions() {
    return [...this.sessions];
  }
  async attach() {
    return 0;
  }
  async capture() {
    return "Claude Code\nshift+tab to cycle";
  }
  async sendKeys() {}
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    const running = this.sessions.size > 0;
    this.sessions.clear();
    return running;
  }
}

/**
 * One context for the whole test, handed to `ingestHook` through a counting
 * `openContext` so a test can see how often the hook opened it and that it
 * closed what it opened. The test closes the real context itself.
 */
async function withSession(
  run: (input: {
    context: ApplicationContext;
    sessionId: string;
    home: string;
    ingest: (
      event: string,
      payload: Record<string, unknown> | string,
    ) => Promise<void>;
    opened: () => number;
    closed: () => number;
    advance: (ms: number) => void;
  }) => Promise<void>,
): Promise<void> {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: { claude: { executable: process.execPath, args: [] } },
      }),
    );
    let offset = 0;
    const context = await createApplicationContext({
      env: { DAEDALUS_HOME: home, CLAUDE_CONFIG_DIR: home },
      tmux: new FakeTmux(),
      now: () => new Date(Date.now() + offset),
      sendNativeNotification: async () => ({
        delivered: true,
        backend: "terminal-notifier" as const,
        degraded: false,
      }),
    });
    let opened = 0;
    let closed = 0;
    try {
      const workspace = await context.workspaces.create({ name: "Hooks" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
        name: "Claude",
      });
      context.activity.forget(session.id);
      await run({
        context,
        sessionId: session.id,
        home,
        ingest: (event, payload) =>
          ingestHook({
            home,
            sessionId: session.id,
            event,
            readPayload: async () =>
              typeof payload === "string"
                ? payload
                : JSON.stringify({ hook_event_name: event, ...payload }),
            openContext: async () => {
              opened += 1;
              return {
                ...context,
                close: () => {
                  closed += 1;
                },
              };
            },
          }),
        opened: () => opened,
        closed: () => closed,
        advance: (ms) => {
          offset += ms;
        },
      });
    } finally {
      context.close();
    }
  });
}

const permissionPrompt = {
  notification_type: "permission_prompt",
  message: "Claude needs your permission to use Bash",
};
const bashTool = { tool_name: "Bash", tool_input: { command: "git push" } };

describe("ingestHook", () => {
  test("writes the reading to the index and the durable record", async () => {
    await withSession(async ({ context, sessionId, home, ingest }) => {
      await ingest("UserPromptSubmit", { prompt: "go" });
      expect(context.activity.get(sessionId)).toMatchObject({
        activity: "working",
        source: "hook",
      });
      expect(await readActivityRecord(home, sessionId)).toMatchObject({
        activity: "working",
      });
    });
  });

  test("an observation the guards reject never reaches the record", async () => {
    await withSession(async ({ context, sessionId, home, ingest }) => {
      await ingest("Notification", permissionPrompt);
      // A late PreToolUse from the same turn: the index refuses it, and so
      // must the record, or the next startup replays it as `working`.
      await ingest("PreToolUse", bashTool);
      expect(context.activity.get(sessionId)?.activity).toBe(
        "needs_permission",
      );
      expect((await readActivityRecord(home, sessionId))?.activity).toBe(
        "needs_permission",
      );
      await context.activity.restore();
      expect(context.activity.get(sessionId)?.activity).toBe(
        "needs_permission",
      );
    });
  });

  test("a write the index rejects after the record admitted it is undone", async () => {
    await withSession(async ({ context, sessionId, home, ingest }) => {
      await ingest("Notification", permissionPrompt);
      // The record and the index disagree, as after a hook that ran with the
      // database down: the record says idle, the index a permission wait.
      const prior = {
        sessionId,
        activity: "idle" as const,
        detail: null,
        since: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        source: "hook" as const,
      };
      await writeActivityRecord(home, prior);
      await ingest("PreToolUse", bashTool);
      expect(context.activity.get(sessionId)?.activity).toBe(
        "needs_permission",
      );
      expect(await readActivityRecord(home, sessionId)).toEqual(prior);
    });
  });

  test("the undo never puts an old record over a concurrent hook's newer one", async () => {
    await withSession(async ({ context, sessionId, home, ingest }) => {
      await ingest("Notification", permissionPrompt);
      const prior = {
        sessionId,
        activity: "idle" as const,
        detail: null,
        since: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        source: "hook" as const,
      };
      await writeActivityRecord(home, prior);
      // Another hook writes its own record while this one is still opening
      // the database.
      const concurrent = {
        ...prior,
        activity: "needs_input" as const,
        detail: "Which branch?",
        observedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      await ingestHook({
        home,
        sessionId,
        event: "PreToolUse",
        readPayload: async () =>
          JSON.stringify({ hook_event_name: "PreToolUse", ...bashTool }),
        openContext: async () => {
          await writeActivityRecord(home, concurrent);
          return { ...context, close: () => undefined };
        },
      });
      expect(await readActivityRecord(home, sessionId)).toEqual(concurrent);
    });
  });

  test("a failed open is retried by the next step instead of skipping the rest", async () => {
    await withSession(async ({ context, sessionId, home }) => {
      let attempts = 0;
      await ingestHook({
        home,
        sessionId,
        event: "Stop",
        readPayload: async () =>
          JSON.stringify({
            hook_event_name: "Stop",
            last_assistant_message: "All done.",
          }),
        openContext: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("SQLITE_BUSY");
          return { ...context, close: () => undefined };
        },
      });
      // The routines check failed; the reading and the flush share the retry.
      expect(attempts).toBe(2);
      expect(context.activity.get(sessionId)?.activity).toBe("done");
    });
  });

  test("writes the record when the control plane cannot be opened", async () => {
    await withSession(async ({ sessionId, home }) => {
      await ingestHook({
        home,
        sessionId,
        event: "UserPromptSubmit",
        readPayload: async () =>
          JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
        openContext: () => Promise.reject(new Error("database is locked")),
      });
      expect((await readActivityRecord(home, sessionId))?.activity).toBe(
        "working",
      );
    });
  });

  test("a Stop opens one context for the routines check, the reading and the team flush", async () => {
    await withSession(
      async ({ context, sessionId, ingest, opened, closed }) => {
        await ingest("UserPromptSubmit", {});
        await ingest("Stop", { last_assistant_message: "All done." });
        expect(opened()).toBe(2);
        expect(closed()).toBe(2);
        expect(context.activity.get(sessionId)?.activity).toBe("done");
      },
    );
  });

  test("a heartbeat with a fresh record never opens the database", async () => {
    await withSession(async ({ ingest, opened }) => {
      await ingest("UserPromptSubmit", {});
      const before = opened();
      await ingest("PreToolUse", { ...bashTool, agent_id: "subagent" });
      expect(opened()).toBe(before);
    });
  });

  test("ignores bad input without throwing or opening anything", async () => {
    await withSession(async ({ sessionId, home, ingest, opened }) => {
      await ingest("Stop", "");
      await ingest("Stop", "{not json");
      await ingest("Stop", "x".repeat(1024 * 1024 + 1));
      await ingestHook({
        home,
        sessionId: "not-a-session",
        event: "Stop",
        readPayload: () => {
          throw new Error("must not read stdin");
        },
        openContext: () => {
          throw new Error("must not open");
        },
      });
      expect(opened()).toBe(0);
      // Spawning may have left its own pane reading; no hook wrote one.
      expect((await readActivityRecord(home, sessionId))?.source).not.toBe(
        "hook",
      );
    });
  });
});

describe("ingestStatusLine", () => {
  test("writes the telemetry reading and never throws on bad input", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const sessionId = crypto.randomUUID();
      await ingestStatusLine({
        home,
        sessionId,
        readPayload: async () => "{not json",
      });
      await ingestStatusLine({
        home,
        sessionId,
        readPayload: async () =>
          JSON.stringify({
            model: { id: "claude-opus-5-5" },
            cost: { total_cost_usd: 1.5 },
          }),
      });
      const written = await Bun.file(
        join(home, "telemetry", `${sessionId}.json`),
      ).json();
      expect(written).toMatchObject({
        model: { id: "claude-opus-5-5" },
        cost: { total_cost_usd: 1.5 },
      });
    });
  });
});

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  ACTIVITY_STALE_AFTER_MS,
  createApplicationContext,
  observeClaudeHook,
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
}

/**
 * The clock is injected rather than waited on: staleness decay is a
 * ten-minute rule, and a test that actually waited for it would never run.
 */
async function withSession(
  run: (input: {
    context: ApplicationContext;
    sessionId: string;
    home: string;
    tmux: FakeTmux;
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
    const tmux = new FakeTmux();
    const context = await createApplicationContext({
      env: { DAEDALUS_HOME: home },
      tmux,
      now: () => new Date(Date.now() + offset),
      sendNativeNotification: async () => ({
        delivered: true,
        backend: "terminal-notifier" as const,
        degraded: false,
      }),
    });
    try {
      const workspace = await context.workspaces.create({ name: "Guards" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
        name: "Claude",
      });
      await run({
        context,
        sessionId: session.id,
        home,
        tmux,
        advance: (ms) => {
          offset += ms;
        },
      });
    } finally {
      context.close();
    }
  });
}

describe("guarded transitions", () => {
  test("routine work cannot stomp a permission wait, but the tool running can", async () => {
    await withSession(async ({ context, sessionId }) => {
      const observe = (event: string, payload: Record<string, unknown> = {}) =>
        context.activity.observe({
          sessionId,
          observation: observeClaudeHook(event, {
            hook_event_name: event,
            ...payload,
          })!,
        });

      await observe("Notification", {
        notification_type: "permission_prompt",
        message: "Claude needs your permission to use Bash",
      });
      expect(context.activity.get(sessionId)?.activity).toBe(
        "needs_permission",
      );

      // A late PreToolUse from the same turn must not report the session busy
      // while the user is still being waited on.
      const late = await observe("PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "git push" },
      });
      expect(late?.applied).toBe(false);
      expect(context.activity.get(sessionId)?.activity).toBe(
        "needs_permission",
      );

      // The tool actually running proves the block was answered.
      const after = await observe("PostToolUse", {
        tool_name: "Bash",
        tool_input: { command: "git push" },
      });
      expect(after?.applied).toBe(true);
      expect(context.activity.get(sessionId)?.activity).toBe("working");
      expect(context.activity.attentionFor(sessionId)).toBeUndefined();
    });
  });

  test("a Stop only finishes a turn that was actually running", async () => {
    await withSession(async ({ context, sessionId }) => {
      await context.activity.record({
        sessionId,
        activity: "needs_input",
        detail: "Which branch?",
        source: "hook",
      });
      const stop = await context.activity.observe({
        sessionId,
        observation: observeClaudeHook("Stop", { hook_event_name: "Stop" })!,
      });
      expect(stop?.applied).toBe(false);
      expect(context.activity.get(sessionId)?.activity).toBe("needs_input");

      // A new prompt is the escape hatch: the user is demonstrably back.
      await context.activity.observe({
        sessionId,
        observation: observeClaudeHook("UserPromptSubmit", {
          hook_event_name: "UserPromptSubmit",
        })!,
      });
      expect(context.activity.get(sessionId)?.activity).toBe("working");
      expect(context.activity.attentionFor(sessionId)).toBeUndefined();
    });
  });

  test("since measures the block, not the polling interval", async () => {
    await withSession(async ({ context, sessionId, advance }) => {
      const first = await context.activity.record({
        sessionId,
        activity: "working",
        source: "hook",
      });
      advance(30_000);
      const second = await context.activity.record({
        sessionId,
        activity: "working",
        detail: "Bash(ls)",
        source: "hook",
      });
      expect(second.state.since).toBe(first.state.since);
      expect(second.state.observedAt).not.toBe(first.state.observedAt);
    });
  });
});

describe("source confidence", () => {
  test("a pane guess never overwrites a fresh hook fact", async () => {
    await withSession(async ({ context, sessionId, advance }) => {
      await context.activity.record({
        sessionId,
        activity: "needs_permission",
        detail: "Bash(git push)",
        source: "hook",
      });
      const guess = await context.activity.record({
        sessionId,
        activity: "working",
        source: "pane",
      });
      expect(guess.applied).toBe(false);
      expect(context.activity.get(sessionId)?.source).toBe("hook");

      // Once the hook reading is stale nobody is claiming it is true any more.
      advance(ACTIVITY_STALE_AFTER_MS + 1_000);
      const later = await context.activity.record({
        sessionId,
        activity: "working",
        source: "pane",
      });
      expect(later.applied).toBe(true);
    });
  });

  test("a rollout reading yields to a hook but outranks a pane reading", async () => {
    await withSession(async ({ context, sessionId }) => {
      await context.activity.record({
        sessionId,
        activity: "working",
        source: "hook",
      });
      expect(
        (
          await context.activity.record({
            sessionId,
            activity: "idle",
            source: "transcript",
          })
        ).applied,
      ).toBe(false);
    });
  });
});

describe("staleness decay", () => {
  test("working decays to unknown, and waiting states never do", async () => {
    await withSession(async ({ context, sessionId, advance }) => {
      await context.activity.record({
        sessionId,
        activity: "working",
        detail: "Bash(sleep 600)",
        source: "hook",
      });
      advance(ACTIVITY_STALE_AFTER_MS - 1_000);
      expect(await context.activity.decay()).toHaveLength(0);

      advance(2_000);
      const decayed = await context.activity.decay();
      expect(decayed).toHaveLength(1);
      expect(context.activity.get(sessionId)).toMatchObject({
        activity: "unknown",
        detail: null,
      });
    });
  });

  test("waiting on a human for an hour is a real state, not a stale one", async () => {
    await withSession(async ({ context, sessionId, advance }) => {
      for (const activity of [
        "needs_permission",
        "needs_input",
        "idle",
      ] as const) {
        await context.activity.record({ sessionId, activity, source: "hook" });
        advance(ACTIVITY_STALE_AFTER_MS * 6);
        expect(await context.activity.decay()).toHaveLength(0);
        expect(context.activity.get(sessionId)?.activity).toBe(activity);
      }
    });
  });
});

describe("the durable record", () => {
  test("every applied observation is mirrored to disk", async () => {
    await withSession(async ({ context, sessionId, home }) => {
      await context.activity.record({
        sessionId,
        activity: "needs_permission",
        detail: "Bash(git push)",
        source: "hook",
      });
      expect(await readActivityRecord(home, sessionId)).toMatchObject({
        activity: "needs_permission",
        detail: "Bash(git push)",
        source: "hook",
      });
    });
  });

  test("restart rebuilds a mid-turn session from the record, not from defaults", async () => {
    await withSession(async ({ context, sessionId, home }) => {
      const now = new Date().toISOString();
      // Stand in for a hook that wrote its record while the app was down.
      await writeActivityRecord(home, {
        sessionId,
        activity: "working",
        detail: "Edit(agents.ts)",
        since: now,
        observedAt: now,
        source: "hook",
      });
      context.repositories.deleteAgentActivity(sessionId);
      expect(await context.activity.restore()).toBe(1);
      expect(context.activity.get(sessionId)).toMatchObject({
        activity: "working",
        detail: "Edit(agents.ts)",
      });
    });
  });

  test("lifecycle dominates: a record for a session that is over is discarded", async () => {
    await withSession(async ({ context, sessionId, home }) => {
      await context.activity.record({
        sessionId,
        activity: "working",
        source: "hook",
      });
      // Written straight to the row rather than through `stop`, which clears
      // the reading itself: what is under test is the replay's own guard.
      const session = context.repositories.findAgent(sessionId)!;
      context.repositories.updateAgent({
        ...session,
        status: "exited",
        endedAt: new Date().toISOString(),
      });
      expect(await context.activity.restore()).toBe(0);
      expect(await readActivityRecord(home, sessionId)).toBeUndefined();
    });
  });

  test("a lost session keeps its reading, because it is coming back", async () => {
    await withSession(async ({ context, sessionId, home, tmux }) => {
      await context.activity.record({
        sessionId,
        activity: "needs_permission",
        detail: "Bash(git push)",
        source: "hook",
      });
      // A Mac reboot: the tmux server dies under every open conversation at
      // once. The agent is still blocked on the same question, and the revive
      // sweep puts it back at exactly that point, so neither the reading nor
      // the badge it raised may be thrown away on the way past.
      tmux.sessions.clear();
      await context.agents.reconcile();
      expect(context.activity.get(sessionId)).toMatchObject({
        activity: "needs_permission",
        detail: "Bash(git push)",
      });
      expect(context.activity.attentionFor(sessionId)?.reasons).toHaveLength(1);
      await context.activity.restore();
      expect(await readActivityRecord(home, sessionId)).toMatchObject({
        activity: "needs_permission",
      });
    });
  });

  test("a record older than the index is not replayed over it", async () => {
    await withSession(async ({ context, sessionId, home }) => {
      const stale = new Date(Date.now() - 60_000).toISOString();
      await writeActivityRecord(home, {
        sessionId,
        activity: "working",
        detail: "old",
        since: stale,
        observedAt: stale,
        source: "hook",
      });
      await context.activity.record({
        sessionId,
        activity: "idle",
        source: "hook",
      });
      expect(await context.activity.restore()).toBe(0);
      expect(context.activity.get(sessionId)?.activity).toBe("idle");
    });
  });

  test("an oversized or malformed record is ignored rather than trusted", async () => {
    await withSession(async ({ home, sessionId }) => {
      await Bun.write(
        join(home, "activity", `${sessionId}.json`),
        JSON.stringify({ sessionId, activity: "definitely-not-an-activity" }),
      );
      expect(await readActivityRecord(home, sessionId)).toBeUndefined();
    });
  });
});

describe("restore rebuilds what the user has to act on", () => {
  test("a session restored mid-block comes back with its badge", async () => {
    await withSession(async ({ context, sessionId, home }) => {
      const at = new Date().toISOString();
      // Stands in for a hook that wrote its record while the index was
      // unreachable — the case that made this a bug rather than a nicety.
      await writeActivityRecord(home, {
        sessionId,
        activity: "needs_permission",
        detail: "Bash(git push)",
        since: at,
        observedAt: at,
        source: "hook",
      });
      expect(await context.activity.restore()).toBe(1);
      expect(context.activity.get(sessionId)).toMatchObject({
        activity: "needs_permission",
        // The badge's age survives the restart, so "waiting 4m" keeps counting
        // from the block rather than from the restart.
        since: at,
      });
      const reasons = context.activity.attentionFor(sessionId)?.reasons ?? [];
      expect(reasons).toHaveLength(1);
      expect(reasons[0]?.text).toContain("Bash(git push)");
    });
  });

  test("restoring twice does not stack a second reason on the same badge", async () => {
    await withSession(async ({ context, sessionId, home }) => {
      const at = new Date().toISOString();
      await writeActivityRecord(home, {
        sessionId,
        activity: "needs_input",
        detail: "Which branch?",
        since: at,
        observedAt: at,
        source: "hook",
      });
      await context.activity.restore();
      context.repositories.deleteAgentActivity(sessionId);
      await context.activity.restore();
      expect(context.activity.attentionFor(sessionId)?.reasons).toHaveLength(1);
    });
  });
});

describe("one block is one reason", () => {
  /** Replays a hook the way the sink does, through the real mapping. */
  const fireHook =
    (context: ApplicationContext, sessionId: string) =>
    async (event: string, extra: Record<string, unknown> = {}) => {
      const observation = observeClaudeHook(event, {
        hook_event_name: event,
        ...extra,
      });
      if (observation)
        await context.activity.observe({ sessionId, observation });
    };

  test("several hooks describing one wait do not stack up a count", async () => {
    await withSession(async ({ context, sessionId }) => {
      const fire = fireHook(context, sessionId);
      const input = {
        questions: [{ question: "What should we work on in this session?" }],
      };
      await fire("UserPromptSubmit");
      await fire("PreToolUse", {
        tool_name: "AskUserQuestion",
        tool_input: input,
      });
      await fire("PermissionRequest", {
        tool_name: "AskUserQuestion",
        tool_input: input,
      });
      // The dialog going up, reported a second time and less specifically.
      await fire("Notification", {
        notification_type: "permission_prompt",
        message: "Claude needs your permission to use AskUserQuestion",
      });

      // A question, not a permission: the vaguer hook arriving last must not
      // downgrade what the specific one already established.
      expect(context.activity.get(sessionId)?.activity).toBe("needs_input");
      const reasons = context.activity.attentionFor(sessionId)?.reasons ?? [];
      expect(reasons).toHaveLength(1);
      expect(reasons[0]?.text).toBe(
        "Claude is asking a question: What should we work on in this session?",
      );
    });
  });

  test("what the agent says itself still accumulates", async () => {
    await withSession(async ({ context, sessionId }) => {
      await context.activity.raise({ sessionId, reason: "Which branch?" });
      await context.activity.raise({ sessionId, reason: "And which remote?" });
      expect(context.activity.attentionFor(sessionId)?.reasons).toHaveLength(2);
    });
  });

  test("an inferred reason replaces an inferred one but spares the agent's", async () => {
    await withSession(async ({ context, sessionId }) => {
      await context.activity.raise({ sessionId, reason: "Which branch?" });
      await context.activity.record({
        sessionId,
        activity: "needs_permission",
        detail: "Bash(git push)",
        source: "hook",
      });
      await context.activity.record({
        sessionId,
        activity: "needs_input",
        detail: "Which remote?",
        source: "hook",
      });
      const reasons = context.activity.attentionFor(sessionId)?.reasons ?? [];
      // The agent's own words, plus exactly one inferred line.
      expect(reasons.map((reason) => reason.text)).toEqual([
        "Which branch?",
        "Claude is asking a question: Which remote?",
      ]);
    });
  });

  test("the badge does not say the provider's name twice", async () => {
    await withSession(async ({ context, sessionId }) => {
      await context.activity.record({
        sessionId,
        activity: "needs_permission",
        // Some provider details are already a whole sentence about themselves.
        detail: "Claude needs your permission to use Bash",
        source: "hook",
      });
      expect(context.activity.attentionFor(sessionId)?.reasons[0]?.text).toBe(
        "Claude needs your permission to use Bash",
      );
    });
  });
});

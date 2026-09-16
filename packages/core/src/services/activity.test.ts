import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import type { NativeNotification } from "@daedalus/platform";
import {
  accumulateReasons,
  createApplicationContext,
  MAX_ATTENTION_REASONS,
  routeNotification,
  type ApplicationContext,
  type AttentionReason,
  type PresenceState,
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
    return "Claude Code v2.1.251\nshift+tab to cycle";
  }
  async sendKeys() {}
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
}

/**
 * The notifier is always injected: a test suite that reached the real
 * Notification Center would spray alerts across the machine running it.
 */
async function withContext(
  run: (
    context: ApplicationContext,
    desktop: NativeNotification[],
  ) => Promise<void>,
): Promise<void> {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: { claude: { executable: process.execPath, args: [] } },
      }),
    );
    const desktop: NativeNotification[] = [];
    const context = await createApplicationContext({
      env: { DAEDALUS_HOME: home },
      tmux: new FakeTmux(),
      sendNativeNotification: async (notification) => {
        desktop.push(notification);
        return {
          delivered: true,
          backend: "terminal-notifier",
          degraded: false,
        };
      },
    });
    try {
      await run(context, desktop);
    } finally {
      context.close();
    }
  });
}

async function withSession(
  run: (
    context: ApplicationContext,
    sessionId: string,
    desktop: NativeNotification[],
  ) => Promise<void>,
): Promise<void> {
  await withContext(async (context, desktop) => {
    const workspace = await context.workspaces.create({ name: "Attention" });
    const session = await context.agents.spawn({
      workspace: workspace.id,
      provider: "claude",
      name: "Claude",
    });
    await run(context, session.id, desktop);
  });
}

const reason = (text: string): AttentionReason => ({
  id: crypto.randomUUID(),
  text,
  raisedAt: new Date().toISOString(),
  source: "agent",
});

const presence = (overrides: Partial<PresenceState> = {}): PresenceState => ({
  appRunning: true,
  appForeground: true,
  workspaceId: "workspace",
  sessionId: "session",
  userIdleSeconds: 0,
  observedAt: new Date().toISOString(),
  ...overrides,
});

describe("attention reason accumulation", () => {
  test("keeps the newest five and evicts the oldest, never the newest", () => {
    const reasons = ["a", "b", "c", "d", "e", "f"].reduce<AttentionReason[]>(
      (current, text) => accumulateReasons(current, reason(text)),
      [],
    );
    expect(reasons).toHaveLength(MAX_ATTENTION_REASONS);
    expect(reasons.map((item) => item.text)).toEqual(["b", "c", "d", "e", "f"]);
  });

  test("collapses an identical reason instead of piling it up", () => {
    const first = accumulateReasons(
      [],
      reason("Need a decision on the schema"),
    );
    const second = accumulateReasons(
      first,
      reason("Need a decision on the schema"),
    );
    expect(second).toHaveLength(1);
  });
});

describe("notification routing", () => {
  test("says nothing about the session already on screen", () => {
    expect(
      routeNotification(presence(), { sessionId: "session" } as never, false),
    ).toEqual({ channel: null, suppressed: "on_screen" });
  });

  test("uses a toast when the app is open on something else", () => {
    expect(
      routeNotification(
        presence({ sessionId: "other" }),
        { sessionId: "session" } as never,
        false,
      ),
    ).toEqual({ channel: "toast", suppressed: null });
  });

  test("uses the desktop when the app is backgrounded or the user is idle", () => {
    expect(
      routeNotification(
        presence({ appForeground: false }),
        { sessionId: "session" } as never,
        false,
      ).channel,
    ).toBe("desktop");
    // A toast goes unseen once someone has walked away, so idleness routes the
    // same way a backgrounded window does.
    expect(
      routeNotification(
        presence({ userIdleSeconds: 600 }),
        { sessionId: "session" } as never,
        false,
      ).channel,
    ).toBe("desktop");
    expect(
      routeNotification(
        presence({ appRunning: false, appForeground: false }),
        {} as never,
        false,
      ).channel,
    ).toBe("desktop");
  });

  test("reports focus mode as suppression rather than dropping it silently", () => {
    expect(
      routeNotification(
        presence({ sessionId: "other" }),
        { sessionId: "session" } as never,
        true,
      ),
    ).toEqual({ channel: null, suppressed: "focus_mode" });
  });
});

describe("ActivityService", () => {
  test("six raises leave the newest five on one badge, not six alerts", async () => {
    await withSession(async (context, sessionId, desktop) => {
      for (const index of [1, 2, 3, 4, 5, 6])
        await context.activity.raise({
          sessionId,
          reason: `Decision ${index}`,
        });
      const attention = context.activity.attentionFor(sessionId);
      expect(attention?.reasons.map((item) => item.text)).toEqual([
        "Decision 2",
        "Decision 3",
        "Decision 4",
        "Decision 5",
        "Decision 6",
      ]);
      // One badge, and one alert: only the first raise was a transition into
      // an attention state.
      expect(desktop).toHaveLength(1);
    });
  });

  test("a repeated raise keeps the badge's own age so elapsed time is honest", async () => {
    await withSession(async (context, sessionId) => {
      await context.activity.raise({ sessionId, reason: "First" });
      const first = context.activity.attentionFor(sessionId);
      await Bun.sleep(5);
      await context.activity.raise({ sessionId, reason: "Second" });
      const second = context.activity.attentionFor(sessionId);
      expect(second?.raisedAt).toBe(first?.raisedAt);
      expect(second?.updatedAt).not.toBe(first?.updatedAt);
    });
  });

  test("clears on the transition out even though the user never came", async () => {
    await withSession(async (context, sessionId) => {
      await context.activity.record({
        sessionId,
        activity: "needs_permission",
        detail: "Bash(git push)",
        source: "hook",
      });
      expect(context.activity.attentionFor(sessionId)).toBeDefined();
      await context.activity.record({
        sessionId,
        activity: "working",
        source: "hook",
      });
      expect(context.activity.attentionFor(sessionId)).toBeUndefined();
    });
  });

  test("a pane guess may raise a badge but never retracts one", async () => {
    await withSession(async (context, sessionId) => {
      await context.activity.record({
        sessionId,
        activity: "needs_input",
        source: "pane",
      });
      await context.activity.record({
        sessionId,
        activity: "working",
        source: "pane",
      });
      expect(context.activity.attentionFor(sessionId)).toBeDefined();
    });
  });

  test("clearing goes through while focus mode is on and purges the queue", async () => {
    await withSession(async (context, sessionId) => {
      await context.presence.setFocusMode(true);
      await context.activity.raise({ sessionId, reason: "Schema decision" });
      await context.activity.raise({ sessionId, reason: "Second question" });
      expect(context.activity.attentionFor(sessionId)?.reasons).toHaveLength(2);
      // All-or-nothing: there is no per-reason resolution.
      expect(context.activity.clear(sessionId)).toEqual({ cleared: 2 });
      expect(context.activity.attentionFor(sessionId)).toBeUndefined();
      // Without the purge the badge resurrects when the queue flushes.
      expect(
        context.notifications
          .pending()
          .filter((item) => item.sessionId === sessionId),
      ).toHaveLength(0);
    });
  });

  test("hands a desktop alert to the running app instead of shouting as Script Editor", async () => {
    await withSession(async (context, sessionId, desktop) => {
      // The app is up but showing something else: a CLI has no bundle of its
      // own, so the alert is parked for the app to deliver under its own name.
      await context.presence.publish({
        appForeground: false,
        workspaceId: null,
        sessionId: null,
      });
      const outcome = await context.activity.raise({
        sessionId,
        reason: "Need a decision on the schema",
      });
      expect(outcome.notification?.delivered).toEqual(["badge", "desktop"]);
      expect(outcome.notification?.queued).toBe(true);
      expect(outcome.notification?.reason).toBe("handed to the running app");
      expect(desktop).toHaveLength(0);
      // The app picks it up on its next tick.
      expect(await context.notifications.flushDesktop(5, 60_000)).toBe(1);
      expect(desktop).toHaveLength(1);
      expect(desktop[0]?.body).toBe("Need a decision on the schema");
    });
  });

  test("drops a handed-over alert that went stale while the app was down", async () => {
    await withSession(async (context, sessionId, desktop) => {
      await context.presence.publish({
        appForeground: false,
        workspaceId: null,
        sessionId: null,
      });
      await context.activity.raise({ sessionId, reason: "Blocked" });
      // An alert nobody could deliver for an hour is already late; the badge
      // it left behind is the durable signal, not a week-old ping.
      expect(
        await context.notifications.flushDesktop(
          5,
          60_000,
          Date.now() + 3_600_000,
        ),
      ).toBe(0);
      expect(desktop).toHaveLength(0);
    });
  });

  test("a cleared badge does not come back when the queue flushes", async () => {
    await withSession(async (context, sessionId, desktop) => {
      // No app, and no notifier: the alert parks in the queue, which is the
      // situation where a naive flush resurrects a badge the agent retracted.
      await context.activity.record({
        sessionId,
        activity: "needs_permission",
        detail: "Bash(git push)",
        source: "hook",
      });
      expect(desktop).toHaveLength(1);
      context.activity.clear(sessionId);
      desktop.length = 0;
      expect(await context.notifications.flushDesktop()).toBe(0);
      expect(desktop).toHaveLength(0);
      expect(context.activity.attentionFor(sessionId)).toBeUndefined();
    });
  });

  test("focus mode suppresses the alert but still leaves the badge", async () => {
    await withSession(async (context, sessionId) => {
      await context.presence.setFocusMode(true);
      const outcome = await context.activity.raise({
        sessionId,
        reason: "Need a decision",
      });
      expect(outcome.attention?.reasons).toHaveLength(1);
      expect(outcome.notification?.suppressed).toBe("focus_mode");
      expect(outcome.notification?.reason).toBe("focus mode is on");
      expect(outcome.notification?.delivered).toEqual(["badge"]);
    });
  });

  test("a bouncing turn produces one alert, not one per step", async () => {
    await withSession(async (context, sessionId, desktop) => {
      for (const index of [0, 1, 2]) {
        await context.activity.record({
          sessionId,
          activity: "needs_permission",
          detail: `Bash(step ${index})`,
          source: "hook",
        });
        await context.activity.record({
          sessionId,
          activity: "working",
          source: "hook",
        });
      }
      expect(desktop).toHaveLength(1);
    });
  });

  test("only moves `since` when the activity itself changes", async () => {
    await withSession(async (context, sessionId) => {
      const first = await context.activity.record({
        sessionId,
        activity: "working",
        detail: "Editing agents.ts",
        source: "hook",
      });
      await Bun.sleep(5);
      const second = await context.activity.record({
        sessionId,
        activity: "working",
        detail: "Editing activity.ts",
        source: "hook",
      });
      expect(second.state.since).toBe(first.state.since);
      expect(second.state.observedAt).not.toBe(first.state.observedAt);
      expect(second.transitioned).toBe(false);
      expect(second.state.detail).toBe("Editing activity.ts");
    });
  });

  test("forgets everything about a session that stops being live", async () => {
    await withSession(async (context, sessionId) => {
      await context.activity.raise({ sessionId, reason: "Blocked" });
      await context.agents.stop(sessionId);
      expect(context.activity.attentionFor(sessionId)).toBeUndefined();
      expect(context.activity.get(sessionId)).toBeUndefined();
    });
  });

  test("titles an alert with the workspace, the session, and the task", async () => {
    await withContext(async (context, desktop) => {
      const workspace = await context.workspaces.create({ name: "Daedalus" });
      const task = await context.tasks.create({
        workspace: workspace.id,
        title: "Agent status in the app",
      });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
        name: "Claude",
        taskId: task.id,
      });
      await context.activity.record({
        sessionId: session.id,
        activity: "needs_permission",
        detail: "Bash(git push)",
        source: "hook",
      });
      const alert = desktop[0];
      expect(alert?.title).toBe(`Daedalus · Claude · #${task.number}`);
      expect(alert?.subtitle).toBe("Agent status in the app");
      expect(alert?.body).toBe("Claude needs permission: Bash(git push)");
    });
  });
});

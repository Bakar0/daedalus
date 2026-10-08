import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { DeliveryGate } from "./delivery";
import {
  activityAtPrompt,
  appendToBrief,
  claudeReady,
  composerText,
  createApplicationContext,
  inputBoxText,
  QUIET_AFTER_TYPING_MS,
  type AgentActivityState,
  type AgentSession,
  type ApplicationContext,
  type RoutineTickInput,
  type SessionAbility,
} from "../index";

/** Claude at its prompt with an empty input box. */
const CLAUDE_IDLE_SCREEN = [
  "⏺ Ready.",
  "────────────────────────────────",
  "❯ ",
  "────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

/**
 * An empty box as Claude draws it after a turn, from a real styled capture:
 * its suggested next prompt sits in the box, dim. It is not text.
 */
const CLAUDE_SUGGESTION_SCREEN = [
  "⏺ I added testroutine.",
  "\u001b[38;5;244m────────────────────────────────",
  "\u001b[39m❯\u00a0\u001b[2mshow me the runs so far\u001b[0m",
  "\u001b[38;5;244m────────────────────────────────",
  "\u001b[39m  \u001b[38;5;220m⏵⏵ auto mode on\u001b[39m",
].join("\n");

const claudeScreen = (draft: string) =>
  CLAUDE_IDLE_SCREEN.replace("❯ ", `❯ ${draft}`);

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  readonly launches: TmuxLaunch[] = [];
  readonly sent: Array<{ session: string; text: string }> = [];
  readonly keys: Array<{ session: string; keys: string[] }> = [];
  screen = CLAUDE_IDLE_SCREEN;
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
    this.launches.push(launch);
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
  // Like tmux: the escape codes come back only when asked for.
  async capture(_session: string, options: { styled?: boolean } = {}) {
    return options.styled
      ? this.screen
      : this.screen.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, "");
  }
  async sendKeys(session: string, keys: string[]) {
    this.keys.push({ session, keys });
  }
  async send(session: string, text: string) {
    this.sent.push({ session, text });
  }
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    this.sessions.clear();
    return true;
  }
}

/** Stands in for the inbox waiter of Claude sessions launched with one. */
interface FakeInbox {
  /** False: the session is not waiting at its prompt, nothing reads. */
  open: boolean;
  lines: Array<{ sessionId: string; line: string }>;
}

interface Harness {
  context: ApplicationContext;
  tmux: FakeTmux;
  inbox: FakeInbox;
  home: string;
  clock: { now: Date };
  advance(ms: number): void;
  /** A second context on the same database: another CLI process. */
  second(): Promise<ApplicationContext>;
}

async function withAbilities(run: (harness: Harness) => Promise<void>) {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: {
          claude: { executable: process.execPath, args: ["run"] },
          codex: { executable: process.execPath, args: ["run"] },
        },
      }),
    );
    const env = {
      DAEDALUS_HOME: home,
      CODEX_HOME: join(home, "codex"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      DAEDALUS_AGENTS_HOME: join(home, "agents"),
      DAEDALUS_CURSOR_HOME: join(home, "cursor"),
    };
    const clock = { now: new Date(2026, 8, 30, 10, 0, 0) };
    const tmux = new FakeTmux();
    const inbox: FakeInbox = { open: true, lines: [] };
    const sessionInbox = async (session: AgentSession, line: string) => {
      if (!inbox.open) return false;
      inbox.lines.push({ sessionId: session.id, line });
      return true;
    };
    const extra: ApplicationContext[] = [];
    const notify = async () => ({
      delivered: true,
      backend: "app" as const,
      degraded: false,
    });
    const context = await createApplicationContext({
      env,
      tmux,
      now: () => clock.now,
      sendNativeNotification: notify,
      sessionInbox,
    });
    try {
      await context.skills.sync();
      await run({
        context,
        tmux,
        inbox,
        home,
        clock,
        advance: (ms) => {
          clock.now = new Date(clock.now.getTime() + ms);
        },
        second: async () => {
          const other = await createApplicationContext({
            env,
            tmux,
            now: () => clock.now,
            reconcile: false,
            sendNativeNotification: notify,
            sessionInbox,
          });
          extra.push(other);
          return other;
        },
      });
    } finally {
      for (const other of extra) other.close();
      context.close();
    }
  });
}

const routineText = (name: string, extra = "", schedule = "every 10m") =>
  `---
name: ${name}
schedule: ${schedule}
model: sonnet
timeout: 10m
output: task
${extra}---
Check ${name} since {{last_run}}; missed {{missed}}.
`;

const reading = (
  harness: Harness,
  activity: AgentActivityState["activity"],
  detail: string | null = null,
) =>
  ((sessionId: string): AgentActivityState => ({
    sessionId,
    activity,
    detail,
    since: harness.clock.now.toISOString(),
    observedAt: harness.clock.now.toISOString(),
    source: "hook",
  })) satisfies RoutineTickInput["activity"];

/** A tick input for a session sitting idle at its prompt. */
function idle(
  harness: Harness,
  overrides: Partial<RoutineTickInput> = {},
): RoutineTickInput {
  return {
    contextPercent: () => 10,
    activity: reading(harness, "idle"),
    ...overrides,
  };
}

/** Ticks once, then moves the clock past the gap between two lines. */
async function tick(harness: Harness, input = idle(harness)) {
  const result = await harness.context.routineDelivery.tick(input);
  harness.advance(16_000);
  return result;
}

/** A Claude session called Argus in workspace `ops`, holding routines. */
async function argus(
  harness: Harness,
): Promise<{ session: AgentSession; ability: SessionAbility }> {
  if (!harness.context.repositories.findWorkspace("ops"))
    await harness.context.workspaces.create({ name: "Ops", slug: "ops" });
  const session = await harness.context.agents.spawn({
    workspace: "ops",
    provider: "claude",
    name: "Argus",
    abilities: ["routines"],
  });
  return {
    session,
    ability: harness.context.abilities.require(session.id, "routines"),
  };
}

/** Runs that went in: typed as the run skill, or posted to the inbox. */
const routineLines = ({ tmux, inbox }: Harness) => [
  ...tmux.sent
    .map((item) => item.text)
    .filter((text) => /^[/$]daedalus-routine(-\w+)? \d+$/.test(text)),
  ...inbox.lines.map((item) => item.line),
];

/**
 * A Claude session launched before sessions had an inbox: runs are typed
 * into it, under the typing rules.
 */
function withoutInbox(harness: Harness, session: AgentSession): AgentSession {
  const older = {
    ...session,
    args: session.args.filter(
      (argument) => !argument.includes("daedalus-inbox"),
    ),
  };
  harness.context.repositories.updateAgent(older);
  return older;
}

describe("abilities", () => {
  test("a session spawned with an ability holds it and is told at launch", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const session = await context.agents.spawn({
        workspace: "ops",
        provider: "claude",
        name: "Argus",
        abilities: ["routines"],
        color: "teal",
        pinned: true,
      });
      expect(session).toMatchObject({ name: "Argus", color: "teal" });
      expect(session.pinnedAt).not.toBeNull();
      expect(context.abilities.held(session.id, "routines")).toMatchObject({
        enabled: true,
        paused: false,
        pendingNote: null,
      });
      // Routines say nothing to the session: with no message there is no
      // first prompt for it to act on.
      expect(tmux.launches.at(-1)!.args.join(" ")).not.toContain("routine");
      // An ordinary session folder: nothing is written into it.
      expect(session.workingDirectory).not.toContain("agents");
      // A terminal or a custom command cannot hold one.
      await expect(
        context.agents.spawn({
          workspace: "ops",
          terminal: true,
          abilities: ["routines"],
        }),
      ).rejects.toThrow("needs a claude or codex session");
      await expect(
        context.agents.spawn({
          workspace: "ops",
          provider: "claude",
          abilities: ["oracle"],
        }),
      ).rejects.toThrow("Unknown ability 'oracle'");
      await expect(
        context.agents.spawn({
          workspace: "ops",
          provider: "claude",
          color: "mauve" as never,
        }),
      ).rejects.toThrow("Color must be one of");
    });
  });

  test("a grant to a running session is typed in under the delivery rule", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const session = await context.agents.spawn({
        workspace: "ops",
        provider: "claude",
        name: "Helper",
      });
      expect(context.abilities.list(session.id)).toEqual([]);
      // Routines are granted without a note.
      expect(
        context.abilities.grant(session.id, "routines", { live: true })
          .pendingNote,
      ).toBeNull();
      context.deliveryGate.noteKeystroke(session.id);
      const granted = context.abilities.grant(session.id, "orchestration", {
        live: true,
      });
      expect(granted.pendingNote).toContain(
        "now holds the orchestration ability",
      );
      // The user is typing: the note waits.
      await tick(harness);
      expect(tmux.sent).toEqual([]);
      harness.advance(QUIET_AFTER_TYPING_MS);
      await tick(harness);
      expect(tmux.sent.map((item) => item.text)).toEqual([granted.pendingNote]);
      expect(
        context.abilities.held(session.id, "orchestration")?.pendingNote,
      ).toBe(null);
      expect(() =>
        context.abilities.grant(session.id, "routines", { live: true }),
      ).toThrow("already holds");
    });
  });

  test("revoke stops delivery and keeps the routines for a later grant", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      const { session, ability } = await argus(harness);
      context.routines.add(ability, { text: routineText("ci-health") });
      await tick(
        harness,
        idle(harness, { activity: reading(harness, "working") }),
      );
      expect(context.routines.waitingRuns(ability)).toHaveLength(1);
      const revoked = context.abilities.revoke(session.id, "routines");
      expect(revoked).toMatchObject({ enabled: false });
      expect(revoked.pendingNote).toBeNull();
      expect(context.routines.waitingRuns(ability)).toEqual([]);
      expect(context.routines.runs(ability)[0]!.summary).toContain("revoked");
      expect(() => context.abilities.require(session.id, "routines")).toThrow(
        "does not hold the routines ability",
      );
      // Nothing is typed, and no run goes in.
      await tick(harness);
      expect(tmux.sent).toEqual([]);
      harness.advance(20 * 60_000);
      await tick(harness);
      expect(routineLines(harness)).toEqual([]);
      // Granted again: the same row and its routines.
      const back = context.abilities.grant(session.id, "routines", {
        live: true,
      });
      expect(back.id).toBe(ability.id);
      expect(
        context.routines.list(back).routines.map((view) => view.routine.name),
      ).toEqual(["ci-health"]);
    });
  });

  test("any session can be renamed, pinned and colored", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const session = await context.agents.spawn({
        workspace: "ops",
        provider: "claude",
      });
      expect(session).toMatchObject({ pinnedAt: null, color: null });
      await context.agents.rename(session.id, "  Watcher ");
      await context.agents.setPinned(session.id, true);
      await context.agents.setColor(session.id, "purple");
      const labelled = await context.agents.get(session.id);
      expect(labelled).toMatchObject({ name: "Watcher", color: "purple" });
      expect(labelled.pinnedAt).not.toBeNull();
      // A reconcile-style full save keeps the labels.
      context.repositories.updateAgent({ ...session, status: "running" });
      expect(await context.agents.get(session.id)).toMatchObject({
        name: "Watcher",
        color: "purple",
      });
      await context.agents.setColor(session.id, null);
      await context.agents.setPinned(session.id, false);
      expect(await context.agents.get(session.id)).toMatchObject({
        pinnedAt: null,
        color: null,
      });
      await expect(context.agents.rename(session.id, " ")).rejects.toThrow(
        "must not be empty",
      );
      await expect(
        context.agents.setColor(session.id, "mauve"),
      ).rejects.toThrow("Color must be one of");
    });
  });

  test("a handoff moves the abilities, name, pin and color to the successor", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      const { session, ability } = await argus(harness);
      await context.agents.setColor(session.id, "gold");
      await context.agents.setPinned(session.id, true);
      const { session: successor, predecessor } =
        await context.agents.continueSession({
          id: session.id,
          handoff: "Nothing in flight.",
        });
      expect(successor).toMatchObject({ name: "Argus", color: "gold" });
      expect(successor.pinnedAt).not.toBeNull();
      expect(successor.workingDirectory).toBe(session.workingDirectory);
      expect(context.abilities.held(successor.id, "routines")?.id).toBe(
        ability.id,
      );
      expect(
        context.abilities.held(predecessor.id, "routines"),
      ).toBeUndefined();
      expect(predecessor.archivedAt).not.toBeNull();
      // Archiving the predecessor did not pause what moved.
      expect(context.abilities.held(successor.id, "routines")?.paused).toBe(
        false,
      );
      expect(tmux.launches.at(-1)!.args.at(-1)).not.toContain(
        "routines ability",
      );
      // A session without abilities is numbered as before.
      const plain = await context.agents.spawn({
        workspace: "ops",
        provider: "claude",
        name: "Fixer",
      });
      const { session: next } = await context.agents.continueSession({
        id: plain.id,
      });
      expect(next.name).toBe("Fixer · 2");
    });
  });

  test("archiving pauses what a session holds, and restoring resumes it", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      const { session, ability } = await argus(harness);
      context.routines.add(ability, { text: routineText("ci-health") });
      await context.agents.archive(session.id, true);
      expect(context.abilities.held(session.id, "routines")?.paused).toBe(true);
      harness.advance(20 * 60_000);
      await tick(harness);
      expect(context.routines.runs(ability)).toEqual([]);
      await context.agents.restore(session.id);
      expect(context.abilities.held(session.id, "routines")?.paused).toBe(
        false,
      );
      await tick(harness);
      expect(routineLines(harness)).toHaveLength(1);
    });
  });
});

describe("routine delivery", () => {
  test("posts a due run to a Claude session's inbox once it waits at its prompt", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux, inbox } = harness;
      const { session, ability } = await argus(harness);
      expect(session.args.join(" ")).toContain("daedalus-inbox");
      context.routines.add(ability, { text: routineText("ci-health") });
      await tick(
        harness,
        idle(harness, { activity: reading(harness, "working", "Bash(ls)") }),
      );
      expect(routineLines(harness)).toEqual([]);
      // The user is typing and the box has a draft: neither holds a run
      // that is not typed in.
      context.deliveryGate.noteKeystroke(session.id);
      tmux.screen = claudeScreen("also watch the deploy");
      // No waiter reading: the session is not at its prompt after all.
      inbox.open = false;
      await tick(harness);
      expect(routineLines(harness)).toEqual([]);
      expect(context.routineDelivery.status(ability).hold).toMatchObject({
        reason: "busy",
        text: "the session is not waiting at its prompt",
      });
      inbox.open = true;
      await tick(harness);
      const [run] = context.routines.deliveredRuns(ability);
      expect(inbox.lines).toEqual([
        {
          sessionId: session.id,
          line: expect.stringMatching(
            new RegExp(
              `^Daedalus: routine run ${run!.id} is due\\. Carry it out now with the daedalus-routine(-\\w+)? skill, for run id ${run!.id}\\.$`,
            ),
          ),
        },
      ]);
      // Nothing was typed into the pane.
      expect(tmux.sent).toEqual([]);
    });
  });

  test("types a due run only when the session is idle and its box is empty", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      const { session: launched, ability } = await argus(harness);
      const session = withoutInbox(harness, launched);
      context.routines.add(ability, { text: routineText("ci-health") });
      // Working on something of its own: queued, not typed.
      await tick(
        harness,
        idle(harness, { activity: reading(harness, "working", "Bash(ls)") }),
      );
      expect(routineLines(harness)).toEqual([]);
      const [queued] = context.routines.waitingRuns(ability);
      expect(queued).toMatchObject({ routine: "ci-health", status: "queued" });
      expect(context.routineDelivery.status(ability).hold).toMatchObject({
        reason: "busy",
      });
      // A real question on screen is never typed over.
      await tick(
        harness,
        idle(harness, {
          activity: reading(harness, "needs_permission", "Bash(rm)"),
        }),
      );
      expect(routineLines(harness)).toEqual([]);
      expect(context.routineDelivery.status(ability).hold?.reason).toBe(
        "waiting-on-user",
      );
      // Text in the input box: nothing is typed after it.
      tmux.screen = claudeScreen("also watch the deploy");
      await tick(harness);
      expect(routineLines(harness)).toEqual([]);
      expect(context.routineDelivery.status(ability).hold?.reason).toBe(
        "input-text",
      );
      // Claude's dim prompt suggestion is an empty box, not text.
      tmux.screen = CLAUDE_SUGGESTION_SCREEN;
      await tick(harness);
      expect(routineLines(harness)).toHaveLength(1);
      expect(routineLines(harness)[0]).toMatch(
        new RegExp(`^/daedalus-routine(-\\w+)? ${queued!.id}$`),
      );
      expect(tmux.sent.at(-1)!.session).toBe(session.tmuxSession);
      const started = context.routines.start(ability, queued!.id);
      expect(started.prompt).toBe(
        "Check ci-health since never (this is the first run; look back one schedule interval); missed 0m.",
      );
      expect(started.run.status).toBe("running");
      expect(() => context.routines.start(ability, queued!.id)).toThrow(
        "not queued",
      );
    });
  });

  test("a keystroke holds delivery for two minutes, and Run now skips only that", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { session: launched, ability } = await argus(harness);
      const session = withoutInbox(harness, launched);
      context.routines.add(ability, { text: routineText("ci-health") });
      context.routines.add(ability, { text: routineText("merges") });
      context.deliveryGate.noteKeystroke(session.id);
      const typedAt = harness.clock.now.getTime();
      await tick(harness);
      expect(routineLines(harness)).toEqual([]);
      const status = context.routineDelivery.status(ability);
      expect(status.waiting.map((run) => run.routine).sort()).toEqual([
        "ci-health",
        "merges",
      ]);
      expect(status.hold).toMatchObject({ reason: "typing" });
      expect(Date.parse(status.hold!.until!)).toBe(
        typedAt + QUIET_AFTER_TYPING_MS,
      );
      expect(status.lastKeystrokeAt).toBe(new Date(typedAt).toISOString());
      // Run now: the oldest waiting run goes in at the next tick, the next
      // one waits for quiet again.
      const forced = context.routineDelivery.runNow(ability);
      expect(forced.alreadyQueued).toBe(true);
      await tick(harness);
      expect(routineLines(harness)).toHaveLength(1);
      await tick(harness);
      expect(routineLines(harness)).toHaveLength(1);
      // Two quiet minutes after the keystroke: the rest go in.
      harness.advance(QUIET_AFTER_TYPING_MS);
      await tick(harness);
      expect(routineLines(harness)).toHaveLength(2);
      // A routine running now cannot be run again.
      expect(() =>
        context.routineDelivery.runNow(ability, "ci-health"),
      ).toThrow("is running now");
    });
  });

  test("an unknown reading falls back to what the pane shows", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      const { ability } = await argus(harness);
      context.routines.add(ability, { text: routineText("ci-health") });
      const unknown = idle(harness, { activity: reading(harness, "unknown") });
      tmux.screen = CLAUDE_IDLE_SCREEN.replace(
        "⏺ Ready.",
        "✻ Churning… (12s · esc to interrupt)",
      );
      await tick(harness, unknown);
      expect(routineLines(harness)).toEqual([]);
      tmux.screen = CLAUDE_IDLE_SCREEN;
      await tick(harness, unknown);
      expect(routineLines(harness)).toHaveLength(1);
    });
  });

  test("Claude's idle notice does not hold routines", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      const { ability } = await argus(harness);
      context.routines.add(ability, { text: routineText("ci-health") });
      await tick(
        harness,
        idle(harness, {
          activity: reading(
            harness,
            "needs_input",
            "Claude is waiting for your input",
          ),
        }),
      );
      expect(routineLines(harness)).toHaveLength(1);
    });
  });

  test("keeps at most three runs in flight on Claude, one per routine", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      const { ability } = await argus(harness);
      for (const name of ["one", "two", "three", "four"])
        context.routines.add(ability, { text: routineText(name) });
      // A Claude session with background agents running still takes lines.
      const waiting = idle(harness, {
        activity: reading(
          harness,
          "working",
          "Waiting for 2 background agents",
        ),
      });
      for (let index = 0; index < 6; index += 1) await tick(harness, waiting);
      expect(routineLines(harness)).toHaveLength(3);
      expect(context.routineDelivery.status(ability)).toMatchObject({
        running: 3,
        hold: { reason: "in-flight-limit" },
      });
      // One finishes: the fourth goes out.
      const [first] = context.routines.deliveredRuns(ability);
      context.routines.start(ability, first!.id);
      await context.routines.done(ability, first!.id, "quiet", "all green");
      await tick(harness, waiting);
      expect(routineLines(harness)).toHaveLength(4);
    });
  });

  test("a Codex session takes one run at a time, as a $skill line", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      tmux.screen = "› Ask Codex to do anything\n\n  100% context left";
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const session = await context.agents.spawn({
        workspace: "ops",
        provider: "codex",
        name: "Scout",
        abilities: ["routines"],
      });
      const ability = context.abilities.require(session.id, "routines");
      context.routines.add(ability, { text: routineText("one") });
      context.routines.add(ability, { text: routineText("two") });
      for (let index = 0; index < 4; index += 1) await tick(harness);
      expect(routineLines(harness)).toHaveLength(1);
      expect(routineLines(harness)[0]).toMatch(
        /^\$daedalus-routine(-\w+)? \d+$/,
      );
      // The mention popup takes the first Enter; a second one submits.
      expect(tmux.keys.at(-1)).toEqual({
        session: session.tmuxSession,
        keys: ["Enter"],
      });
      // Text in Codex's box holds the next run once the first ends.
      const [first] = context.routines.deliveredRuns(ability);
      context.routines.start(ability, first!.id);
      await context.routines.done(ability, first!.id, "quiet", "ok");
      tmux.screen = "› check the logs\n\n  100% context left";
      await tick(harness);
      expect(routineLines(harness)).toHaveLength(1);
      tmux.screen = "› Ask Codex to do anything\n\n  100% context left";
      await tick(harness);
      expect(routineLines(harness)).toHaveLength(2);
    });
  });

  test("a waiting run is not queued twice, and a running one is skipped", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { session, ability } = await argus(harness);
      context.routines.add(ability, {
        text: routineText("slow", "", "every 5m"),
      });
      // The user talks with it for twenty minutes, so it is never waiting
      // at its prompt: one run waits, however many slots pass.
      harness.inbox.open = false;
      for (let index = 0; index < 4; index += 1) {
        context.deliveryGate.noteKeystroke(session.id);
        await tick(harness);
        harness.advance(5 * 60_000);
      }
      harness.inbox.open = true;
      expect(context.routines.runs(ability).map((run) => run.status)).toEqual([
        "queued",
      ]);
      // It goes in, late by the whole wait.
      harness.advance(QUIET_AFTER_TYPING_MS);
      await tick(harness);
      const [run] = context.routines.deliveredRuns(ability);
      expect(context.routines.start(ability, run!.id).prompt).toContain(
        "missed 2",
      );
      // Due again while it runs: skipped.
      harness.advance(5 * 60_000);
      await tick(harness, idle(harness, { activity: () => undefined }));
      const runs = context.routines.runs(ability);
      expect(runs[0]).toMatchObject({ status: "skipped" });
      expect(runs[0]!.summary).toContain("previous run has not ended");
    });
  });

  test("an overdue routine fires once, with how late it was", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability } = await argus(harness);
      context.routines.add(ability, {
        text: routineText("hourly", "", "every 1h"),
      });
      await tick(harness);
      const [first] = context.routines.deliveredRuns(ability);
      context.routines.start(ability, first!.id);
      await context.routines.done(ability, first!.id, "quiet", "ok");
      // The app was closed for five hours.
      harness.advance(5 * 3_600_000);
      await tick(harness, idle(harness, { activity: () => undefined }));
      const queued = context.routines.inFlightRuns(ability);
      expect(queued).toHaveLength(1);
      const started = context.routines.start(ability, queued[0]!.id);
      expect(started.prompt).toContain("missed 4h");
      expect(started.prompt).toContain("since 2026-09-30 10:00");
    });
  });

  test("times out a silent run and raises the badge after three failures", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { session, ability } = await argus(harness);
      context.routines.add(ability, {
        text: routineText("flaky", "", "every 15m"),
      });
      for (let round = 0; round < 3; round += 1) {
        await tick(harness);
        harness.advance(11 * 60_000);
        await tick(harness, idle(harness, { activity: () => undefined }));
        harness.advance(4 * 60_000);
      }
      const failed = context.routines
        .runs(ability, { routine: "flaky" })
        .filter((run) => run.status === "failed");
      expect(failed).toHaveLength(3);
      expect(failed[0]!.summary).toContain("never started");
      expect(
        context.activity
          .attentionFor(session.id)
          ?.reasons.map((reason) => reason.text)
          .join(" "),
      ).toContain("Routine 'flaky' failed 3 times in a row");
      // The badge the session carries does not stop delivery.
      expect(activityAtPrompt(context.activity.get(session.id))).toBe(true);
    });
  });

  test("drains before a handoff and hands the routines to the successor", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      const { session, ability } = await argus(harness);
      context.routines.add(ability, { text: routineText("ci-health") });
      await tick(harness);
      expect(context.routines.deliveredRuns(ability)).toHaveLength(1);
      context.routines.add(ability, { text: routineText("merges") });
      // The generic sweep leaves a routines session to the routine clock.
      await context.workspaces.update("ops", { autoHandoffPercent: 50 });
      expect(
        await context.agents.sweepAutoHandoffs([
          { sessionId: session.id, context: { usedPercent: 90 } },
        ]),
      ).toEqual([]);
      // Context passes the threshold: nothing more goes in, no handoff yet.
      const full = idle(harness, { contextPercent: () => 72 });
      await tick(harness, full);
      await tick(harness, full);
      expect(routineLines(harness)).toHaveLength(1);
      expect(context.routineDelivery.status(ability).hold).toMatchObject({
        reason: "handoff",
        text: "waiting for runs in flight before a handoff",
      });
      expect(
        tmux.sent.some((item) => item.text.includes("daedalus-handoff")),
      ).toBe(false);
      // The run in flight ends: now the handoff, under the delivery rule.
      const [inFlight] = context.routines.deliveredRuns(ability);
      context.routines.start(ability, inFlight!.id);
      await context.routines.done(ability, inFlight!.id, "quiet", "ok");
      context.deliveryGate.noteKeystroke(session.id);
      await tick(harness, full);
      expect(
        tmux.sent.some((item) => item.text.includes("daedalus-handoff")),
      ).toBe(false);
      harness.advance(QUIET_AFTER_TYPING_MS);
      await tick(harness, full);
      expect(tmux.sent.at(-1)!.text).toContain("daedalus-handoff");
      // The session runs `daedal agent continue` itself.
      const { session: successor } = await context.agents.continueSession({
        id: session.id,
        handoff: "Nothing in flight.",
      });
      // The waiting run goes to the successor.
      await tick(harness);
      expect(harness.inbox.lines.at(-1)).toMatchObject({
        sessionId: successor.id,
        line: expect.stringMatching(/^Daedalus: routine run \d+ is due\./),
      });
    });
  });

  test("a paused ability queues nothing and fires once on resume", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      const { session, ability } = await argus(harness);
      const paused = context.abilities.setPaused(session.id, "routines", true);
      context.routines.add(paused, { text: routineText("ci-health") });
      await tick(harness);
      expect(context.routines.runs(ability)).toEqual([]);
      expect(context.routineDelivery.status(paused)).toMatchObject({
        hold: { reason: "paused" },
        nextRun: null,
      });
      context.abilities.setPaused(session.id, "routines", false);
      harness.advance(60 * 60_000);
      await tick(harness);
      expect(context.routines.runs(ability)).toHaveLength(1);
      expect(routineLines(harness)).toHaveLength(1);
    });
  });
});

describe("routines in SQLite", () => {
  test("templates copy with vars and delete themselves after until", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability } = await argus(harness);
      context.routines.add(ability, {
        text: routineText("post-merge-watch", "vars:\n  pr: none\n").replace(
          "Check post-merge-watch",
          "Watch {{pr}}",
        ),
        template: true,
      });
      // A template never fires.
      await tick(harness);
      expect(context.routines.runs(ability)).toEqual([]);
      const routine = context.routines.add(ability, {
        from: "post-merge-watch",
        name: "watch-pr-57",
        vars: { pr: "org/repo#57" },
        until: "+60m",
      });
      expect(routine.vars.pr).toBe("org/repo#57");
      await tick(harness);
      const [run] = context.routines.inFlightRuns(ability);
      expect(context.routines.start(ability, run!.id).prompt).toContain(
        "Watch org/repo#57",
      );
      await context.routines.done(ability, run!.id, "quiet", "clean");
      harness.advance(61 * 60_000);
      await tick(harness, idle(harness, { activity: () => undefined }));
      const { routines, templates } = context.routines.list(ability);
      expect(routines).toEqual([]);
      expect(templates.map((item) => item.name)).toEqual(["post-merge-watch"]);
    });
  });

  test("bad text is refused, and replacing keeps the routine's state", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability } = await argus(harness);
      expect(() =>
        context.routines.add(ability, { text: "---\nname: x\n---\nbody" }),
      ).toThrow("'schedule' field is required");
      expect(() =>
        context.routines.add(ability, {
          text: "---\nname: x\nschedule: sometimes\n---\nbody",
        }),
      ).toThrow("is not one of");
      const first = context.routines.add(ability, {
        text: routineText("ci-health"),
      });
      expect(() =>
        context.routines.add(ability, { text: routineText("ci-health") }),
      ).toThrow("pass --replace");
      await tick(harness);
      const [run] = context.routines.deliveredRuns(ability);
      context.routines.start(ability, run!.id);
      await context.routines.done(ability, run!.id, "quiet", "ok");
      const replaced = context.routines.add(ability, {
        text: routineText("ci-health").replace("Check", "Look at"),
        replace: true,
      });
      expect(replaced.id).toBe(first.id);
      expect(replaced.body).toContain("Look at");
      expect(replaced.lastSuccessAt).not.toBeNull();
      expect(context.routines.text(replaced)).toContain("name: ci-health");
    });
  });

  test("disabled routines do not run and enabling schedules them", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability } = await argus(harness);
      context.routines.add(ability, {
        text: routineText("quiet", "enabled: false\n"),
      });
      await tick(harness);
      expect(context.routines.runs(ability)).toEqual([]);
      context.routines.setEnabled(ability, "quiet", true);
      await tick(harness);
      expect(context.routines.runs(ability)).toHaveLength(1);
    });
  });

  test("a one-shot routine removes itself once its run ends", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability } = await argus(harness);
      context.routines.add(ability, {
        text: routineText("reminder", "", "at 2026-09-30T10:05"),
      });
      harness.advance(5 * 60_000);
      await tick(harness);
      const [run] = context.routines.deliveredRuns(ability);
      context.routines.start(ability, run!.id);
      await context.routines.done(ability, run!.id, "notified", "told");
      expect(context.routines.list(ability).routines).toEqual([]);
    });
  });

  test("the purpose is set by the session and printed with every run", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { session, ability } = await argus(harness);
      context.routines.add(ability, { text: routineText("ci-health") });
      context.abilities.configure(
        session.id,
        "routines",
        "purpose",
        "  On-call for the payments services ",
      );
      await tick(harness);
      const [run] = context.routines.deliveredRuns(ability);
      expect(
        context.routines.start(
          context.abilities.require(session.id, "routines"),
          run!.id,
        ).purpose,
      ).toBe("On-call for the payments services");
    });
  });
});

describe("routine reports", () => {
  async function reportSetup(harness: Harness) {
    const { session, ability } = await argus(harness);
    harness.context.routines.add(ability, { text: routineText("ci-health") });
    const run = harness.context.routines.runNow(ability, "ci-health");
    const workspace = await harness.context.workspaces.get("ops");
    const report = (overrides: Record<string, unknown> = {}) =>
      harness.context.routineReports.report({
        ability,
        workspace,
        routine: "ci-health",
        output: "task",
        runId: run.id,
        key: "ci-health:org/repo:main:CI:test",
        urgent: false,
        title: "main red: test fails",
        body: "## Evidence\n\nexit 1",
        ...overrides,
      });
    return { session, ability, workspace, run, report };
  }

  test("the same key again is an update, not a second task", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const first = await report();
      expect(first.action).toBe("opened");
      expect(first.task).toMatchObject({
        title: "main red: test fails",
        priority: "normal",
      });
      expect(first.task!.description).toContain("Reported by Argus");
      expect(first.notified).not.toBeNull();
      harness.advance(30 * 60_000);
      const second = await report({ urgent: true });
      expect(second.action).toBe("updated");
      expect(second.notified).toBeNull();
      const tasks = context.repositories.listTasks({
        workspaceId: workspace.id,
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.description).toContain("## Update 2026-09-30 10:30");
      expect(tasks[0]!.description).toContain("· Urgent");
    });
  });

  test("two processes reporting one key at once make one task", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability, workspace, report } = await reportSetup(harness);
      const other = await harness.second();
      const otherReport = other.routineReports.report({
        ability,
        workspace,
        routine: "ci-health",
        output: "task",
        runId: 1,
        key: "ci-health:org/repo:main:CI:test",
        urgent: false,
        title: "main red: test fails",
        body: "from the other run",
      });
      const results = await Promise.all([report(), otherReport]);
      expect(results.map((result) => result.action).sort()).toEqual([
        "opened",
        "updated",
      ]);
      expect(
        context.repositories.listTasks({ workspaceId: workspace.id }),
      ).toHaveLength(1);
      expect(
        context.repositories.routines.listReports(ability.id),
      ).toHaveLength(1);
    });
  });

  test("a second key with the same cause joins the first task", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      await report();
      const merged = await report({
        routine: "post-merge-watch",
        key: "post-merge-watch:org/repo#57:deploy",
        sameAs: "ci-health:org/repo:main:CI:test",
        title: "deploy failed",
      });
      expect(merged.action).toBe("merged");
      expect(merged.notified).toBeNull();
      const tasks = context.repositories.listTasks({
        workspaceId: workspace.id,
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.description).toContain(
        "## Also seen by `post-merge-watch`",
      );
      const again = await report({
        key: "post-merge-watch:org/repo#57:deploy",
        title: "deploy failed",
      });
      expect(again.action).toBe("updated");
      expect(again.task?.id).toBe(tasks[0]!.id);
      await expect(
        report({ key: "x:y", sameAs: "nothing:open" }),
      ).rejects.toThrow("No open report");
    });
  });

  test("resolves, closes after a day untouched, and reopens within 14 days", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability, workspace, report } = await reportSetup(harness);
      const opened = await report();
      const resolved = context.routineReports.resolve(
        ability,
        "ci-health:org/repo:main:CI:test",
      );
      expect(resolved?.state).toBe("resolved");
      expect(
        context.routineReports.resolve(
          ability,
          "ci-health:org/repo:main:CI:test",
        ),
      ).toBeNull();
      harness.advance(23 * 3_600_000);
      context.routineReports.sweep(ability);
      expect(context.tasks.get(opened.task!.id).status).toBe("todo");
      harness.advance(2 * 3_600_000);
      const { closedTasks } = context.routineReports.sweep(ability);
      expect(closedTasks).toHaveLength(1);
      const closed = context.tasks.get(opened.task!.id);
      expect(closed.status).toBe("done");
      expect(closed.description).toContain("## Resolved at 2026-09-30 10:00");
      expect(closed.description).toContain(
        "## Closed by Argus: resolved at 2026-09-30 10:00, no action taken",
      );
      harness.advance(5 * 86_400_000);
      const back = await report();
      expect(back.action).toBe("reopened");
      expect(back.task?.id).toBe(opened.task!.id);
      expect(back.task?.status).toBe("todo");
      expect(back.report.reopenCount).toBe(1);
      expect(back.notified).not.toBeNull();
      context.routineReports.resolve(
        ability,
        "ci-health:org/repo:main:CI:test",
      );
      harness.advance(21 * 86_400_000);
      context.routineReports.sweep(ability);
      const later = await report();
      expect(later.action).toBe("opened");
      expect(later.task?.id).not.toBe(opened.task!.id);
      expect(later.task?.description).toContain(
        `The earlier task was ops#${opened.task!.number}`,
      );
      expect(
        context.repositories.listTasks({ workspaceId: workspace.id }),
      ).toHaveLength(2);
    });
  });

  test("a resolved task an agent worked on is left for the user", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability, report } = await reportSetup(harness);
      const opened = await report();
      await context.agents.spawn({
        workspace: "ops",
        taskId: opened.task!.id,
        provider: "claude",
      });
      const status = context.tasks.get(opened.task!.id).status;
      context.routineReports.resolve(
        ability,
        "ci-health:org/repo:main:CI:test",
      );
      harness.advance(25 * 3_600_000);
      expect(context.routineReports.sweep(ability).closedTasks).toEqual([]);
      expect(context.tasks.get(opened.task!.id).status).toBe(status);
    });
  });

  test("a task the user closed comes back when the issue is still there", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      const opened = await report();
      context.tasks.setStatus(opened.task!.id, "done");
      const again = await report();
      expect(again.action).toBe("reopened");
      expect(context.tasks.get(opened.task!.id).status).toBe("todo");
    });
  });

  test("a key marked Noise raises nothing until the verdict is removed", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability, workspace, report } = await reportSetup(harness);
      const opened = await report();
      const noise = context.routineReports.verdict(
        ability,
        opened.report.id,
        "noise",
        "flaky runner",
      );
      expect(noise).toMatchObject({ verdict: "noise", state: "closed" });
      expect(context.tasks.get(opened.task!.id).description).toContain(
        "## Marked noise at",
      );
      harness.advance(3_600_000);
      const quiet = await report({ urgent: true });
      expect(quiet).toMatchObject({
        action: "suppressed",
        task: null,
        notified: null,
      });
      expect(
        context.repositories.listTasks({ workspaceId: workspace.id }),
      ).toHaveLength(1);
      context.routineReports.verdict(ability, opened.report.id, null);
      const back = await report();
      expect(back.action).toBe("reopened");
      expect(back.task?.id).toBe(opened.task!.id);
    });
  });

  test("feedback on a task covers every key filed on it", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      const opened = await report();
      await report({
        routine: "post-merge-watch",
        key: "post-merge-watch:org/repo#57:deploy",
        sameAs: "ci-health:org/repo:main:CI:test",
        title: "deploy failed",
      });
      const marked = context.routineReports.feedbackForTask(
        opened.task!.id,
        "noise",
        "not ours",
      );
      expect(marked.map((item) => item.verdict)).toEqual(["noise", "noise"]);
      expect(
        context.tasks
          .get(opened.task!.id)
          .description.match(/## Marked noise at/g),
      ).toHaveLength(1);
      expect((await report()).action).toBe("suppressed");
      context.routineReports.feedbackForTask(opened.task!.id, null);
      expect((await report()).action).toBe("reopened");
      expect(() =>
        context.routineReports.feedbackForTask("no-such-task", "useful"),
      ).toThrow("No routine report");
    });
  });

  test("a task the user closes as done counts as useful", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability, report } = await reportSetup(harness);
      const opened = await report();
      context.tasks.setStatus(opened.task!.id, "done");
      context.routineReports.sweep(ability);
      expect(
        context.repositories.routines.findReport(opened.report.id),
      ).toMatchObject({ state: "closed", verdict: "useful" });
    });
  });

  test("an urgent report gets through Focus mode and others do not", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      await context.presence.setFocusMode(true);
      const warning = await report();
      expect(warning.notified).toBe("focus mode is on");
      const urgent = await report({
        key: "ci-health:org/repo:main:CI:deploy",
        urgent: true,
      });
      expect(urgent.notified).not.toBe("focus mode is on");
      expect(urgent.task?.priority).toBe("high");
    });
  });

  test("a notify routine notifies and opens no task", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const result = await report({
        routine: "slack",
        output: "notify",
        key: "slack:dm:123",
        title: "Dana asked about the deploy",
      });
      expect(result).toMatchObject({ action: "opened", task: null });
      expect(result.notified).not.toBeNull();
      expect(
        context.repositories.listTasks({ workspaceId: workspace.id }),
      ).toEqual([]);
      expect(
        (
          await report({
            routine: "slack",
            output: "notify",
            key: "slack:dm:123",
          })
        ).action,
      ).toBe("updated");
      await expect(report({ output: "none" })).rejects.toThrow("cannot report");
    });
  });

  test("the status counts what is open and in flight", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { ability, report } = await reportSetup(harness);
      expect(context.routineDelivery.status(ability)).toMatchObject({
        openReports: 0,
        routines: 1,
        running: 0,
        waiting: [expect.objectContaining({ routine: "ci-health" })],
      });
      await tick(harness);
      expect(context.routineDelivery.status(ability)).toMatchObject({
        running: 1,
        waiting: [],
        hold: null,
      });
      await report({ urgent: true });
      expect(context.routineDelivery.status(ability)).toMatchObject({
        openReports: 1,
        openUrgentReports: 1,
        openReportTasks: 1,
      });
    });
  });
});

describe("input box", () => {
  test("reads Claude's box under the composer rule", () => {
    expect(composerText(claudeScreen("draft here"))).toBe("draft here");
    expect(composerText(CLAUDE_IDLE_SCREEN)).toBe("");
    expect(composerText("no composer at all")).toBeUndefined();
  });

  test("treats a dim placeholder as an empty box, and typed text as text", () => {
    expect(composerText(CLAUDE_SUGGESTION_SCREEN)).toBe("");
    // Typed over the suggestion: normal text, then the suggestion's dim tail.
    expect(
      composerText(
        CLAUDE_SUGGESTION_SCREEN.replace(
          "\u001b[2mshow me the runs so far",
          "show\u001b[2m me the runs so far",
        ),
      ),
    ).toBe("show");
    expect(
      inputBoxText(
        "\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything",
        "codex",
      ),
    ).toBe("");
    expect(
      inputBoxText(
        "\u001b[1m›\u001b[0m fix \u001b[2mthe\u001b[22m build",
        "codex",
      ),
    ).toBe("fix  build");
  });

  test("a background agent's notice does not hold delivery; a dialog does", () => {
    const gate = new DeliveryGate();
    const session = {
      id: "s1",
      provider: "claude",
      status: "running",
      archivedAt: null,
      handoffRequestedAt: null,
    } as unknown as AgentSession;
    const asking = (source: AgentActivityState["source"]) =>
      ({
        sessionId: "s1",
        activity: "needs_input",
        detail: "Argus build needs your input",
        since: "2026-10-04T08:31:10.576Z",
        observedAt: "2026-10-04T08:31:10.576Z",
        source,
      }) satisfies AgentActivityState;
    // The input box shows, so the prompt itself is not asking anything.
    expect(
      gate.check({
        session,
        activity: asking("hook"),
        screen: CLAUDE_SUGGESTION_SCREEN,
      }),
    ).toBeNull();
    // A question dialog replaces the box: that one is held.
    expect(
      gate.check({
        session,
        activity: asking("hook"),
        screen: "⏺ Which branch?\n  1. main\n  2. dev\n  Enter to select",
      })?.reason,
    ).toBe("waiting-on-user");
  });

  test("reads Codex's box by its placeholder and prompt line", () => {
    expect(inputBoxText("› Ask Codex to do anything", "codex")).toBe("");
    expect(inputBoxText("› fix the build\n\n  98% context left", "codex")).toBe(
      "fix the build",
    );
    expect(inputBoxText("Working (3s)", "codex")).toBeUndefined();
  });

  test("claudeReady recognises the default mode footer", () => {
    expect(claudeReady("❯ \n  ⏸ manual mode on · ← for agents")).toBe(true);
    expect(claudeReady("auto mode on (shift+tab to cycle)")).toBe(true);
    expect(claudeReady("Do you trust the files in this folder?")).toBe(false);
  });
});

describe("appendToBrief", () => {
  test("drops the oldest updates first and keeps the report", () => {
    let brief = "> Reported\n\n## Evidence\n\nthe original evidence\n";
    for (let index = 0; index < 40; index += 1)
      brief = appendToBrief(brief, `Update ${index}`, "x".repeat(100), 1_500);
    expect(brief.length).toBeLessThanOrEqual(1_500);
    expect(brief).toContain("## Evidence\n\nthe original evidence");
    expect(brief).toContain("## Update 39");
    expect(brief).not.toContain("## Update 0\n");
    expect(brief.match(/Older updates were trimmed/g)).toHaveLength(1);
  });
});

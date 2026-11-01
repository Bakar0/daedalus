import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { DeliveryGate } from "./delivery";
import {
  activityAtPrompt,
  claudeReady,
  composerText,
  createApplicationContext,
  inputBoxText,
  QUIET_AFTER_TYPING_MS,
  type AgentActivityState,
  type AgentSession,
  type ApplicationContext,
  type AbilityNoteTickInput,
  type SessionAbility,
  inboxPath,
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
  openPty() {
    return {
      start: async () => {},
      write() {},
      resize() {},
      close() {},
    };
  }
  async pinWindowSize() {}
  async unpinWindowSize() {}
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
  })) satisfies AbilityNoteTickInput["activity"];

/** A tick input for a session sitting idle at its prompt. */
function idle(harness: Harness): AbilityNoteTickInput {
  return { activity: reading(harness, "idle") };
}

/** Ticks once, then moves the clock past the gap between two lines. */
async function tick(harness: Harness, input = idle(harness)) {
  const result = await harness.context.abilityNotes.tick(input);
  harness.advance(16_000);
  return result;
}

/** A Claude session called Argus in workspace `ops`, leading a team. */
async function argus(
  harness: Harness,
): Promise<{ session: AgentSession; ability: SessionAbility }> {
  if (!harness.context.repositories.findWorkspace("ops"))
    await harness.context.workspaces.create({ name: "Ops", slug: "ops" });
  const session = await harness.context.agents.spawn({
    workspace: "ops",
    provider: "claude",
    name: "Argus",
    abilities: ["orchestration"],
  });
  return {
    session,
    ability: harness.context.abilities.require(session.id, "orchestration"),
  };
}

/**
 * A Claude session launched before sessions had an inbox: notes are typed
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
        abilities: ["orchestration"],
        color: "teal",
        pinned: true,
      });
      expect(session).toMatchObject({ name: "Argus", color: "teal" });
      expect(session.pinnedAt).not.toBeNull();
      expect(context.abilities.held(session.id, "orchestration")).toMatchObject(
        {
          enabled: true,
          paused: false,
          pendingNote: null,
        },
      );
      // Told by its launch prompt, so no note waits to be typed.
      expect(tmux.launches.at(-1)!.args.join(" ")).toContain(
        "orchestration ability",
      );
      // An ordinary session folder: nothing is written into it.
      expect(session.workingDirectory).not.toContain("agents");
      // A terminal or a custom command cannot hold one.
      await expect(
        context.agents.spawn({
          workspace: "ops",
          terminal: true,
          abilities: ["orchestration"],
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

  test("a grant note and a rebirth request go to a Claude session's inbox", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const session = await context.agents.spawn({
        workspace: "ops",
        provider: "claude",
        name: "Helper",
      });
      const mailbox = Bun.file(`${inboxPath(context.config, session.id)}.mail`);
      // The user is typing: an inbox note does not wait for that.
      context.deliveryGate.noteKeystroke(session.id);
      const granted = context.abilities.grant(session.id, "orchestration", {
        live: true,
      });
      await tick(harness);
      expect(tmux.sent).toEqual([]);
      expect(await mailbox.text()).toBe(`${granted.pendingNote}\n`);
      expect(
        context.abilities.held(session.id, "orchestration")?.pendingNote,
      ).toBeNull();
      // The rebirth request too, which works mid-turn.
      const requested = await context.agents.requestRebirth(session.id);
      expect(requested.rebirthRequestedAt).not.toBeNull();
      expect(tmux.sent).toEqual([]);
      expect((await mailbox.text()).split("\n")[1]).toMatch(
        /^Daedalus: continue your work in a fresh session now\. Run the daedalus-rebirth(-\w+)? skill\.$/,
      );
    });
  });

  test("a grant to a running session is typed in under the delivery rule", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const session = withoutInbox(
        harness,
        await context.agents.spawn({
          workspace: "ops",
          provider: "claude",
          name: "Helper",
        }),
      );
      expect(context.abilities.list(session.id)).toEqual([]);
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
        context.abilities.grant(session.id, "orchestration", { live: true }),
      ).toThrow("already holds");
    });
  });

  test("revoke leaves a note and keeps the row for a later grant", async () => {
    await withAbilities(async (harness) => {
      const { context } = harness;
      const { session, ability } = await argus(harness);
      const revoked = context.abilities.revoke(session.id, "orchestration");
      expect(revoked).toMatchObject({ enabled: false });
      expect(revoked.pendingNote).toContain(
        "orchestration ability was removed",
      );
      expect(() =>
        context.abilities.require(session.id, "orchestration"),
      ).toThrow("does not hold the orchestration ability");
      // Granted again: the same row.
      const back = context.abilities.grant(session.id, "orchestration", {
        live: true,
      });
      expect(back.id).toBe(ability.id);
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
      // Any picked color, kept in lower case.
      await context.agents.setColor(session.id, "#1A2B3C");
      expect(await context.agents.get(session.id)).toMatchObject({
        color: "#1a2b3c",
      });
      for (const bad of ["#12345", "#1234567", "#gggggg", "1a2b3c"])
        await expect(context.agents.setColor(session.id, bad)).rejects.toThrow(
          "or #rrggbb",
        );
    });
  });

  test("a rebirth moves the abilities, name, pin and color to the successor", async () => {
    await withAbilities(async (harness) => {
      const { context, tmux } = harness;
      const { session, ability } = await argus(harness);
      await context.agents.setColor(session.id, "gold");
      await context.agents.setPinned(session.id, true);
      const { session: successor, predecessor } =
        await context.agents.continueSession({
          id: session.id,
          note: "Nothing in flight.",
        });
      expect(successor).toMatchObject({ name: "Argus · 2", color: "gold" });
      expect(successor.pinnedAt).not.toBeNull();
      expect(successor.workingDirectory).toBe(session.workingDirectory);
      expect(context.abilities.held(successor.id, "orchestration")?.id).toBe(
        ability.id,
      );
      expect(
        context.abilities.held(predecessor.id, "orchestration"),
      ).toBeUndefined();
      expect(predecessor.archivedAt).not.toBeNull();
      // Archiving the predecessor did not pause what moved.
      expect(
        context.abilities.held(successor.id, "orchestration")?.paused,
      ).toBe(false);
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
      const { context } = harness;
      const { session } = await argus(harness);
      await context.agents.archive(session.id, true);
      expect(context.abilities.held(session.id, "orchestration")?.paused).toBe(
        true,
      );
      await context.agents.restore(session.id);
      expect(context.abilities.held(session.id, "orchestration")?.paused).toBe(
        false,
      );
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
      rebirthRequestedAt: null,
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

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  createApplicationContext,
  inboxPath,
  QUIET_AFTER_TYPING_MS,
  ROUTINE_RUN_SKILL,
  type AgentActivityState,
  type AgentSession,
  type ApplicationContext,
  type SessionHost,
} from "../index";

/** Claude at its prompt with an empty input box. */
const IDLE_SCREEN = [
  "⏺ Ready.",
  "────────────────────────────────",
  "❯ ",
  "────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

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
  readonly sent: Array<{ session: string; text: string }> = [];
  readonly keys: Array<{ session: string; keys: string[] }> = [];
  screen = IDLE_SCREEN;
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
    return this.screen;
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

interface Harness {
  context: ApplicationContext;
  tmux: FakeTmux;
  /** Lines the inbox pipe took; `open: false` means nothing is reading. */
  inbox: { open: boolean; lines: string[] };
  advance(ms: number): void;
  reading(activity: AgentActivityState["activity"]): AgentActivityState;
  /** A Claude session in workspace `ops`, launched with an inbox. */
  claude(): Promise<AgentSession>;
  /** A Claude session launched before sessions had an inbox. */
  typedClaude(): Promise<AgentSession>;
}

async function withChannel(run: (harness: Harness) => Promise<void>) {
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
    const clock = { now: new Date(2026, 8, 30, 10, 0, 0) };
    const tmux = new FakeTmux();
    const inbox = { open: true, lines: [] as string[] };
    const context = await createApplicationContext({
      env: {
        DAEDALUS_HOME: home,
        CODEX_HOME: join(home, "codex"),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        DAEDALUS_AGENTS_HOME: join(home, "agents"),
        DAEDALUS_CURSOR_HOME: join(home, "cursor"),
      },
      tmux,
      now: () => clock.now,
      sendNativeNotification: async () => ({
        delivered: true,
        backend: "app" as const,
        degraded: false,
      }),
      sessionInbox: async (_session, line) => {
        if (!inbox.open) return false;
        inbox.lines.push(line);
        return true;
      },
    });
    const spawn = async (provider: "claude" | "codex") => {
      if (!context.repositories.findWorkspace("ops"))
        await context.workspaces.create({ name: "Ops", slug: "ops" });
      return context.agents.spawn({ workspace: "ops", provider });
    };
    try {
      await context.skills.sync();
      await run({
        context,
        tmux,
        inbox,
        advance: (ms) => {
          clock.now = new Date(clock.now.getTime() + ms);
        },
        reading: (activity) => ({
          sessionId: "",
          activity,
          detail: null,
          since: clock.now.toISOString(),
          observedAt: clock.now.toISOString(),
          source: "hook",
        }),
        claude: () => spawn("claude"),
        typedClaude: async () => {
          const session = await spawn("claude");
          const older = {
            ...session,
            args: session.args.filter(
              (argument) => !argument.includes("daedalus-inbox"),
            ),
          };
          context.repositories.updateAgent(older);
          return older;
        },
      });
    } finally {
      context.close();
    }
  });
}

const RUN = { id: ROUTINE_RUN_SKILL, args: "7" };

describe("session channel", () => {
  test("an inbox takes a line at the prompt, and typing does not hold it", async () => {
    await withChannel(async ({ context, tmux, inbox, reading, claude }) => {
      const session = await claude();
      context.deliveryGate.noteKeystroke(session.id);
      expect(context.sessionChannel.quietUntil(session)).toBeNull();
      expect(
        await context.sessionChannel.deliver(session, "run 7 is due", {
          when: "at-prompt",
          activity: reading("idle"),
          skill: RUN,
        }),
      ).toEqual({ kind: "delivered" });
      expect(inbox.lines).toEqual(["run 7 is due"]);
      expect(tmux.sent).toEqual([]);
    });
  });

  test("an inbox nobody reads, or a busy session, holds the line", async () => {
    await withChannel(async ({ context, inbox, reading, claude }) => {
      const session = await claude();
      expect(
        await context.sessionChannel.deliver(session, "run 7 is due", {
          when: "at-prompt",
          activity: reading("working"),
        }),
      ).toEqual({
        kind: "held",
        held: { reason: "busy", text: "the session is busy" },
      });
      inbox.open = false;
      expect(
        await context.sessionChannel.deliver(session, "run 7 is due", {
          when: "at-prompt",
          activity: reading("idle"),
        }),
      ).toEqual({
        kind: "held",
        held: {
          reason: "busy",
          text: "the session is not waiting at its prompt",
        },
      });
    });
  });

  test("a typed line waits for quiet and an empty box, then types the skill", async () => {
    await withChannel(
      async ({ context, tmux, advance, reading, typedClaude }) => {
        const session = await typedClaude();
        const channel = context.sessionChannel;
        const deliver = () =>
          channel.deliver(session, "run 7 is due", {
            when: "at-prompt",
            activity: reading("idle"),
            skill: RUN,
          });
        context.deliveryGate.noteKeystroke(session.id);
        expect(await deliver()).toMatchObject({ held: { reason: "typing" } });
        expect(channel.quietUntil(session)).not.toBeNull();
        advance(QUIET_AFTER_TYPING_MS);
        tmux.screen = IDLE_SCREEN.replace("❯ ", "❯ half a thought");
        expect(await deliver()).toMatchObject({
          held: { reason: "input-text" },
        });
        tmux.screen = IDLE_SCREEN;
        expect(await deliver()).toEqual({ kind: "delivered" });
        expect(tmux.sent.map((item) => item.text)).toEqual([
          expect.stringMatching(/^\/daedalus-routine(-\w+)? 7$/),
        ]);
      },
    );
  });

  test("a line waits for the last one to land", async () => {
    await withChannel(
      async ({ context, tmux, advance, reading, typedClaude }) => {
        const session = await typedClaude();
        const send = (activity: AgentActivityState) =>
          context.sessionChannel.deliver(session, "a note", {
            when: "at-prompt",
            activity,
          });
        const before = reading("idle");
        expect(await send(before)).toEqual({ kind: "delivered" });
        advance(16_000);
        // No reading since the last line: it may not have landed.
        expect(await send(before)).toEqual({ kind: "settling" });
        expect(await send(reading("idle"))).toEqual({ kind: "delivered" });
        advance(5_000);
        expect(await send(reading("idle"))).toEqual({ kind: "settling" });
        // Without a reading for two minutes, the last line counts as lost.
        advance(2 * 60_000);
        expect(await send(before)).toEqual({ kind: "delivered" });
        expect(tmux.sent).toHaveLength(3);
      },
    );
  });

  test("a skill that is not installed holds as skill-missing", async () => {
    await withChannel(async ({ context, tmux, reading, typedClaude }) => {
      const session = await typedClaude();
      await context.skills.setEnabled(ROUTINE_RUN_SKILL, false);
      expect(
        await context.sessionChannel.deliver(session, "run 7 is due", {
          when: "at-prompt",
          activity: reading("idle"),
          skill: RUN,
        }),
      ).toMatchObject({
        held: {
          reason: "skill-missing",
          text: expect.stringContaining("daedal skill enable"),
        },
      });
      expect(tmux.sent).toEqual([]);
    });
  });

  test("next-prompt goes to an inbox mid-turn, and waits to be typed", async () => {
    await withChannel(
      async ({ context, tmux, reading, claude, typedClaude }) => {
        const session = await claude();
        const working = reading("working");
        expect(
          await context.sessionChannel.deliver(session, "you hold teams", {
            when: "next-prompt",
            activity: working,
          }),
        ).toEqual({ kind: "delivered" });
        expect(
          await Bun.file(
            `${inboxPath(context.config, session.id)}.mail`,
          ).text(),
        ).toBe("you hold teams\n");
        const typed = await typedClaude();
        expect(
          await context.sessionChannel.deliver(typed, "you hold teams", {
            when: "next-prompt",
            activity: working,
          }),
        ).toMatchObject({ held: { reason: "busy" } });
        expect(tmux.sent).toEqual([]);
      },
    );
  });

  test("now types at once, whatever the gate says, into a running session", async () => {
    await withChannel(async ({ context, tmux, typedClaude }) => {
      const session = await typedClaude();
      context.deliveryGate.noteKeystroke(session.id);
      tmux.screen = IDLE_SCREEN.replace("❯ ", "❯ half a thought");
      expect(
        await context.sessionChannel.deliver(session, "hand off", {
          when: "now",
        }),
      ).toEqual({ kind: "delivered" });
      expect(tmux.sent.map((item) => item.text)).toEqual(["hand off"]);
      expect(
        await context.sessionChannel.deliver(
          { ...session, status: "exited" },
          "hand off",
          { when: "now" },
        ),
      ).toEqual({
        kind: "held",
        held: { reason: "stopped", text: "the session is not running" },
      });
    });
  });

  test("a cloud session's line goes into its pod's pane, not this Mac's tmux", async () => {
    await withChannel(async ({ context, tmux, typedClaude }) => {
      const session = await typedClaude();
      const sent: string[] = [];
      const host = {
        id: "ws:11111111-1111-4111-8111-111111111111",
        kind: "cloud",
        capture: async () => IDLE_SCREEN,
        send: async (_session: string, text: string) => {
          sent.push(text);
        },
        sendKeys: async () => {},
      } as unknown as SessionHost;
      context.hosts.register(host);
      expect(
        await context.sessionChannel.deliver(
          { ...session, hostId: host.id },
          "hand off",
          { when: "now" },
        ),
      ).toEqual({ kind: "delivered" });
      expect(sent).toEqual(["hand off"]);
      expect(tmux.sent).toEqual([]);
    });
  });
});

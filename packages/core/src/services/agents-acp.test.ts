import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  AcpHost,
  createApplicationContext,
  DAEDALUS_STATUS_INSTRUCTIONS,
  type AcpLaunch,
  type AcpLogEntry,
  type AcpService,
} from "../index";

const FAKE_ADAPTER = join(import.meta.dir, "acp-fake-adapter.fixtures.ts");

/**
 * A tmux whose sessions are real ACP hosts, run in this process on the
 * stand-in adapter. Ending a session ends its host, as killing tmux would.
 */
class HostingTmux implements TmuxClient {
  readonly sessions = new Map<string, Promise<unknown>>();
  readonly launches: TmuxLaunch[] = [];
  readonly files: AcpLaunch[] = [];
  readonly sent: string[] = [];
  readonly keys: string[][] = [];
  private readonly stops = new Map<string, () => void>();

  openPty() {
    return { start: async () => {}, write() {}, resize() {}, close() {} };
  }
  async pinWindowSize() {}
  async unpinWindowSize() {}
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
    this.launches.push(launch);
    if (launch.args[0] !== "acp-host") {
      this.sessions.set(launch.session, Promise.resolve());
      return;
    }
    const file = (await Bun.file(launch.args[1]!).json()) as AcpLaunch;
    this.files.push(file);
    const host = new AcpHost({
      ...file,
      adapter: { executable: process.execPath, args: [FAKE_ADAPTER] },
    });
    const done = host.run().then(() => this.sessions.delete(launch.session));
    this.sessions.set(launch.session, done);
  }
  async hasSession(session: string) {
    return this.sessions.has(session);
  }
  async listSessions() {
    return [...this.sessions.keys()];
  }
  async attach() {
    return 0;
  }
  async capture() {
    // What a provider's terminal shows at its prompt, for the tmux sessions.
    return "Ask Codex to do anything\nClaude Code v2.1.251\nshift+tab to cycle";
  }
  async sendKeys(_session: string, keys: string[]) {
    this.keys.push(keys);
  }
  async send(_session: string, text: string) {
    this.sent.push(text);
  }
  async stop(session: string) {
    await this.sessions.get(session);
    this.sessions.delete(session);
  }
  async killServer() {
    return false;
  }
}

async function until(
  acp: AcpService,
  id: string,
  found: (entries: AcpLogEntry[]) => boolean,
): Promise<AcpLogEntry[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { entries } = await acp.events(id);
    if (found(entries)) return entries;
    if (Date.now() > deadline)
      throw new Error(`Not seen in:\n${JSON.stringify(entries, null, 1)}`);
    await Bun.sleep(20);
  }
}

const turnEnds = (entries: AcpLogEntry[]) =>
  entries.flatMap((entry) =>
    entry.from === "host" && entry.event.type === "turn_end"
      ? [entry.event]
      : [],
  );
const turnStarts = (entries: AcpLogEntry[]) =>
  entries.flatMap((entry) =>
    entry.from === "host" && entry.event.type === "turn_start"
      ? [entry.event.text]
      : [],
  );

async function withAcpAgent(
  run: (given: {
    home: string;
    tmux: HostingTmux;
    context: Awaited<ReturnType<typeof createApplicationContext>>;
    workspace: string;
  }) => Promise<void>,
): Promise<void> {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: {
          claude: { executable: process.execPath, args: [] },
          codex: { executable: process.execPath, args: [] },
        },
      }),
    );
    const tmux = new HostingTmux();
    const context = await createApplicationContext({
      env: {
        DAEDALUS_HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        CODEX_HOME: join(home, "codex"),
      },
      tmux,
    });
    try {
      const workspace = await context.workspaces.create({ name: "Acp" });
      await run({ home, tmux, context, workspace: workspace.id });
    } finally {
      for (const agent of await context.agents.list({}))
        if (agent.status === "running")
          await context.agents.stop(agent.id).catch(() => undefined);
      context.close();
    }
  });
}

describe("AgentService over ACP", () => {
  test("spawns a Claude agent on its host and takes the conversation's id from it", async () => {
    await withAcpAgent(async ({ home, tmux, context, workspace }) => {
      const agent = await context.agents.spawn({
        workspace,
        provider: "claude",
        model: "opus",
        message: "hello there",
        runner: "acp",
      });
      expect(agent.runner).toBe("acp");
      expect(agent.status).toBe("running");
      expect(agent.providerSessionId).toBe("fake-1");
      expect((await context.agents.get(agent.id)).runner).toBe("acp");
      const launch = tmux.launches[0]!;
      expect(launch.executable).toBe(join(home, "bin", "daedal"));
      expect(launch.args).toEqual([
        "acp-host",
        context.agents.acp.paths(agent.id).launch,
      ]);
      expect(launch.env).toMatchObject({
        CLAUDE_CODE_EXECUTABLE: process.execPath,
        DAEDALUS_SESSION_ID: agent.id,
        DAEDALUS_HOME: home,
      });
      expect(tmux.files[0]).toMatchObject({
        home,
        sessionId: agent.id,
        cwd: agent.workingDirectory,
        provider: "claude",
        model: "opus",
        mode: "auto",
        prompt: "hello there",
        meta: {
          systemPrompt: { append: DAEDALUS_STATUS_INSTRUCTIONS },
          claudeCode: {
            options: {
              model: "opus",
              settings: expect.stringContaining(agent.id),
            },
          },
        },
      });
      const entries = await until(
        context.agents.acp,
        agent.id,
        (seen) => turnEnds(seen).length === 1,
      );
      expect(turnStarts(entries)).toEqual(["hello there"]);
      // Nothing was typed into a terminal.
      expect(tmux.sent).toEqual([]);
      expect(tmux.keys).toEqual([]);
    });
  }, 30_000);

  test("send is a turn, interrupt cancels it, and stop ends the host", async () => {
    await withAcpAgent(async ({ tmux, context, workspace }) => {
      const agent = await context.agents.spawn({
        workspace,
        provider: "claude",
        runner: "acp",
      });
      const other = await context.agents.spawn({
        workspace,
        provider: "claude",
        name: "Reviewer",
      });
      expect(other.runner).toBe("tmux");
      const { acp } = context.agents;
      await context.agents.send(agent.id, "slow work");
      await until(acp, agent.id, (seen) => turnStarts(seen).length === 1);
      await context.agents.interrupt(agent.id);
      const cancelled = await until(
        acp,
        agent.id,
        (seen) => turnEnds(seen).length === 1,
      );
      expect(turnEnds(cancelled)).toEqual([
        { type: "turn_end", stopReason: "cancelled" },
      ]);
      await context.agents.send(agent.id, "  review this  ", { from: other });
      const entries = await until(
        acp,
        agent.id,
        (seen) => turnEnds(seen).length === 2,
      );
      expect(turnStarts(entries)[1]).toBe(
        '[message from session "Reviewer", not the user] review this',
      );
      expect(tmux.sent).toEqual([]);
      expect(tmux.keys).toEqual([]);

      const stopped = await context.agents.stop(agent.id);
      expect(stopped.status).toBe("exited");
      expect(await tmux.hasSession(agent.tmuxSession)).toBe(false);
      const after = await acp.events(agent.id);
      expect(after.entries.at(-1)).toMatchObject({
        from: "host",
        event: { type: "exit" },
      });
    });
  }, 30_000);

  test("a restored agent loads its conversation and keeps its model", async () => {
    await withAcpAgent(async ({ tmux, context, workspace }) => {
      const agent = await context.agents.spawn({
        workspace,
        provider: "claude",
        model: "opus",
        message: "first",
        runner: "acp",
      });
      await until(
        context.agents.acp,
        agent.id,
        (seen) => turnEnds(seen).length === 1,
      );
      await context.agents.archive(agent.id, true);
      const restored = await context.agents.restore(agent.id);
      expect(restored.status).toBe("running");
      expect(restored.runner).toBe("acp");
      expect(restored.providerSessionId).toBe("fake-1");
      expect(tmux.files[1]).toMatchObject({
        load: "fake-1",
        model: "opus",
        provider: "claude",
      });
      // Loading carries on: no launch prompt and no mode forced on it again.
      expect(tmux.files[1]!.prompt).toBeUndefined();
      expect(tmux.files[1]!.mode).toBeUndefined();
      const entries = await until(context.agents.acp, agent.id, (seen) =>
        seen.some(
          (entry) => entry.from === "host" && entry.event.type === "ready",
        ),
      );
      // A new log: the adapter replays the conversation into it.
      expect(turnStarts(entries)).toEqual([]);
    });
  }, 30_000);

  test("a Codex agent gets its options through the adapter's configuration", async () => {
    await withAcpAgent(async ({ tmux, context, workspace }) => {
      const agent = await context.agents.spawn({
        workspace,
        provider: "codex",
        runner: "acp",
      });
      expect(agent.runner).toBe("acp");
      const env = tmux.launches[0]!.env ?? {};
      expect(env.CODEX_PATH).toBe(process.execPath);
      expect(JSON.parse(env.CODEX_CONFIG ?? "{}")).toMatchObject({
        developer_instructions: DAEDALUS_STATUS_INSTRUCTIONS,
        approval_policy: "on-request",
      });
      expect(tmux.files[0]!.provider).toBe("codex");
    });
  }, 30_000);

  test("a terminal and a custom command stay in tmux whatever is asked", async () => {
    await withAcpAgent(async ({ tmux, context, workspace }) => {
      const terminal = await context.agents.spawn({
        workspace,
        terminal: true,
        runner: "acp",
      });
      expect(terminal.runner).toBe("tmux");
      expect(tmux.files).toEqual([]);
    });
  }, 30_000);
});

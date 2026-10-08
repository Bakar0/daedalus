import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  claudeInboxLine,
  codexQueueArgs,
  createApplicationContext,
  findClaudeInbox,
  MANAGED_SKILLS,
  parseTags,
  ProviderTeamTransport,
  teamHandleBase,
  type AgentSession,
  type ApplicationContext,
  type TeamDelivery,
  type TeamTransport,
} from "../index";

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  readonly launches: TmuxLaunch[] = [];
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
  // Claude at its prompt, so a launch counts as ready at once.
  async capture() {
    return "❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)";
  }
  async sendKeys() {}
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    this.sessions.clear();
    return true;
  }
}

/** Records every delivery; a session id in `failing` refuses with a reason. */
class FakeTransport implements TeamTransport {
  readonly delivered: TeamDelivery[] = [];
  readonly failing = new Map<string, string>();
  async deliver(delivery: TeamDelivery) {
    const reason = this.failing.get(delivery.session.id);
    if (reason) throw new Error(reason);
    this.delivered.push(delivery);
  }
  to(session: AgentSession) {
    return this.delivered.filter((item) => item.session.id === session.id);
  }
}

interface Harness {
  context: ApplicationContext;
  tmux: FakeTmux;
  transport: FakeTransport;
}

async function withTeams(run: (harness: Harness) => Promise<void>) {
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
    const tmux = new FakeTmux();
    const transport = new FakeTransport();
    const context = await createApplicationContext({
      env: {
        DAEDALUS_HOME: home,
        CODEX_HOME: join(home, "codex"),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        DAEDALUS_AGENTS_HOME: join(home, "agents"),
        DAEDALUS_CURSOR_HOME: join(home, "cursor"),
      },
      tmux,
      teamTransport: transport,
      sendNativeNotification: async () => ({
        delivered: true,
        backend: "app" as const,
        degraded: false,
      }),
    });
    try {
      await context.workspaces.create({ name: "Shop", slug: "shop" });
      await run({ context, tmux, transport });
    } finally {
      context.close();
    }
  });
}

/** The settings JSON a Claude launch passes with `--settings`. */
function launchSettings(launch: TmuxLaunch): Record<string, unknown> {
  const index = launch.args.lastIndexOf("--settings");
  return JSON.parse(launch.args[index + 1]!) as Record<string, unknown>;
}

const prompt = (launch: TmuxLaunch) => launch.args.at(-1)!;

/** A Claude lead called Checkout API, and its team. */
async function lead(context: ApplicationContext) {
  const session = await context.agents.spawn({
    workspace: "shop",
    provider: "claude",
    name: "Checkout API",
    abilities: ["orchestration"],
  });
  return { session, team: context.teams.get(session.id) };
}

describe("teams", () => {
  test("a lead is told at launch and accepts messages from other sessions", async () => {
    await withTeams(async ({ context, tmux }) => {
      const { session, team } = await lead(context);
      expect(team).toMatchObject({ name: "Checkout API", goal: null });
      expect(prompt(tmux.launches.at(-1)!)).toContain("orchestration ability");
      expect(prompt(tmux.launches.at(-1)!)).toContain("TEAM.md");
      expect(launchSettings(tmux.launches.at(-1)!).crossSessionInbound).toBe(
        "accept",
      );
      // A session outside any team keeps Claude's own default.
      await context.agents.spawn({ workspace: "shop", provider: "claude" });
      expect(
        launchSettings(tmux.launches.at(-1)!).crossSessionInbound,
      ).toBeUndefined();
      expect(context.teams.membership(session.id)?.reader.handle).toBe("lead");
      expect(() => context.teams.get("nobody")).toThrow("No team");
    });
  });

  test("the lead adds members with handles, on its own provider", async () => {
    await withTeams(async ({ context, tmux, transport }) => {
      const { session: leader, team } = await lead(context);
      context.teams.setGoal(team.id, "Ship v2 checkout");
      const server = await context.teams.spawnMember({
        team: leader.id,
        addedBy: "lead",
        name: "Server worker",
        instructions: "Build the v2 endpoints.",
      });
      expect(server.handle).toBe("server-worker");
      expect(server.note).toBeUndefined();
      expect(server.session).toMatchObject({
        teamId: team.id,
        teamHandle: "server-worker",
        workspaceId: leader.workspaceId,
        provider: "claude",
      });
      const launch = tmux.launches.at(-1)!;
      expect(launchSettings(launch).crossSessionInbound).toBe("accept");
      expect(prompt(launch)).toContain(
        'You are @server-worker, a member of the Daedalus team "Checkout API"',
      );
      expect(prompt(launch)).toContain("The team's goal: Ship v2 checkout");
      expect(prompt(launch)).toContain("Build the v2 endpoints.");
      expect(prompt(launch)).toContain("daedalus-team");

      const second = await context.teams.spawnMember({
        team: team.id,
        addedBy: "lead",
        name: "Server worker",
        instructions: "Write the migrations.",
      });
      expect(second.handle).toBe("server-worker-2");
      expect(prompt(tmux.launches.at(-1)!)).toContain(
        "@server-worker ('Server worker')",
      );
      const reserved = await context.teams.spawnMember({
        team: team.id,
        addedBy: "lead",
        name: "Lead",
        instructions: "Review.",
      });
      expect(reserved.handle).toBe("lead-2");
      await expect(
        context.teams.spawnMember({
          team: team.id,
          addedBy: "lead",
          provider: "codex",
          instructions: "Anything.",
        }),
      ).rejects.toThrow("runs on claude, the lead's provider");
      await expect(
        context.teams.spawnMember({
          team: team.id,
          addedBy: "lead",
          instructions: "  ",
        }),
      ).rejects.toThrow("A member the lead adds needs instructions");
      // A member cannot lead a team of its own.
      expect(() =>
        context.abilities.grant(server.session.id, "orchestration", {
          live: true,
        }),
      ).toThrow("a member cannot lead one");
      expect(transport.delivered).toEqual([]);
    });
  });

  test("tags decide who is told, and deliveries carry an unread footer", async () => {
    await withTeams(async ({ context, transport }) => {
      const { session: leader, team } = await lead(context);
      const server = await context.teams.spawnMember({
        team: team.id,
        addedBy: "lead",
        name: "server",
        instructions: "Server.",
      });
      const client = await context.teams.spawnMember({
        team: team.id,
        addedBy: "lead",
        name: "client",
        instructions: "Client.",
      });

      const untagged = await context.teams.say({
        team: team.id,
        author: "server",
        body: "Endpoints are half done.",
      });
      expect(untagged.warnings[0]).toContain("tags no session");
      expect(untagged.deliveries).toEqual([]);

      const tagged = await context.teams.say({
        team: team.id,
        author: "server",
        body: "@client the token field is access_token. Mail me at a@b.com",
      });
      expect(tagged.message.tags).toEqual(["client"]);
      expect(tagged.deliveries).toMatchObject([
        { handle: "client", delivered: true, messages: 1 },
      ]);
      const [toClient] = transport.to(client.session);
      expect(toClient!.from).toBe('[team "Checkout API"] server');
      expect(toClient!.text).toBe(
        '[team "Checkout API"] server: @client the token field is access_token. Mail me at a@b.com\n\n' +
          "(1 other new message in the team chat; run 'daedal team chat' to read it.)",
      );
      // The lead is not copied on members talking to each other.
      expect(transport.to(leader)).toEqual([]);

      await expect(
        context.teams.say({
          team: team.id,
          author: "lead",
          body: "@clinet and @server, sync up",
        }),
      ).rejects.toThrow(
        "No one in 'Checkout API' is called @clinet; tag @lead, @server, @client, @all, @user",
      );

      // @all is everyone but the author; tagging yourself is dropped.
      const everyone = await context.teams.say({
        team: team.id,
        author: "lead",
        body: "@all @lead we keep v1 auth",
      });
      expect(everyone.message.tags.sort()).toEqual(["client", "server"]);
      expect(transport.to(server.session)).toHaveLength(1);
      expect(transport.to(leader)).toEqual([]);

      // @user is stored, and reaches no session.
      const forUser = await context.teams.say({
        team: team.id,
        author: "client",
        body: "@user which locale is the default?",
      });
      expect(forUser.message.tags).toEqual(["user"]);
      expect(forUser.warnings).toHaveLength(1);
    });
  });

  test("a failed send is kept, reported, and sent again with what came after", async () => {
    await withTeams(async ({ context, transport }) => {
      const { team } = await lead(context);
      const server = await context.teams.spawnMember({
        team: team.id,
        addedBy: "lead",
        name: "server",
        instructions: "Server.",
      });
      transport.failing.set(server.session.id, "no inbox yet");
      const first = await context.teams.say({
        team: team.id,
        author: "lead",
        body: "@server start with /orders",
      });
      expect(first.deliveries).toMatchObject([
        { handle: "server", delivered: false, error: "no inbox yet" },
      ]);
      expect(
        context.teams
          .status(team.id)
          .members.find((m) => m.handle === "server"),
      ).toMatchObject({ undelivered: 1, lastError: "no inbox yet" });

      transport.failing.delete(server.session.id);
      await context.teams.say({
        team: team.id,
        author: "lead",
        body: "@server then /refunds",
      });
      const [both] = transport.to(server.session);
      expect(both!.text).toBe(
        '[team "Checkout API"] lead: @server start with /orders\n\n' +
          '[team "Checkout API"] lead: @server then /refunds',
      );
      expect(
        context.teams
          .status(team.id)
          .members.find((m) => m.handle === "server"),
      ).toMatchObject({ undelivered: 0, lastError: null });
      // Nothing is sent twice.
      await context.teams.flush(team.id);
      expect(transport.to(server.session)).toHaveLength(1);
      // Its own hooks deliver what waited while it was not running.
      transport.failing.set(server.session.id, "busy socket");
      await context.teams.say({
        team: team.id,
        author: "lead",
        body: "@server and /webhooks",
      });
      transport.failing.delete(server.session.id);
      expect(await context.teams.flushSession(server.session.id)).toMatchObject(
        { delivered: true, messages: 1 },
      );
    });
  });

  test("a session that is not running waits for its next start", async () => {
    await withTeams(async ({ context, transport }) => {
      const { team } = await lead(context);
      const server = await context.teams.spawnMember({
        team: team.id,
        addedBy: "lead",
        name: "server",
        instructions: "Server.",
      });
      await context.agents.stop(server.session.id, true);
      const result = await context.teams.say({
        team: team.id,
        author: "lead",
        body: "@server status?",
      });
      expect(result.deliveries[0]).toMatchObject({
        delivered: false,
        error: "the session is exited; it gets the messages when it runs again",
      });
      expect(transport.to(server.session)).toEqual([]);

      // An archived member can still be tagged, and is not part of @all.
      await context.agents.archive(server.session.id, true);
      const archived = await context.teams.say({
        team: team.id,
        author: "lead",
        body: "@server once you are back, rebase",
      });
      expect(archived.message.tags).toEqual(["server"]);
      expect(archived.warnings).toEqual([
        "@server is archived; it gets the message when it is restored",
      ]);
      const everyone = await context.teams.say({
        team: team.id,
        author: "user",
        body: "@all hello",
      });
      expect(everyone.message.tags).toEqual(["lead"]);
      // Restoring it sends both waiting messages at once, without waiting
      // for a hook: a resumed session sits idle.
      await context.agents.restore(server.session.id);
      expect(transport.to(server.session)).toHaveLength(1);
      expect(await context.teams.flushSession(server.session.id)).toMatchObject(
        { delivered: false, messages: 0 },
      );
      expect(transport.to(server.session)[0]!.text).toContain(
        "lead: @server once you are back, rebase",
      );
    });
  });

  test("the user adding a member tells the lead with the instructions", async () => {
    await withTeams(async ({ context, transport }) => {
      const { session: leader, team } = await lead(context);
      const added = await context.teams.spawnMember({
        team: team.id,
        addedBy: "user",
        name: "docs",
        instructions: "Write the migration guide.",
      });
      expect(added.note?.message).toMatchObject({
        author: "daedalus",
        tags: ["lead"],
      });
      const [toLead] = transport.to(leader);
      expect(toLead!.text).toContain(
        "the user added @docs ('docs') to the team with these instructions:\n\nWrite the migration guide.",
      );
      expect(toLead!.from).toBe('[team "Checkout API"] daedalus');
    });
  });

  test("a member the user adds without instructions waits for them, in the lead's color", async () => {
    await withTeams(async ({ context, tmux, transport }) => {
      const leader = await context.agents.spawn({
        workspace: "shop",
        provider: "claude",
        name: "Checkout API",
        abilities: ["orchestration"],
        color: "teal",
      });
      const added = await context.teams.spawnMember({
        team: leader.id,
        addedBy: "user",
        name: "docs",
      });
      expect(added.session.color).toBe("teal");
      const launch = prompt(tmux.launches.at(-1)!);
      expect(launch).toContain(
        'You are @docs, a member of the Daedalus team "Checkout API"',
      );
      expect(launch).toContain("The user gives you your work in this session");
      expect(transport.to(leader)[0]!.text).toContain(
        "the user added @docs ('docs') to the team and is giving it its instructions directly",
      );
      // The lead's color is the team's: a change reaches every member.
      await context.agents.setColor(leader.id, "gold");
      expect(context.repositories.findAgent(added.session.id)?.color).toBe(
        "gold",
      );
    });
  });

  test("chat shows what each reader has not read and moves its marker", async () => {
    await withTeams(async ({ context }) => {
      const { team } = await lead(context);
      await context.teams.say({ team: team.id, author: "user", body: "one" });
      await context.teams.spawnMember({
        team: team.id,
        addedBy: "lead",
        name: "server",
        instructions: "Server.",
      });
      await context.teams.say({ team: team.id, author: "lead", body: "two" });
      expect(
        context.teams.chat(team.id, "server").messages.map((m) => m.body),
      ).toEqual(["one", "two"]);
      expect(context.teams.chat(team.id, "server").messages).toEqual([]);
      expect(
        context.teams.chat(team.id, "server", { all: true, limit: 1 }).messages,
      ).toMatchObject([{ body: "two" }]);
      expect(
        context.teams.status(team.id).members.find((m) => m.handle === "lead"),
      ).toMatchObject({ unread: 1 });
      const late = context.teams.chat(team.id, "user", { limit: 1 });
      expect(late).toMatchObject({ skipped: 1, messages: [{ body: "two" }] });
    });
  });

  test("handoffs keep the team: the lead's moves, a member keeps its handle", async () => {
    await withTeams(async ({ context, tmux }) => {
      const { session: leader, team } = await lead(context);
      const server = await context.teams.spawnMember({
        team: team.id,
        addedBy: "lead",
        name: "server",
        instructions: "Server.",
      });
      const { session: nextServer, predecessor } =
        await context.agents.continueSession({ id: server.session.id });
      expect(nextServer).toMatchObject({
        teamId: team.id,
        teamHandle: "server",
      });
      expect(context.repositories.findAgent(predecessor.id)).toMatchObject({
        teamId: null,
        teamHandle: null,
      });
      expect(prompt(tmux.launches.at(-1)!)).toContain("You are @server");
      expect(launchSettings(tmux.launches.at(-1)!).crossSessionInbound).toBe(
        "accept",
      );

      const { session: nextLead } = await context.agents.continueSession({
        id: leader.id,
      });
      expect(context.teams.get(nextLead.id).id).toBe(team.id);
      expect(nextLead.name).toBe("Checkout API");
      expect(prompt(tmux.launches.at(-1)!)).toContain("orchestration ability");
      expect(
        context.teams
          .readers(context.teams.get(team.id))
          .map((r) => [r.handle, r.session.id]),
      ).toEqual([
        ["lead", nextLead.id],
        ["server", nextServer.id],
      ]);
    });
  });

  test("revoking ends a team; archiving the lead only pauses it", async () => {
    await withTeams(async ({ context, transport }) => {
      const first = await lead(context);
      const member = await context.teams.spawnMember({
        team: first.team.id,
        addedBy: "lead",
        name: "server",
        instructions: "Server.",
      });
      context.abilities.revoke(first.session.id, "orchestration");
      expect(context.repositories.findAgent(member.session.id)).toMatchObject({
        teamId: null,
        teamHandle: null,
      });
      expect(context.teams.membership(member.session.id)).toBeUndefined();

      const second = await context.agents.spawn({
        workspace: "shop",
        provider: "claude",
        name: "Second",
        abilities: ["orchestration"],
      });
      const kept = await context.teams.spawnMember({
        team: second.id,
        addedBy: "lead",
        name: "kept",
        instructions: "Kept.",
      });
      // Archiving the lead pauses its team; it does not end it. Quitting the
      // app archives first and marks the session for resume after.
      await context.agents.archive(second.id, true);
      context.repositories.updateAgent({
        ...(await context.agents.get(second.id)),
        resumeOnStart: true,
      });
      expect(context.repositories.findAgent(kept.session.id)).toMatchObject({
        teamId: context.teams.get(second.id).id,
        teamHandle: "kept",
      });
      // A message to the paused lead waits, and no member can join.
      const waiting = await context.teams.say({
        team: second.id,
        author: "kept",
        body: "@lead done with the first part",
      });
      expect(waiting.deliveries[0]).toMatchObject({
        handle: "lead",
        delivered: false,
      });
      await expect(
        context.teams.spawnMember({
          team: second.id,
          addedBy: "user",
          name: "late",
        }),
      ).rejects.toThrow("its team is paused; restore it first");
      // Restoring the lead brings the team back and sends what waited.
      await context.agents.restore(second.id);
      expect(
        transport.to(await context.agents.get(second.id)).at(-1)!.text,
      ).toContain("kept: @lead done with the first part");
      expect(context.teams.membership(kept.session.id)?.team.lead.id).toBe(
        second.id,
      );
    });
  });

  test("the lead hears when a member needs the user or stops", async () => {
    await withTeams(async ({ context, transport }) => {
      const { session: leader, team } = await lead(context);
      const server = await context.teams.spawnMember({
        team: team.id,
        addedBy: "lead",
        name: "server",
        instructions: "Server.",
      });
      await context.activity.raise({
        sessionId: server.session.id,
        reason: "Which database should I use?",
      });
      const [asked] = transport.to(leader);
      expect(asked!.text).toBe(
        '[team "Checkout API"] daedalus: @lead @server needs the user: Which database should I use?',
      );
      // Archiving a running member stops it first; the lead hears once.
      await context.agents.archive(server.session.id, true);
      expect(transport.to(leader).map((item) => item.text)).toEqual([
        asked!.text,
        '[team "Checkout API"] daedalus: @lead @server stopped running.',
      ]);
      // The lead needing the user is the user's business, not the team's.
      await context.activity.raise({
        sessionId: leader.id,
        reason: "Approve the plan?",
      });
      expect(transport.to(leader)).toHaveLength(2);
      expect(context.repositories.teams.messages(team.id)).toHaveLength(2);
    });
  });

  test("handles and tags", () => {
    expect(teamHandleBase("Server worker #2!")).toBe("server-worker-2");
    expect(teamHandleBase("   ")).toBe("member");
    expect(teamHandleBase(undefined)).toBe("member");
    expect(
      parseTags("@Lead hi @all, ask @client-2. not a@b.com or @-x"),
    ).toEqual(["lead", "all", "client-2"]);
  });

  test("both skills are managed skills", () => {
    const ids = MANAGED_SKILLS.map((skill) => skill.id);
    expect(ids).toContain("daedalus-orchestration");
    expect(ids).toContain("daedalus-team");
  });
});

describe("team transport", () => {
  const session = (overrides: Partial<AgentSession>): AgentSession =>
    ({
      id: "daedalus-id",
      provider: "claude",
      providerSessionId: null,
      account: null,
      workingDirectory: "/tmp",
      ...overrides,
    }) as AgentSession;

  test("writes a user line to the live Claude session's inbox socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "dt-"));
    const claudeHome = join(root, "claude");
    await mkdir(join(claudeHome, "sessions"), { recursive: true });
    const socketPath = join(root, "in.sock");
    const received: string[] = [];
    let server: Server | undefined;
    try {
      server = createServer((socket) => {
        let data = "";
        socket.on("data", (chunk) => (data += chunk.toString()));
        socket.on("end", () => received.push(data));
      });
      await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
      // A stale file from a process that is gone, and the live one.
      await Bun.write(
        join(claudeHome, "sessions", "1.json"),
        JSON.stringify({
          pid: 999_999_999,
          sessionId: "daedalus-id",
          messagingSocketPath: join(root, "stale.sock"),
          updatedAt: 2,
        }),
      );
      await Bun.write(
        join(claudeHome, "sessions", `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          sessionId: "daedalus-id",
          messagingSocketPath: socketPath,
          updatedAt: 1,
        }),
      );
      await Bun.write(
        join(claudeHome, "sessions", "other.json"),
        JSON.stringify({
          pid: process.pid,
          sessionId: "someone-else",
          messagingSocketPath: join(root, "other.sock"),
        }),
      );
      expect(await findClaudeInbox(claudeHome, "daedalus-id")).toEqual({
        pid: process.pid,
        socketPath,
      });

      const transport = new ProviderTeamTransport(
        { claudeHome } as never,
        () => undefined,
      );
      await transport.deliver({
        session: session({}),
        text: '[team "API"] lead: @server go',
        from: '[team "API"] lead',
      });
      for (let attempt = 0; attempt < 50 && !received.length; attempt += 1)
        await Bun.sleep(10);
      expect(received).toEqual([
        claudeInboxLine({
          text: '[team "API"] lead: @server go',
          from: '[team "API"] lead',
          sessionId: "daedalus-id",
        }),
      ]);
      expect(JSON.parse(received[0]!)).toEqual({
        type: "user",
        message: { role: "user", content: '[team "API"] lead: @server go' },
        from: '[team "API"] lead',
        session_id: "daedalus-id",
      });

      // A session Claude does not list fails, saying why.
      await expect(
        transport.deliver({
          session: session({ id: "gone" }),
          text: "x",
          from: "y",
        }),
      ).rejects.toThrow("Claude has no live session gone");
    } finally {
      server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("queues into a Codex thread on the session's account", async () => {
    const calls: Array<{
      executable: string;
      args: string[];
      env: Record<string, string>;
    }> = [];
    let exitCode = 0;
    const transport = new ProviderTeamTransport(
      { home: "/daedalus" } as never,
      () => "/bin/codex",
      async (executable, args, options) => {
        calls.push({ executable, args, env: options.env });
        return { exitCode, stdout: "", stderr: exitCode ? "no thread" : "" };
      },
    );
    await transport.deliver({
      session: session({
        provider: "codex",
        providerSessionId: "thread-1",
        account: "work-1",
      }),
      text: "hello",
      from: "lead",
    });
    expect(calls).toEqual([
      {
        executable: "/bin/codex",
        args: codexQueueArgs("thread-1", "hello"),
        env: {
          CODEX_HOME: "/daedalus/accounts/codex/work-1",
          CODEX_SQLITE_HOME: "/daedalus/accounts/codex/work-1",
        },
      },
    ]);
    expect(codexQueueArgs("thread-1", "hello")).toEqual([
      "queue",
      "--thread",
      "thread-1",
      "--message",
      "hello",
    ]);
    exitCode = 1;
    await expect(
      transport.deliver({
        session: session({ provider: "codex", providerSessionId: "thread-1" }),
        text: "hello",
        from: "lead",
      }),
    ).rejects.toThrow("no thread");
    await expect(
      transport.deliver({
        session: session({ provider: "codex" }),
        text: "hello",
        from: "lead",
      }),
    ).rejects.toThrow("thread id");
  });
});

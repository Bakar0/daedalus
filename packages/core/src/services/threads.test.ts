import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  claudeTranscriptPath,
  createApplicationContext,
  HOME_WORKSPACE_ID,
  type AgentSession,
  type ApplicationContext,
  type TeamDelivery,
  type TeamTransport,
} from "../index";

class FakeTmux implements TmuxClient {
  openPty() {
    return { start: async () => {}, write() {}, resize() {}, close() {} };
  }
  async pinWindowSize() {}
  async unpinWindowSize() {}
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

/** Records every delivery, by the session it went to. */
class RecordingTransport implements TeamTransport {
  readonly sent: TeamDelivery[] = [];
  /** How many of the next deliveries fail, as a held or timed-out send does. */
  failing = 0;
  async deliver(delivery: TeamDelivery) {
    if (this.failing > 0) {
      this.failing -= 1;
      throw new Error("held: the session is mid-turn");
    }
    this.sent.push(delivery);
  }
  to(session: Pick<AgentSession, "id">): TeamDelivery[] {
    return this.sent.filter((each) => each.session.id === session.id);
  }
}

async function withHome(
  run: (harness: {
    home: string;
    context: ApplicationContext;
    tmux: FakeTmux;
    transport: RecordingTransport;
  }) => Promise<void>,
) {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: { claude: { executable: process.execPath, args: ["run"] } },
      }),
    );
    const tmux = new FakeTmux();
    const transport = new RecordingTransport();
    const context = await createApplicationContext({
      env: {
        DAEDALUS_HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        CODEX_HOME: join(home, "codex"),
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
      await context.workspaces.create({ name: "Checkout", slug: "checkout" });
      await context.workspaces.create({ name: "Docs", slug: "docs" });
      await run({ home, context, tmux, transport });
    } finally {
      context.close();
    }
  });
}
const PLAN = `---
plan: Cutover
---

## Tasks

- [ ] Fix orgs with no lake data
- [ ] Run batch 2
`;

const spawn = (context: ApplicationContext, name: string) =>
  context.agents.spawn({ provider: "claude", workspace: "checkout", name });

/** Makes `lead` the lead of a team with `member` in it, as handle `worker`. */
function team(
  context: ApplicationContext,
  lead: AgentSession,
  member: AgentSession,
) {
  const id = crypto.randomUUID();
  context.repositories.abilities.create({
    id,
    sessionId: lead.id,
    ability: "orchestration",
    enabled: true,
    paused: false,
    config: {},
    pendingNote: null,
    grantedAt: new Date().toISOString(),
    revokedAt: null,
  });
  context.repositories.setAgentTeam(member.id, id, "worker");
}

/** Writes a Claude transcript of agent messages, each its own entry. */
const transcript = (
  home: string,
  session: AgentSession,
  entries: { uuid: string; text: string; at?: string; role?: string }[],
) =>
  Bun.write(
    claudeTranscriptPath(join(home, "claude", "projects"), session),
    entries
      .map(({ uuid, text, at, role = "assistant" }) =>
        JSON.stringify({
          type: role,
          uuid,
          ...(at ? { timestamp: at } : {}),
          message: { role, content: [{ type: "text", text }] },
        }),
      )
      .join("\n"),
  );

describe("Threads", () => {
  test("a thread opens on the agent's last line in main, with no check on it", async () => {
    await withHome(async ({ home, context }) => {
      const main = await spawn(context, "deployer");
      // No transcript yet: the thread opens without an anchor.
      const { thread: bare } = await context.threads.new({
        session: main.id,
        body: "Branch name?",
      });
      expect(bare.anchorId).toBeNull();
      await transcript(home, main, [
        { uuid: "u-1", role: "user", text: "copy the images" },
        { uuid: "a-1", text: "I'm asking you for one thing: OK to copy?" },
        { uuid: "a-2", text: `Thread #${bare.number}: still waiting.` },
      ]);
      expect(
        (await context.threads.mainMessages(main.id)).map((m) => m.id),
      ).toEqual(["u-1", "a-1", "a-2"]);
      // A line about another thread is a line like any other.
      const { thread } = await context.threads.new({
        session: main.id,
        body: "OK to copy the 6 images?\nThey go to the ga bucket.",
        details: "gitops#9149",
        options: ["Yes", "No"],
      });
      expect(thread).toMatchObject({
        anchorId: "a-2",
        title: "OK to copy the 6 images?",
        status: { unread: true, turn: "user", blocking: false },
      });
      expect(thread.messages).toHaveLength(1);
      expect(thread.messages[0]).toMatchObject({
        author: "agent",
        details: "gitops#9149",
        options: ["Yes", "No"],
      });
      await expect(
        context.threads.new({ session: main.id, body: " " }),
      ).rejects.toThrow("Write a message");
      await expect(
        context.threads.new({ session: main.id, body: "x", task: "^a" }),
      ).rejects.toThrow("Name the plan");
    });
  });

  test("the user replies in the thread; the owner is brought it with a quote, and replies back", async () => {
    await withHome(async ({ context, transport }) => {
      const main = await spawn(context, "deployer");
      const { thread } = await context.threads.new({
        session: main.id,
        body: "OK to copy the 6 images?",
        options: ["Yes", "Only the daemons"],
      });
      // The user is notified once of what the owner wrote.
      expect(context.threads.claimNew().map((t) => t.number)).toEqual([
        thread.number,
      ]);
      expect(context.threads.claimNew()).toHaveLength(0);
      await expect(
        context.threads.say(thread.number, { as: "user", picked: 5 }),
      ).rejects.toThrow("offers no option 6");
      const { thread: replied } = await context.threads.say(thread.number, {
        as: "user",
        picked: 1,
        body: "and log each one",
      });
      // Replying does not end the thread: it is the agent's turn now.
      expect(replied.resolvedAt).toBeNull();
      expect(replied.status.turn).toBe("agent");
      expect(replied.messages.at(-1)).toMatchObject({
        author: "user",
        body: "Only the daemons\nand log each one",
        picked: 1,
      });
      const sent = transport.to(main);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain(
        `[thread #${thread.number}] The user (picked option 2):`,
      );
      expect(sent[0]!.text).toContain("Only the daemons");
      expect(sent[0]!.text).toContain('In reply to "OK to copy the 6 images?"');
      expect(sent[0]!.text).toContain(`daedal thread say ${thread.number}`);
      // Brought once.
      expect(await context.threads.flushSession(main.id)).toBe(false);
      // The owner's follow-up lands in the same thread, and notifies again.
      await context.threads.say(thread.number, {
        as: main.id,
        body: "Only gitops#9149 merged; the other two are open. Merge them?",
      });
      const again = context.threads.get(thread.number);
      expect(again.status).toMatchObject({ turn: "user", unread: true });
      expect(context.threads.claimNew().map((t) => t.number)).toEqual([
        thread.number,
      ]);
      expect(transport.to(main)).toHaveLength(1);
      expect(context.threads.markRead(thread.number).status.unread).toBe(false);
    });
  });

  test("a reply not brought yet survives the owner writing, bumping and resolving", async () => {
    await withHome(async ({ context, transport }) => {
      const main = await spawn(context, "deployer");
      const { thread } = await context.threads.new({
        session: main.id,
        body: "Which region?",
      });
      transport.failing = 1;
      await context.threads.say(thread.number, {
        as: "user",
        body: "eu-west-1",
      });
      expect(transport.to(main)).toHaveLength(0);
      transport.failing = Number.POSITIVE_INFINITY;
      await context.threads.say(thread.number, {
        as: main.id,
        body: "Still checking quotas",
      });
      context.threads.bump(thread.number, main.id);
      await context.threads.resolve(thread.number, {
        by: main.id,
        reason: "done",
      });
      transport.failing = 0;
      expect(await context.threads.flushSession(main.id)).toBe(true);
      const sent = transport.to(main);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain("eu-west-1");
      expect(await context.threads.flushSession(main.id)).toBe(false);
    });
  });

  test("bump blocks once until the user replies; a reply clears it", async () => {
    await withHome(async ({ context }) => {
      const main = await spawn(context, "deployer");
      const { thread } = await context.threads.new({
        session: main.id,
        body: "Retry budget?",
      });
      context.threads.claimNew();
      const first = context.threads.bump(thread.number, main.id);
      expect(first.bumped).toBe(true);
      expect(first.thread.status.blocking).toBe(true);
      expect(context.threads.bump(thread.number, main.id).bumped).toBe(false);
      // The user is notified again once, for the bump.
      expect(context.threads.claimNew().map((t) => t.number)).toEqual([
        thread.number,
      ]);
      expect(context.threads.claimNew()).toHaveLength(0);
      await context.threads.say(thread.number, { as: "user", body: "3" });
      expect(context.threads.get(thread.number).status.blocking).toBe(false);
      expect(context.threads.bump(thread.number, main.id).bumped).toBe(true);
    });
  });

  test("resolving, and writing in a resolved thread to reopen it", async () => {
    await withHome(async ({ context, transport }) => {
      const main = await spawn(context, "deployer");
      const other = await spawn(context, "other");
      const { thread } = await context.threads.new({
        session: main.id,
        body: "Merge #8789?",
      });
      await expect(
        context.threads.resolve(thread.number, { by: other.id }),
      ).rejects.toThrow("only it and its leads write in it");
      // The owner resolves its own: nobody is told.
      const resolved = await context.threads.resolve(thread.number, {
        by: main.id,
        reason: "the user said yes in main",
      });
      expect(resolved).toMatchObject({ resolvedBy: "agent" });
      expect(resolved.messages.at(-1)!.body).toBe(
        "resolved: the user said yes in main",
      );
      expect(transport.to(main)).toHaveLength(0);
      await expect(
        context.threads.resolve(thread.number, { by: main.id }),
      ).rejects.toThrow("resolved already");
      // A follow-up from the owner reopens it, in the same thread.
      const { thread: back } = await context.threads.say(thread.number, {
        as: main.id,
        body: "It failed CI; still OK?",
      });
      expect(back.resolvedAt).toBeNull();
      expect(back.messages.map((m) => [m.kind, m.body])).toEqual([
        ["message", "Merge #8789?"],
        ["notice", "resolved: the user said yes in main"],
        ["notice", "reopened"],
        ["message", "It failed CI; still OK?"],
      ]);
      // The user resolves it: the owner is told.
      await context.threads.resolve(thread.number, { by: "user" });
      expect(transport.to(main).at(-1)!.text).toContain(
        `[thread #${thread.number}] The user resolved it.`,
      );
      // And reopens it: the owner is told that too.
      await context.threads.reopen(thread.number);
      expect(transport.to(main).at(-1)!.text).toContain(
        `[thread #${thread.number}] The user reopened it`,
      );
      await expect(context.threads.reopen(thread.number)).rejects.toThrow(
        "open already",
      );
    });
  });

  test("a lead writes in its member's threads, shown as the lead", async () => {
    await withHome(async ({ context, transport }) => {
      const lead = await spawn(context, "lead");
      const member = await spawn(context, "worker");
      team(context, lead, member);
      const { thread } = await context.threads.new({
        session: member.id,
        body: "Which index?",
      });
      await context.threads.say(thread.number, {
        as: lead.id,
        body: "Use the composite one; the user agreed in my main.",
      });
      expect(context.threads.get(thread.number).messages.at(-1)!.author).toBe(
        "lead",
      );
      expect(transport.to(member).at(-1)!.text).toContain(
        `[thread #${thread.number}] Your lead lead:`,
      );
      // A lead's list with --team shows its members' threads.
      expect(
        context.threads
          .list({ session: lead.id, team: true })
          .map((t) => t.number),
      ).toContain(thread.number);
    });
  });

  test("find matches words in any thread of the workspace, open or resolved, within the time", async () => {
    await withHome(async ({ context }) => {
      const main = await spawn(context, "deployer");
      const elsewhere = await context.agents.spawn({
        provider: "claude",
        workspace: "docs",
        name: "docs",
      });
      const { thread: images } = await context.threads.new({
        session: main.id,
        body: "OK to copy the daemon images to the ga bucket?",
      });
      await context.threads.resolve(images.number, { by: main.id });
      await context.threads.new({
        session: main.id,
        body: "Restart the istio gateway?",
      });
      await context.threads.new({
        session: elsewhere.id,
        body: "Publish the images page?",
      });
      const hits = context.threads.find("image", { session: main.id });
      expect(hits.map((hit) => hit.thread.number)).toEqual([images.number]);
      expect(hits[0]!.thread.resolvedAt).not.toBeNull();
      expect(
        context.threads
          .find("images", { all: true })
          .map((h) => h.thread.number),
      ).toHaveLength(2);
      expect(
        context.threads.find("image", {
          session: main.id,
          since: new Date(Date.now() + 60_000).toISOString(),
        }),
      ).toHaveLength(0);
      expect(context.threads.find("xy", { session: main.id })).toHaveLength(0);
      // Opening a thread names the related ones.
      const { related } = await context.threads.new({
        session: main.id,
        body: "Copy the remaining daemon images too?",
      });
      expect(related.map((t) => t.number)).toEqual([images.number]);
    });
  });

  test("a snoozed thread waits out its time, then notifies the user again", async () => {
    await withHome(async ({ context }) => {
      const main = await spawn(context, "deployer");
      const { thread } = await context.threads.new({
        session: main.id,
        body: "Ship on Tuesday?",
      });
      expect(context.threads.claimNew()).toHaveLength(1);
      const until = new Date(Date.now() + 60 * 60_000).toISOString();
      expect(context.threads.snooze(thread.number, until).snoozedUntil).toBe(
        until,
      );
      expect(context.threads.claimNew()).toHaveLength(0);
      expect(() =>
        context.threads.snooze(thread.number, new Date(0).toISOString()),
      ).toThrow("in the future");
      // The time passes.
      context.repositories.conversations.updateThread(
        thread.id,
        { snoozedUntil: new Date(Date.now() - 1_000).toISOString() },
        new Date().toISOString(),
      );
      expect(context.threads.claimNew().map((t) => t.number)).toEqual([
        thread.number,
      ]);
    });
  });

  test("a pinned thread gives its task an id and resolves when the task is done", async () => {
    await withHome(async ({ context }) => {
      const main = await spawn(context, "lead");
      const file = await context.plans.create(
        { workspace: "checkout" },
        { title: "Cutover" },
      );
      await Bun.write(file.absolutePath, PLAN);
      const { thread } = await context.threads.new({
        session: main.id,
        body: "Re-onboard or skip?",
        plan: "cutover",
        task: "L7",
      });
      expect(thread.planPath).toBe(file.absolutePath);
      expect(thread.taskKey).toBe("fix-orgs-with-no-lake-data");
      expect(await readFile(file.absolutePath, "utf8")).toContain(
        "- [ ] Fix orgs with no lake data ^fix-orgs-with-no-lake-data",
      );
      expect(context.threads.onPlan(file.absolutePath)).toHaveLength(1);
      expect(await context.threads.sweepPlans()).toHaveLength(0);
      await context.plans.setState(file, "^fix-orgs-with-no-lake-data", "done");
      expect(await context.threads.sweepPlans()).toHaveLength(1);
      expect(context.threads.get(thread.number)).toMatchObject({
        resolvedBy: "daedalus",
      });
      expect(context.threads.get(thread.number).messages.at(-1)!.body).toBe(
        "resolved: its task ^fix-orgs-with-no-lake-data is done",
      );
    });
  });

  test("archiving resolves a session's threads; every message to it names the open ones and its notes once", async () => {
    await withHome(async ({ context, transport }) => {
      const gone = await spawn(context, "gone");
      const keep = await spawn(context, "keep");
      await context.threads.new({ session: gone.id, body: "First?" });
      const { thread: second } = await context.threads.new({
        session: keep.id,
        body: "Second?",
      });
      expect(context.threads.openLine(keep.id)).toContain(
        `Open threads: #${second.number} Second? (0m)`,
      );
      expect(context.threads.openLine(gone.id)).toContain("First?");
      await context.agents.archive(gone.id, true);
      expect(context.threads.list({ session: gone.id })[0]).toMatchObject({
        resolvedBy: "daedalus",
      });
      expect(context.threads.openLine(gone.id)).toBeUndefined();
      // A note waits for the session's next message, once.
      context.repositories.sessionNotes.add(
        keep.id,
        "[Daedalus] Commands changed.",
        new Date().toISOString(),
      );
      await context.threads.say(second.number, { as: "user", body: "yes" });
      const last = transport.to(keep).at(-1)!.text;
      expect(last).toContain("[Daedalus] Commands changed.");
      expect(last).toContain(
        `Open threads: #${second.number} Second? (0m, the user replied)`,
      );
      await context.threads.say(second.number, { as: "user", body: "and no" });
      expect(transport.to(keep).at(-1)!.text).not.toContain("Commands changed");
    });
  });

  test("a rebirth hands the threads to the successor", async () => {
    await withHome(async ({ context }) => {
      const old = await spawn(context, "old");
      const next = await spawn(context, "next");
      const { thread } = await context.threads.new({
        session: old.id,
        body: "Still open?",
      });
      context.repositories.conversations.moveThreads(old.id, next.id);
      await context.agents.archive(old.id, true);
      expect(context.threads.get(thread.number)).toMatchObject({
        ownerSessionId: next.id,
        resolvedAt: null,
      });
    });
  });

  test("a thread opened on a fork talks it through, and sends to main in the thread", async () => {
    await withHome(async ({ home, context, transport }) => {
      const main = await spawn(context, "webhooks");
      await transcript(home, main, [
        { uuid: "a-plan", text: "Plan: backoff, then a budget." },
        { uuid: "a-last", text: "Moving on to the dead-letter table." },
      ]);
      const thread = await context.threads.openFork({
        sessionId: main.id,
        anchorId: "a-plan",
      });
      expect(thread.anchorText).toBe("Plan: backoff, then a budget.");
      expect(thread.messages).toHaveLength(0);
      const fork = await context.agents.get(thread.forkSessionId!);
      const args = fork.args.join(" ");
      expect(args).toContain("--fork-session");
      expect(args).toContain("--permission-mode plan");
      // Nobody has written: it waits on nobody.
      expect(context.threads.openLine(main.id)).toBeUndefined();
      expect(context.threads.claimNew()).toHaveLength(0);

      // Every turn the fork is reminded what it is; main's news comes once.
      const quiet = await context.threads.forkCatchUp(fork.id);
      expect(quiet).toContain(`You are thread #${thread.number}`);
      expect(quiet).not.toContain("went on");
      const later = new Date(Date.now() + 60_000).toISOString();
      await transcript(home, main, [
        { uuid: "a-plan", text: "Plan: backoff, then a budget." },
        { uuid: "a-last", text: "Moving on to the dead-letter table." },
        { uuid: "a-new", text: "Dead-letter table is in.", at: later },
      ]);
      const caught = await context.threads.forkCatchUp(fork.id);
      expect(caught).toContain("Dead-letter table is in.");
      expect(await context.threads.forkCatchUp(fork.id)).toBe(quiet);
      expect(await context.threads.forkCatchUp(main.id)).toBeUndefined();

      // The same message forked again is the same thread.
      const again = await context.threads.openFork({
        sessionId: main.id,
        anchorId: "a-plan",
      });
      expect(again.number).toBe(thread.number);

      await transcript(home, fork, [
        {
          uuid: "f-2",
          text: "The queue drops jobs under load.\n\nFor main:\nKeep custom backoff.",
        },
      ]);
      expect(await context.threads.forkDraft(thread.number)).toBe(
        "Keep custom backoff.",
      );
      await expect(
        context.threads.sendForkToMain(thread.number, " "),
      ).rejects.toThrow("Write what to send");
      await context.threads.sendForkToMain(
        thread.number,
        "Keep custom backoff; log each retry too.",
      );
      const sent = transport.to(main).at(-1)!.text;
      expect(sent).toContain(`[thread #${thread.number}] The user:`);
      expect(sent).toContain("log each retry too.");
      expect(sent).toContain('In reply to "Plan: backoff, then a budget."');
      expect(sent).toContain(`daedal thread read ${thread.number}`);
      expect(context.threads.get(thread.number).status.turn).toBe("agent");

      await context.threads.resolve(thread.number, { by: "user" });
      expect((await context.agents.get(fork.id)).archivedAt).not.toBeNull();
      // Reopening brings the fork back.
      await context.threads.reopen(thread.number);
      expect((await context.agents.get(fork.id)).archivedAt).toBeNull();
    });
  });

  test("a thread the agent opened gets its own fork once", async () => {
    await withHome(async ({ context }) => {
      const main = await spawn(context, "webhooks");
      const { thread } = await context.threads.new({
        session: main.id,
        body: "How many tries?",
        options: ["3", "5"],
      });
      const forked = await context.threads.openFork({
        sessionId: main.id,
        threadNumber: thread.number,
      });
      expect(forked.number).toBe(thread.number);
      expect(forked.forkSessionId).not.toBeNull();
      const again = await context.threads.openFork({
        sessionId: main.id,
        threadNumber: thread.number,
      });
      expect(again.forkSessionId).toBe(forked.forkSessionId);
    });
  });

  test("closing a thread's fork archives it, and forking again brings it back", async () => {
    await withHome(async ({ context }) => {
      const main = await spawn(context, "webhooks");
      const { thread } = await context.threads.new({
        session: main.id,
        body: "How many tries?",
      });
      const forked = await context.threads.openFork({
        sessionId: main.id,
        threadNumber: thread.number,
      });
      expect(forked.status.forkOpen).toBe(true);
      const closed = await context.threads.closeFork(thread.number);
      expect(closed.status.forkOpen).toBe(false);
      expect(closed.forkSessionId).toBe(forked.forkSessionId);
      expect(closed.resolvedAt).toBeNull();
      expect(
        (await context.agents.get(forked.forkSessionId!)).archivedAt,
      ).not.toBeNull();
      expect(context.threads.closeFork(thread.number)).rejects.toThrow(
        "no open fork",
      );
      const again = await context.threads.openFork({
        sessionId: main.id,
        threadNumber: thread.number,
      });
      expect(again.forkSessionId).toBe(forked.forkSessionId);
      expect(again.status.forkOpen).toBe(true);
      expect(
        (await context.agents.get(forked.forkSessionId!)).archivedAt,
      ).toBeNull();
    });
  });

  test("archiving a session archives its threads' forks", async () => {
    await withHome(async ({ context }) => {
      const main = await spawn(context, "webhooks");
      const thread = await context.threads.openFork({ sessionId: main.id });
      await context.agents.archive(main.id, true);
      expect(context.threads.get(thread.number).resolvedAt).not.toBeNull();
      await context.threads.settled();
      expect(
        (await context.agents.get(thread.forkSessionId!)).archivedAt,
      ).not.toBeNull();
    });
  });
});

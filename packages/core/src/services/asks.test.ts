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
  async deliver(delivery: TeamDelivery) {
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

describe("Activity asks", () => {
  test("an ask is kept once; asking again rewrites it", async () => {
    await withHome(async ({ context }) => {
      const lead = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "lead",
      });
      const { ask, updated } = await context.asks.create({
        session: lead.id,
        title: "Re-onboard the two stage orgs, or skip them?",
        context: "zenity-management never got account.created.",
        why: "Batch 2 waits on it.",
        options: ["Re-send account created", "Skip them"],
        recommend: 1,
      });
      expect(updated).toBe(false);
      expect(ask).toMatchObject({
        state: "open",
        options: ["Re-send account created", "Skip them"],
        recommended: 0,
      });
      const again = await context.asks.create({
        session: lead.id,
        title: "re-onboard the two stage orgs, or skip them?",
        context: "Both orgs never got account.created.",
      });
      expect(again).toMatchObject({ updated: true, ask: { id: ask.id } });
      expect(context.asks.list().map((item) => item.id)).toEqual([ask.id]);
      // The user is notified of it once, however often it is rewritten.
      expect(context.asks.claimNew().map((item) => item.id)).toEqual([ask.id]);
      expect(context.asks.claimNew()).toEqual([]);
      expect(context.asks.get(ask.id).context).toBe(
        "Both orgs never got account.created.",
      );
      await expect(
        context.asks.create({ session: lead.id, title: "x", recommend: 1 }),
      ).rejects.toThrow("--recommend needs options");
    });
  });

  test("a snoozed ask waits out its time, then notifies the user again", async () => {
    await withHome(async ({ context, transport }) => {
      const lead = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "lead",
      });
      const { ask } = await context.asks.create({
        session: lead.id,
        title: "Ship it?",
      });
      expect(context.asks.claimNew().map((item) => item.id)).toEqual([ask.id]);
      const until = new Date(Date.now() + 60 * 60_000).toISOString();
      const snoozed = context.asks.snooze(ask.id, until);
      expect(snoozed).toMatchObject({ state: "open", snoozedUntil: until });
      // Not notified while it waits.
      expect(context.asks.claimNew()).toEqual([]);
      // Its time comes (set straight in the rows, as a clock passing would).
      context.repositories.asks.snooze(
        ask.id,
        new Date(Date.now() - 1_000).toISOString(),
        new Date().toISOString(),
      );
      expect(context.asks.claimNew().map((item) => item.id)).toEqual([ask.id]);
      expect(context.asks.claimNew()).toEqual([]);
      // Unsnoozing keeps the notification already sent.
      context.asks.snooze(ask.id, null);
      expect(context.asks.get(ask.id).snoozedUntil).toBeNull();
      expect(context.asks.claimNew()).toEqual([]);
      // The session is never told.
      expect(transport.to(lead)).toEqual([]);
      expect(() =>
        context.asks.snooze(ask.id, new Date(Date.now() - 5).toISOString()),
      ).toThrow("A snooze ends in the future");
      expect(() => context.asks.snooze(ask.id, "soon")).toThrow(
        "'soon' is not a time",
      );
      await context.asks.dismiss(ask.id);
      expect(() => context.asks.snooze(ask.id, until)).toThrow(
        "only an open ask can be snoozed",
      );
    });
  });

  test("answering tells the session, with the question and its context, once", async () => {
    await withHome(async ({ context, transport }) => {
      const lead = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "lead",
      });
      const { ask } = await context.asks.create({
        session: lead.id,
        title: "Which Jira ticket?",
        context: "@quick has no ticket for zenity#28274.",
        options: ["Reuse CTEM-4330", "A new ticket", "None this once"],
      });
      await expect(context.asks.answer(ask.id, {})).rejects.toThrow(
        "Pick an option or write an answer",
      );
      await context.asks.answer(ask.id, { option: 0, note: "link both" });
      const sent = transport.to(lead);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain(
        `[thread #${ask.id} answered by the user]`,
      );
      expect(sent[0]!.text).toContain("@quick has no ticket for zenity#28274.");
      expect(sent[0]!.text).toContain('Answer: Reuse CTEM-4330, "link both"');
      expect(await context.asks.flushSession(lead.id)).toBe(false);
      await expect(context.asks.dismiss(ask.id)).rejects.toThrow(
        "answered already",
      );
      // A free-text answer, with no options at all.
      const words = await context.asks.create({
        session: lead.id,
        title: "How should @s02-fixes reach the DB?",
      });
      await context.asks.answer(words.ask.id, { note: "use the ro user" });
      expect(transport.to(lead).at(-1)!.text).toContain(
        'Answer: "use the ro user"',
      );
    });
  });

  test("dismiss tells the session; Undo opens it again", async () => {
    await withHome(async ({ context, transport }) => {
      const lead = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "lead",
      });
      const { ask } = await context.asks.create({
        session: lead.id,
        title: "Restart istio-gateway?",
      });
      await context.asks.dismiss(ask.id);
      expect(transport.to(lead).at(-1)!.text).toContain("Do not ask it again");
      // The session has the answer already, so it stands.
      expect(() => context.asks.reopen(ask.id)).toThrow(
        "lead already has the answer",
      );
      // Undo works while the notice waits: here the session is stopped.
      const { ask: later } = await context.asks.create({
        session: lead.id,
        title: "Merge it?",
      });
      await context.agents.stop(lead.id);
      await context.asks.dismiss(later.id);
      expect(context.asks.reopen(later.id).state).toBe("open");
      expect(context.asks.list({ openOnly: true })).toHaveLength(1);
    });
  });

  test("only the asking session resolves its ask, and nobody is told", async () => {
    await withHome(async ({ context, transport }) => {
      const lead = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "lead",
      });
      const other = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "other",
      });
      const { ask } = await context.asks.create({
        session: lead.id,
        title: "Merge #8789?",
      });
      await expect(
        context.asks.resolve(ask.id, { session: other.id }),
      ).rejects.toThrow("belongs to another session");
      const resolved = await context.asks.resolve(ask.id, {
        session: lead.id,
        answer: "merged it",
      });
      expect(resolved).toMatchObject({
        state: "answered",
        note: "merged it",
        closedReason: "Answered in its session",
      });
      expect(transport.to(lead)).toHaveLength(0);
    });
  });

  test("a pinned ask gives its task an id and closes when the task is done", async () => {
    await withHome(async ({ context }) => {
      const lead = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "lead",
      });
      const file = await context.plans.create(
        { workspace: "checkout" },
        { title: "Cutover" },
      );
      await Bun.write(file.absolutePath, PLAN);
      const { ask } = await context.asks.create({
        session: lead.id,
        title: "Re-onboard or skip?",
        plan: "cutover",
        task: "L7",
      });
      expect(ask.planPath).toBe(file.absolutePath);
      expect(ask.taskKey).toBe("fix-orgs-with-no-lake-data");
      expect(await readFile(file.absolutePath, "utf8")).toContain(
        "- [ ] Fix orgs with no lake data ^fix-orgs-with-no-lake-data",
      );
      expect(context.asks.onPlan(file.absolutePath)).toHaveLength(1);
      expect(await context.asks.sweepPlans()).toHaveLength(0);
      await context.plans.setState(file, "^fix-orgs-with-no-lake-data", "done");
      expect(await context.asks.sweepPlans()).toHaveLength(1);
      expect(context.asks.get(ask.id)).toMatchObject({
        state: "closed",
        closedReason: "Its task ^fix-orgs-with-no-lake-data is done",
      });
      await expect(
        context.asks.create({ session: lead.id, title: "x", task: "^a" }),
      ).rejects.toThrow("Name the plan");
    });
  });

  test("archiving a session closes its asks; every message to it names the open ones", async () => {
    await withHome(async ({ context, transport }) => {
      const lead = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "lead",
      });
      const keep = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "keep",
      });
      await context.asks.create({ session: lead.id, title: "First?" });
      const { ask: second } = await context.asks.create({
        session: keep.id,
        title: "Second?",
      });
      expect(context.asks.openLine(keep.id)).toContain(
        `Open threads: #${second.id} Second? (0m)`,
      );
      expect(context.asks.openLine(lead.id)).not.toContain("Second?");
      await context.agents.archive(lead.id, true);
      expect(context.asks.list({ session: lead.id })[0]).toMatchObject({
        state: "closed",
        closedReason: "'lead' was archived",
      });
      expect(context.asks.openLine(lead.id)).toBeUndefined();
      // A message through the team transport ends with the open asks.
      const { ask: third } = await context.asks.create({
        session: keep.id,
        title: "Third?",
      });
      await context.asks.answer(third.id, { note: "yes" });
      const last = transport.to(keep).at(-1)!.text;
      expect(last).toContain("answered by the user");
      expect(last).toContain(`Open threads: #${second.id} Second?`);
    });
  });

  test("a rebirth hands the open asks to the successor", async () => {
    await withHome(async ({ context }) => {
      const old = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "old",
      });
      const next = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "next",
      });
      const { ask } = await context.asks.create({
        session: old.id,
        title: "Still open?",
      });
      context.repositories.asks.moveToSession(old.id, next.id);
      await context.agents.archive(old.id, true);
      expect(context.asks.get(ask.id)).toMatchObject({
        sessionId: next.id,
        state: "open",
      });
    });
  });

  test("a thread hangs off the agent's last message in main; bump counts once", async () => {
    await withHome(async ({ home, context }) => {
      const lead = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "lead",
      });
      // No transcript yet: the thread opens without an anchor.
      const { ask: bare } = await context.asks.create({
        session: lead.id,
        title: "Branch name?",
      });
      expect(bare.anchorId).toBeNull();

      const line = (entry: object) => JSON.stringify(entry);
      await Bun.write(
        claudeTranscriptPath(join(home, "claude", "projects"), lead),
        [
          line({
            type: "user",
            uuid: "u-1",
            timestamp: "2026-11-18T10:00:00.000Z",
            message: { role: "user", content: "add retries to webhooks" },
          }),
          line({
            type: "user",
            uuid: "u-meta",
            message: {
              role: "user",
              content: "<system-reminder>not typed</system-reminder>",
            },
          }),
          line({
            type: "assistant",
            uuid: "a-1",
            timestamp: "2026-11-18T10:00:05.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Plan: backoff, then budget." }],
            },
          }),
          line({
            type: "assistant",
            uuid: "a-tool",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }],
            },
          }),
          line({
            type: "user",
            uuid: "u-result",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "t", content: "ok" },
              ],
            },
          }),
          line({
            type: "assistant",
            uuid: "a-2",
            timestamp: "2026-11-18T10:01:00.000Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Asked about the retry budget in a thread.",
                },
              ],
            },
          }),
          "{ half a line",
        ].join("\n"),
      );
      const messages = await context.asks.mainMessages(lead.id);
      expect(messages.map((message) => [message.id, message.role])).toEqual([
        ["u-1", "user"],
        ["a-1", "agent"],
        ["a-2", "agent"],
      ]);
      const { ask } = await context.asks.create({
        session: lead.id,
        title: "Retry budget?",
        options: ["3 tries", "5 tries"],
      });
      expect(ask.anchorId).toBe("a-2");
      expect(ask.anchorText).toBe("Asked about the retry budget in a thread.");

      const first = context.asks.bump(ask.id, lead.id);
      expect(first.bumped).toBe(true);
      expect(first.ask.bumpedAt).not.toBeNull();
      expect(context.asks.bump(ask.id, lead.id).bumped).toBe(false);
      // The user is notified again once, for the bump.
      expect(context.asks.claimNew().map((item) => item.id)).toContain(ask.id);
      expect(context.asks.claimNew().map((item) => item.id)).not.toContain(
        ask.id,
      );
    });
  });

  test("a new question needs its own line in main, not another thread's", async () => {
    await withHome(async ({ home, context }) => {
      const main = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "deployer",
      });
      const path = claudeTranscriptPath(join(home, "claude", "projects"), main);
      const said = (...texts: string[]) =>
        Bun.write(
          path,
          texts
            .map((text, index) =>
              JSON.stringify({
                type: "assistant",
                uuid: `a-${index}`,
                message: {
                  role: "assistant",
                  content: [{ type: "text", text }],
                },
              }),
            )
            .join("\n"),
        );
      await said("I'm asking you for one thing: OK to copy the images?");
      const { ask: first } = await context.asks.create({
        session: main.id,
        title: "OK to copy the images?",
      });
      // No new line: the same message would carry a second question.
      await expect(
        context.asks.create({ session: main.id, title: "OK to unlock?" }),
      ).rejects.toThrow(`is about thread #${first.id}`);
      // A status message about the first thread is not the second's line.
      await said(
        "I'm asking you for one thing: OK to copy the images?",
        `Thread #${first.id}: I asked for your OK to copy the images.\n\nOther PRs are green.`,
      );
      await expect(
        context.asks.create({ session: main.id, title: "OK to unlock?" }),
      ).rejects.toThrow("Write one line in your reply");
      // With its own line, the question hangs off it.
      await said(
        "I'm asking you for one thing: OK to copy the images?",
        `Thread #${first.id}: I asked for your OK to copy the images.`,
        "Asked whether to force-unlock the stale Terraform lock.",
      );
      const { ask: second } = await context.asks.create({
        session: main.id,
        title: "OK to unlock?",
      });
      expect(second.anchorText).toBe(
        "Asked whether to force-unlock the stale Terraform lock.",
      );
      // Asking the same question again still rewrites it, as before.
      const again = await context.asks.create({
        session: main.id,
        title: "OK to unlock?",
      });
      expect(again.updated).toBe(true);
    });
  });

  test("a fork thread runs a read-only fork of the session and sends its reply to main", async () => {
    await withHome(async ({ home, context, transport }) => {
      const main = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "webhooks",
      });
      const projects = join(home, "claude", "projects");
      const entry = (uuid: string, type: string, text: string) =>
        JSON.stringify({
          type,
          uuid,
          message: { role: type, content: [{ type: "text", text }] },
        });
      await Bun.write(
        claudeTranscriptPath(projects, main),
        [
          entry("a-plan", "assistant", "Plan: backoff, then a budget."),
          entry("a-last", "assistant", "Moving on to the dead-letter table."),
        ].join("\n"),
      );

      const thread = await context.asks.openFork({
        sessionId: main.id,
        anchorId: "a-plan",
      });
      expect(thread.kind).toBe("fork");
      expect(thread.anchorText).toBe("Plan: backoff, then a budget.");
      const fork = await context.agents.get(thread.forkSessionId!);
      expect(fork.workingDirectory).toBe(main.workingDirectory);
      const args = fork.args.join(" ");
      expect(args).toContain(`--resume ${main.providerSessionId ?? main.id}`);
      expect(args).toContain("--fork-session");
      expect(args).toContain("--permission-mode plan");
      // A fork thread waits on nobody: not in the open line, not notified.
      expect(context.asks.openLine(main.id)).toBeUndefined();
      expect(context.asks.claimNew().map((ask) => ask.id)).not.toContain(
        thread.id,
      );

      // Every turn the fork is reminded what it is; main's news comes once.
      const quiet = await context.asks.forkCatchUp(thread.forkSessionId!);
      expect(quiet).toContain(`You are thread #${thread.id}`);
      expect(quiet).toContain("For main:");
      expect(quiet).not.toContain("went on");
      const later = new Date(Date.now() + 60_000).toISOString();
      await Bun.write(
        claudeTranscriptPath(projects, main),
        [
          entry("a-plan", "assistant", "Plan: backoff, then a budget."),
          entry("a-last", "assistant", "Moving on to the dead-letter table."),
          JSON.stringify({
            type: "assistant",
            uuid: "a-new",
            timestamp: later,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Dead-letter table is in." }],
            },
          }),
        ].join("\n"),
      );
      const caught = await context.asks.forkCatchUp(thread.forkSessionId!);
      expect(caught).toContain("Dead-letter table is in.");
      expect(caught).toContain("webhooks: ");
      expect(await context.asks.forkCatchUp(thread.forkSessionId!)).toBe(quiet);
      // A session that is no thread's fork reads nothing.
      expect(await context.asks.forkCatchUp(main.id)).toBe(undefined);

      // The same message forked again is the same thread, not a second one.
      const again = await context.asks.openFork({
        sessionId: main.id,
        anchorId: "a-plan",
      });
      expect(again.id).toBe(thread.id);

      expect(await context.asks.forkDraft(thread.id)).toBe("");
      await expect(context.asks.sendForkToMain(thread.id, " ")).rejects.toThrow(
        "Write what to send",
      );
      await Bun.write(
        claudeTranscriptPath(projects, fork),
        entry("f-1", "assistant", "Keep custom backoff; the queue drops jobs."),
      );
      expect(await context.asks.forkDraft(thread.id)).toBe(
        "Keep custom backoff; the queue drops jobs.",
      );
      // A reply with a "For main:" part drafts only that part.
      await Bun.write(
        claudeTranscriptPath(projects, fork),
        entry(
          "f-2",
          "assistant",
          "The queue drops jobs under load.\n\nFor main:\nKeep custom backoff.",
        ),
      );
      expect(await context.asks.forkDraft(thread.id)).toBe(
        "Keep custom backoff.",
      );
      // The user edits the draft before it goes.
      await context.asks.sendForkToMain(
        thread.id,
        "Keep custom backoff; the queue drops jobs. Log each retry too.",
      );
      const sent = transport.to(main).at(-1)!;
      expect(sent.text).toContain(`[thread #${thread.id}]`);
      expect(sent.text).toContain("the queue drops jobs. Log each retry too.");
      expect(sent.text).toContain("Plan: backoff, then a budget.");
      expect(sent.text).toContain(`daedal thread show ${thread.id}`);

      const closed = await context.asks.closeThread(thread.id);
      expect(closed.state).toBe("closed");
      expect((await context.agents.get(fork.id)).archivedAt).not.toBeNull();
    });
  });

  test("a question's fork is part of the question and answers it", async () => {
    await withHome(async ({ home, context }) => {
      const main = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "webhooks",
      });
      await Bun.write(
        claudeTranscriptPath(join(home, "claude", "projects"), main),
        JSON.stringify({
          type: "assistant",
          uuid: "a-ask",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Asked about the retry budget." }],
          },
        }),
      );
      const { ask } = await context.asks.create({
        session: main.id,
        title: "How many tries?",
        options: ["3", "5"],
      });
      const forked = await context.asks.openFork({
        sessionId: main.id,
        anchorId: ask.anchorId,
        threadId: ask.id,
      });
      expect(forked.id).toBe(ask.id);
      expect(forked.kind).toBe("question");
      expect(forked.forkSessionId).not.toBeNull();
      // Forking it again opens the same fork.
      const again = await context.asks.openFork({
        sessionId: main.id,
        anchorId: ask.anchorId,
        threadId: ask.id,
      });
      expect(again.forkSessionId).toBe(forked.forkSessionId);

      await context.asks.sendForkToMain(ask.id, "5 tries, and log each one.");
      const answered = context.asks.get(ask.id);
      expect(answered.state).toBe("answered");
      expect(answered.note).toContain("5 tries, and log each one.");
      expect(
        (await context.agents.get(forked.forkSessionId!)).archivedAt,
      ).not.toBeNull();
    });
  });

  test("archiving a session archives its threads' forks", async () => {
    await withHome(async ({ context }) => {
      const main = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "webhooks",
      });
      const thread = await context.asks.openFork({ sessionId: main.id });
      await context.agents.archive(main.id, true);
      expect(context.asks.get(thread.id).state).toBe("closed");
      const deadline = Date.now() + 5_000;
      while (
        !(await context.agents.get(thread.forkSessionId!)).archivedAt &&
        Date.now() < deadline
      )
        await Bun.sleep(50);
      expect(
        (await context.agents.get(thread.forkSessionId!)).archivedAt,
      ).not.toBeNull();
    });
  });

  test("a fork keeps its own messages apart from main's, across a resolve and a reopen", async () => {
    await withHome(async ({ home, context }) => {
      const main = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "webhooks",
      });
      const projects = join(home, "claude", "projects");
      const entry = (uuid: string, at: string, text: string) =>
        JSON.stringify({
          type: "assistant",
          uuid,
          timestamp: at,
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
      const before = new Date(Date.now() - 60_000).toISOString();
      await Bun.write(
        claudeTranscriptPath(projects, main),
        entry("a-main", before, "Main's own reply."),
      );
      const thread = await context.asks.openFork({ sessionId: main.id });
      const fork = await context.agents.get(thread.forkSessionId!);
      // Claude's fork starts with main's conversation copied in.
      await Bun.write(
        claudeTranscriptPath(projects, fork),
        entry("a-main", before, "Main's own reply."),
      );
      expect(await context.asks.forkDraft(thread.id)).toBe("");
      await Bun.sleep(5);
      const later = new Date().toISOString();
      await Bun.write(
        claudeTranscriptPath(projects, fork),
        [
          entry("a-main", before, "Main's own reply."),
          entry("f-1", later, "The fork's answer."),
        ].join("\n"),
      );
      expect(await context.asks.forkDraft(thread.id)).toBe(
        "The fork's answer.",
      );

      await context.asks.closeThread(thread.id);
      expect((await context.agents.get(fork.id)).archivedAt).not.toBeNull();
      await Bun.sleep(5);
      await context.asks.reopenThread(thread.id);
      const back = await context.agents.get(fork.id);
      expect(back.archivedAt).toBeNull();
      // The restore moved the session's start; the fork's messages stay.
      expect(Date.parse(back.startedAt)).toBeGreaterThan(Date.parse(later));
      expect(
        (await context.asks.forkConversation(thread.id)).map((m) => m.text),
      ).toEqual(["The fork's answer."]);
    });
  });

  test("a reopened question can be bumped again", async () => {
    await withHome(async ({ context }) => {
      const main = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "webhooks",
      });
      const { ask } = await context.asks.create({
        session: main.id,
        title: "Ship on Tuesday?",
      });
      await context.asks.bump(ask.id, main.id);
      await context.asks.closeThread(ask.id);
      await context.asks.flushSession(main.id);
      await context.asks.reopenThread(ask.id);
      expect(context.asks.get(ask.id).bumpedAt).toBeNull();
    });
  });

  test("resolving a question ends it, and reopening tells its owner", async () => {
    await withHome(async ({ context, transport }) => {
      const main = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "webhooks",
      });
      const { ask } = await context.asks.create({
        session: main.id,
        title: "Ship on Tuesday?",
      });
      const closed = await context.asks.closeThread(ask.id);
      expect(closed.state).toBe("dismissed");
      // Told it ended, the owner is told it is open again.
      await context.asks.flushSession(main.id);
      const reopened = await context.asks.reopenThread(ask.id);
      expect(reopened.state).toBe("open");
      expect(transport.to(main).at(-1)!.text).toContain(
        `[thread #${ask.id}] The user reopened`,
      );
    });
  });
});

import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
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
      expect(sent[0]!.text).toContain(`[ask #${ask.id} answered by the user]`);
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
        `Open asks: #${second.id} Second? (0m)`,
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
      expect(last).toContain(`Open asks: #${second.id} Second?`);
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
});

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  buildAgentPrompt,
  buildTaskTimeline,
  createApplicationContext,
  journalEntriesForTask,
  mentionsTaskNumber,
  parsePullRequestView,
  type ApplicationContext,
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
  async capture() {
    return "Ask Codex to do anything\nshift+tab to cycle";
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

async function withBoardContext(
  run: (context: ApplicationContext, tmux: FakeTmux) => Promise<void>,
) {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: { codex: { executable: process.execPath, args: ["run"] } },
      }),
    );
    const tmux = new FakeTmux();
    const context = await createApplicationContext({
      env: { DAEDALUS_HOME: home, CODEX_HOME: join(home, "codex") },
      tmux,
    });
    try {
      await run(context, tmux);
    } finally {
      context.close();
    }
  });
}

describe("starting a task", () => {
  test("moves a todo or blocked task to in progress, and nothing else", async () => {
    await withBoardContext(async (context) => {
      const workspace = await context.workspaces.create({ name: "Board" });
      const todo = await context.tasks.create({
        workspace: workspace.id,
        title: "Todo",
      });
      const blocked = await context.tasks.create({
        workspace: workspace.id,
        title: "Blocked",
      });
      context.tasks.setStatus(blocked.id, "blocked");
      const done = await context.tasks.create({
        workspace: workspace.id,
        title: "Done",
      });
      context.tasks.setStatus(done.id, "done");

      for (const task of [todo, blocked, done])
        await context.agents.spawn({
          workspace: workspace.id,
          taskId: task.id,
          provider: "codex",
        });

      expect(context.tasks.get(todo.id).status).toBe("in_progress");
      expect(context.tasks.get(blocked.id).status).toBe("in_progress");
      // Marking something done is a person's verdict. A second opinion
      // started on it afterwards does not reopen it behind their back.
      expect(context.tasks.get(done.id).status).toBe("done");
    });
  });

  test("leaves status alone when the workspace turns it off", async () => {
    await withBoardContext(async (context) => {
      const workspace = await context.workspaces.create({ name: "Manual" });
      const updated = await context.workspaces.update(workspace.id, {
        startSetsInProgress: false,
      });
      expect(updated.startSetsInProgress).toBe(false);
      const task = await context.tasks.create({
        workspace: workspace.id,
        title: "Stays todo",
      });
      await context.agents.spawn({
        workspace: workspace.id,
        taskId: task.id,
        provider: "codex",
      });
      expect(context.tasks.get(task.id).status).toBe("todo");
    });
  });

  test("a draft-brief session is linked to the task without starting it", async () => {
    await withBoardContext(async (context, tmux) => {
      const workspace = await context.workspaces.create({ name: "Drafts" });
      const task = await context.tasks.create({
        workspace: workspace.id,
        title: "Thin brief",
      });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        taskId: task.id,
        provider: "codex",
        draftBrief: true,
      });
      expect(session.taskId).toBe(task.id);
      expect(context.tasks.get(task.id).status).toBe("todo");
      const prompt = tmux.launches[0]!.args.at(-1)!;
      expect(prompt).toContain(`Draft the brief for task #${task.number}`);
      expect(prompt).toContain(
        `daedal task update ${task.number} --description-file -`,
      );
      expect(prompt).not.toContain("Execute task");
      await expect(
        context.agents.spawn({
          workspace: workspace.id,
          provider: "codex",
          draftBrief: true,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });
  });

  test("the draft prompt stays one instruction", () => {
    expect(buildAgentPrompt({ taskNumber: 7, mode: "draft-brief" })).toBe(
      "Draft the brief for task #7. Read the workspace, then write the brief back with `daedal task update 7 --description-file -`. Do not start the task itself.",
    );
  });
});

describe("workspace board settings", () => {
  test("default to on and no preference, and validate the provider", async () => {
    await withBoardContext(async (context) => {
      const workspace = await context.workspaces.create({ name: "Defaults" });
      expect(workspace).toMatchObject({
        startSetsInProgress: true,
        defaultProvider: null,
        defaultModel: null,
      });
      const chosen = await context.workspaces.update(workspace.id, {
        defaultProvider: "claude",
        defaultModel: "opus",
      });
      expect(chosen).toMatchObject({
        defaultProvider: "claude",
        defaultModel: "opus",
      });
      // The model named a Claude model. Switching provider without naming a
      // new one must not launch Codex with it.
      const switched = await context.workspaces.update(workspace.id, {
        defaultProvider: "codex",
      });
      expect(switched).toMatchObject({
        defaultProvider: "codex",
        defaultModel: null,
      });
      const cleared = await context.workspaces.update(workspace.id, {
        defaultProvider: null,
      });
      expect(cleared.defaultProvider).toBeNull();
      await expect(
        context.workspaces.update(workspace.id, { defaultProvider: "cursor" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      // Survives a round trip through SQLite, not just the returned object.
      expect(await context.workspaces.get(workspace.id)).toMatchObject({
        startSetsInProgress: true,
        defaultProvider: null,
      });
    });
  });
});

describe("brief edits", () => {
  test("are dated separately from status changes", async () => {
    await withBoardContext(async (context) => {
      const workspace = await context.workspaces.create({ name: "Briefs" });
      const task = await context.tasks.create({
        workspace: workspace.id,
        title: "Brief",
        description: "One",
      });
      expect(task.briefUpdatedAt).toBeNull();
      context.tasks.setStatus(task.id, "in_progress");
      expect(context.tasks.get(task.id).briefUpdatedAt).toBeNull();
      // Saving without a change is not an edit.
      context.tasks.update(task.id, { title: "Brief", description: "One" });
      expect(context.tasks.get(task.id).briefUpdatedAt).toBeNull();
      const edited = context.tasks.update(task.id, { description: "Two" });
      expect(edited.briefUpdatedAt).not.toBeNull();
      expect(context.tasks.get(task.id).briefUpdatedAt).toBe(
        edited.briefUpdatedAt,
      );
      const priority = context.tasks.update(task.id, { priority: "high" });
      expect(priority.briefUpdatedAt).toBe(edited.briefUpdatedAt);
    });
  });
});

describe("pull request lookup", () => {
  test("accepts only a complete answer from gh", () => {
    expect(
      parsePullRequestView(
        JSON.stringify({
          number: 23,
          url: "https://github.com/owner/repo/pull/23",
          state: "OPEN",
          isDraft: false,
        }),
      ),
    ).toEqual({
      number: 23,
      url: "https://github.com/owner/repo/pull/23",
      state: "OPEN",
      isDraft: false,
    });
    expect(
      parsePullRequestView(
        JSON.stringify({ number: 1, url: "https://x/1", state: "MERGED" }),
      ),
    ).toMatchObject({ state: "MERGED", isDraft: false });
    for (const bad of [
      "",
      "no pull requests found for branch",
      JSON.stringify({ number: "23", url: "https://x", state: "OPEN" }),
      JSON.stringify({ number: 23, url: "javascript:alert(1)", state: "OPEN" }),
      JSON.stringify({ number: 23, url: "https://x", state: "WEIRD" }),
    ])
      expect(parsePullRequestView(bad)).toBeUndefined();
  });
});

describe("journal entries for a task", () => {
  const journal = [
    "# Journal",
    "## 2026-09-19 · A reboot should be a non-event (task #19)",
    "## #15 — Shipped as PR #22",
    "## #22 — Escape left a session reading working",
    "### #22 follow-up — still reading working",
    "```",
    "## #22 — an example heading inside a code block",
    "```",
    "## other-workspace#22 is someone else's",
    "## #220 is a different task",
  ].join("\n");

  test("match #N in second- and third-level headings only", () => {
    expect(journalEntriesForTask(journal, 22)).toEqual([
      {
        heading: "#22 — Escape left a session reading working",
        line: 3,
        date: null,
      },
      {
        heading: "#22 follow-up — still reading working",
        line: 4,
        date: null,
      },
    ]);
    expect(journalEntriesForTask(journal, 19)).toEqual([
      {
        heading: "2026-09-19 · A reboot should be a non-event (task #19)",
        line: 1,
        date: "2026-09-19",
      },
    ]);
  });

  test("a pull request number is not a task number", () => {
    expect(mentionsTaskNumber("Shipped as PR #22", 22)).toBe(false);
    expect(mentionsTaskNumber("pull request #22 merged", 22)).toBe(false);
    expect(mentionsTaskNumber("Follow-on to #22", 22)).toBe(true);
    expect(mentionsTaskNumber("(#22)", 22)).toBe(true);
  });
});

describe("task timeline", () => {
  const task = {
    id: "t",
    workspaceId: "w",
    number: 7,
    title: "Seven",
    description: "",
    status: "done" as const,
    priority: "normal" as const,
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-21T18:00:00.000Z",
    completedAt: "2026-09-21T18:00:00.000Z",
    briefUpdatedAt: "2026-09-20T09:30:00.000Z",
  };
  const session = {
    id: "s",
    workspaceId: "w",
    taskId: "t",
    name: "Seven",
    provider: "claude" as const,
    kind: "agent" as const,
    tmuxSession: "daedalus_s",
    command: "claude",
    args: ["--model", "opus"],
    workingDirectory: "/tmp",
    status: "exited" as const,
    exitCode: 0,
    startedAt: "2026-09-20T10:00:00.000Z",
    endedAt: "2026-09-21T12:00:00.000Z",
    providerSessionId: null,
    archivedAt: null,
    resumeCount: 0,
    lostReason: null,
    resumeOnStart: false,
    position: 0,
  };

  test("orders a join over sessions, worktrees, attention and the journal", () => {
    const events = buildTaskTimeline({
      task,
      sessions: [session],
      worktrees: [
        {
          sessionId: "s",
          repositoryId: "r",
          path: "/tmp/w/s/repo",
          branchName: "daedalus/seven",
          createdAt: "2026-09-20T10:01:00.000Z",
        },
      ],
      openAttention: [],
      clearedAttention: [
        {
          id: "a",
          sessionId: "s",
          workspaceId: "w",
          text: "Which base branch?",
          source: "agent",
          raisedAt: "2026-09-20T11:00:00.000Z",
          clearedAt: "2026-09-20T11:04:00.000Z",
        },
        {
          id: "b",
          sessionId: "s",
          workspaceId: "w",
          text: "Push to origin?",
          source: "hook",
          raisedAt: "2026-09-20T11:02:00.000Z",
          clearedAt: "2026-09-20T11:04:00.000Z",
        },
      ],
      journal: "## 2026-09-21 · Task #7 landed\n## #7 — the undated one",
    });
    expect(events.map((event) => [event.kind, event.text])).toEqual([
      ["created", "Created"],
      ["brief_edited", "Brief edited"],
      ["session_spawned", "Claude started · opus"],
      ["worktree_created", "Worktree daedalus/seven"],
      ["attention_raised", "Claude asked"],
      ["attention_raised", "Claude asked"],
      // Two reasons came off the badge in one clear: one event, not two.
      ["attention_cleared", "Attention cleared (2 reasons)"],
      ["session_stopped", "Claude session stopped"],
      ["done", "Marked done"],
      // A day-precision heading sorts after that day's timestamps.
      ["journal", "Journal entry"],
      // An undated heading sorts last.
      ["journal", "Journal entry"],
    ]);
    expect(events[4]?.detail).toBe("Which base branch?");
    expect(events.at(-1)?.journalHeading).toBe("#7 — the undated one");
  });
});

describe("attention history", () => {
  test("keeps the newest five cleared reasons, and files an open badge on archive", async () => {
    await withBoardContext(async (context) => {
      const workspace = await context.workspaces.create({ name: "History" });
      const task = await context.tasks.create({
        workspace: workspace.id,
        title: "Asks a lot",
      });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        taskId: task.id,
        provider: "codex",
      });
      for (let round = 1; round <= 7; round += 1) {
        await context.activity.raise({
          sessionId: session.id,
          reason: `Question ${round}`,
        });
        context.activity.clear(session.id);
      }
      expect(
        context.activity.clearedReasons([session.id]).map((item) => item.text),
      ).toEqual([
        "Question 3",
        "Question 4",
        "Question 5",
        "Question 6",
        "Question 7",
      ]);
      // The badge itself still holds only what is open.
      expect(context.activity.attentionFor(session.id)).toBeUndefined();

      await context.activity.raise({
        sessionId: session.id,
        reason: "Still waiting when archived",
      });
      await context.agents.archive(session.id, true);
      expect(context.activity.clearedReasons([session.id]).at(-1)?.text).toBe(
        "Still waiting when archived",
      );

      const timeline = await context.taskHistory.timeline(task.id);
      const kinds = timeline.map((event) => event.kind);
      expect(kinds[0]).toBe("created");
      expect(kinds).toContain("session_spawned");
      expect(kinds).toContain("session_archived");
      expect(
        timeline.filter((event) => event.kind === "attention_raised"),
      ).toHaveLength(5);
    });
  });
});

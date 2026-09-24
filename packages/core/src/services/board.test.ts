import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  buildAgentPrompt,
  buildTaskTimeline,
  claudeUsageHistory,
  codexUsageHistory,
  createApplicationContext,
  journalEntriesForTask,
  mentionsTaskNumber,
  parsePullRequestView,
  parseTaskReferences,
  resolveTaskReferences,
  summarizeTaskCost,
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
    handoffRequestedAt: null,
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

describe("task references", () => {
  test("classify depends on, after and blocked by as hard, anything else as plain", () => {
    expect(
      parseTaskReferences(
        "Depends on #10, #11 and #12. Follow-on to #21, after #3 & #4.\nBLOCKED BY #5",
      ),
    ).toEqual([
      { number: 10, hard: true },
      { number: 11, hard: true },
      { number: 12, hard: true },
      { number: 21, hard: false },
      { number: 3, hard: true },
      { number: 4, hard: true },
      { number: 5, hard: true },
    ]);
  });

  test("a number named twice keeps its first position and the hard reading", () => {
    expect(parseTaskReferences("See #7 first. This depends on #7.")).toEqual([
      { number: 7, hard: true },
    ]);
  });

  test("code, pull requests and qualified numbers are not references", () => {
    const brief = [
      "Show `after #23` on the card and `depends on #9` in the docs.",
      "Shipped as PR #22, see pull request #30.",
      "Also other-workspace#40 and https://example.com/issues#41.",
      "",
      "    #24 Explorer that does not go stale",
      "    waiting on #25",
      "",
      "```",
      "after #26",
      "```",
      "- a list item that mentions #8",
      "    continued text, still prose, mentions #6",
    ].join("\n");
    expect(parseTaskReferences(brief)).toEqual([
      { number: 8, hard: false },
      { number: 6, hard: false },
    ]);
  });

  test("resolve only against real tasks in the same workspace, never the task itself", () => {
    const base = {
      description: "",
      status: "todo" as const,
      priority: "normal" as const,
      createdAt: "now",
      updatedAt: "now",
      completedAt: null,
      briefUpdatedAt: null,
    };
    const ten = {
      ...base,
      id: "ten",
      workspaceId: "w",
      number: 10,
      title: "Ten",
    };
    const eleven = {
      ...base,
      id: "eleven",
      workspaceId: "w",
      number: 11,
      title: "Eleven",
      description:
        "Depends on #10. Unlike #11, which is me, and #99, missing, and #12.",
    };
    const elsewhere = {
      ...base,
      id: "twelve-elsewhere",
      workspaceId: "other",
      number: 12,
      title: "Twelve",
    };
    expect(resolveTaskReferences(eleven, [ten, eleven, elsewhere])).toEqual([
      { number: 10, hard: true, taskId: "ten" },
    ]);
  });
});

describe("task cost", () => {
  test("reads the peak and every model from a whole Codex rollout", () => {
    const line = (value: unknown) => JSON.stringify(value);
    const rollout = [
      line({ type: "turn_context", payload: { model: "gpt-5" } }),
      line({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 80_000 },
            model_context_window: 200_000,
          },
        },
      }),
      line({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 30_000 },
            model_context_window: 200_000,
          },
        },
      }),
      line({ type: "turn_context", payload: { model: "gpt-5-codex" } }),
      '{"truncated',
    ].join("\n");
    expect(codexUsageHistory(rollout)).toEqual({
      models: ["gpt-5", "gpt-5-codex"],
      peakTokens: 80_000,
      peakPercent: 40,
    });
  });

  test("reads a Claude transcript, and needs a window for a percentage", () => {
    const turn = (model: string, input: number) =>
      JSON.stringify({
        type: "assistant",
        message: {
          model,
          usage: {
            input_tokens: input,
            cache_read_input_tokens: 1_000,
            output_tokens: 500,
          },
        },
      });
    const transcript = [
      turn("claude-opus-5-5", 100_000),
      turn("<synthetic>", 0),
      turn("claude-opus-5-5", 20_000),
    ].join("\n");
    expect(claudeUsageHistory(transcript)).toEqual({
      models: ["claude-opus-5-5"],
      peakTokens: 101_500,
    });
    expect(claudeUsageHistory(transcript, 1_000_000).peakPercent).toBeCloseTo(
      10.15,
    );
  });

  test("summarizes sessions, wall time, peak and models, terminals excluded", () => {
    const base = {
      workspaceId: "w",
      taskId: "t",
      name: "n",
      tmuxSession: "x",
      command: "c",
      args: [],
      workingDirectory: "/tmp",
      exitCode: null,
      providerSessionId: null,
      archivedAt: null,
      resumeCount: 0,
      lostReason: null,
      handoffRequestedAt: null,
      resumeOnStart: false,
      position: 0,
    };
    const stopped = {
      ...base,
      id: "a",
      provider: "claude" as const,
      kind: "agent" as const,
      status: "exited" as const,
      startedAt: "2026-09-23T10:00:00.000Z",
      endedAt: "2026-09-23T11:00:00.000Z",
    };
    const second = {
      ...base,
      id: "b",
      provider: "codex" as const,
      kind: "agent" as const,
      status: "exited" as const,
      startedAt: "2026-09-23T10:30:00.000Z",
      endedAt: "2026-09-23T13:12:00.000Z",
    };
    const terminal = {
      ...base,
      id: "c",
      provider: "custom" as const,
      kind: "terminal" as const,
      status: "running" as const,
      startedAt: "2026-09-23T09:00:00.000Z",
      endedAt: null,
    };
    const usage = new Map([
      ["a", { models: ["Opus 5.5"], peakPercent: 64 }],
      ["b", { models: ["gpt-5", "opus 5.5"], peakPercent: 91 }],
    ]);
    expect(summarizeTaskCost([stopped, second, terminal], usage)).toEqual({
      sessions: 2,
      firstStartedAt: "2026-09-23T10:00:00.000Z",
      lastEndedAt: "2026-09-23T13:12:00.000Z",
      running: false,
      peakContextPercent: 91,
      models: ["Opus 5.5", "gpt-5"],
    });
    const live = { ...second, status: "running" as const, endedAt: null };
    expect(summarizeTaskCost([stopped, live], usage)).toMatchObject({
      running: true,
      lastEndedAt: null,
    });
    expect(summarizeTaskCost([], new Map())).toEqual({
      sessions: 0,
      firstStartedAt: null,
      lastEndedAt: null,
      running: false,
      models: [],
    });
  });
});

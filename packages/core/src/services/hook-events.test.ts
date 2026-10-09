import { describe, expect, test } from "vitest";
import {
  codexHookInSession,
  observeClaudeHook,
  observeClaudePane,
  observeClaudeTranscript,
  observeCodexHook,
  observeCodexRollout,
  pendingBackgroundAgents,
  summarizeTool,
} from "./hook-events";

/**
 * The payloads below are real, captured from Claude Code 2.1.272 and
 * codex-cli 0.154.0 rather than written from the documentation. A mapping
 * tested against an invented payload only proves the test and the code agree.
 */
const claude = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: "1cb9fac5-f735-4c02-a6b8-bb60cef9ba0c",
  transcript_path: "/Users/x/.claude/projects/p/1cb9fac5.jsonl",
  cwd: "/tmp/work",
  hook_event_name: event,
  ...extra,
});

describe("summarizeTool", () => {
  test("names the thing being acted on, not the whole tool input", () => {
    expect(
      summarizeTool("Bash", { command: "git push", description: "Push" }),
    ).toBe("Bash(git push)");
    expect(summarizeTool("Edit", { file_path: "/a/b/agents.ts" })).toBe(
      "Edit(agents.ts)",
    );
    expect(summarizeTool("Grep", { pattern: "reconcile" })).toBe(
      "Grep(reconcile)",
    );
    // An MCP tool's arguments are arbitrary; the first string still beats the
    // bare tool name.
    expect(summarizeTool("mcp__thing__do", { whatever: "a value" })).toBe(
      "mcp__thing__do(a value)",
    );
    expect(summarizeTool("Task", {})).toBe("Task");
    expect(summarizeTool(undefined, {})).toBeUndefined();
  });

  test("collapses newlines so a detail line stays one line", () => {
    expect(summarizeTool("Bash", { command: "a\n  b" })).toBe("Bash(a b)");
  });
});

describe("Claude hook payloads", () => {
  test("SessionStart reports idle", () => {
    expect(
      observeClaudeHook(
        "SessionStart",
        claude("SessionStart", {
          source: "startup",
        }),
      ),
    ).toMatchObject({ activity: "idle", source: "hook" });
  });

  test("UserPromptSubmit is the one routine event allowed to retract a badge", () => {
    const observed = observeClaudeHook(
      "UserPromptSubmit",
      claude("UserPromptSubmit", { prompt: "do the thing" }),
    );
    expect(observed).toMatchObject({ activity: "working" });
    expect(observed?.ifNotActivity).toBeUndefined();
    expect(observed?.ifActivity).toBeUndefined();
  });

  test("PreToolUse works but may not stomp an attention state", () => {
    const observed = observeClaudeHook(
      "PreToolUse",
      claude("PreToolUse", {
        prompt_id: "52c6a247",
        tool_name: "Bash",
        tool_input: { command: "echo hello-hooks" },
        tool_use_id: "toolu_01",
      }),
    );
    expect(observed).toMatchObject({
      activity: "working",
      detail: "Bash(echo hello-hooks)",
    });
    expect(observed?.ifNotActivity).toContain("needs_permission");
  });

  test("PostToolUse is unguarded, because the tool running proves it was allowed", () => {
    const observed = observeClaudeHook(
      "PostToolUse",
      claude("PostToolUse", {
        tool_name: "Bash",
        tool_input: { command: "echo hello-hooks" },
        tool_response: { stdout: "hello-hooks" },
      }),
    );
    expect(observed).toMatchObject({ activity: "working" });
    expect(observed?.ifNotActivity).toBeUndefined();
  });

  test("Notification splits attention by notification_type", () => {
    const type = (notification_type: string) =>
      observeClaudeHook(
        "Notification",
        claude("Notification", {
          notification_type,
          message: "Claude needs your permission to use Bash",
        }),
      );
    expect(type("permission_prompt")).toMatchObject({
      activity: "needs_permission",
      detail: "Claude needs your permission to use Bash",
    });
    // The idle notice repeats what `Stop` already decided a minute earlier.
    expect(type("idle_prompt")).toBeUndefined();
    expect(type("agent_needs_input")).toMatchObject({
      activity: "needs_input",
    });
    expect(type("agent_completed")).toMatchObject({ activity: "done" });
    // An unrecognised notification is not an activity; guessing would be worse
    // than staying quiet.
    expect(type("something_new")).toBeUndefined();
  });

  test("asking a question is needs_input, not needs_permission", () => {
    // AskUserQuestion arrives through the permission machinery because it is a
    // tool, but "answer this question" and "approve this command" are
    // different requests and the badge has to say which one it is.
    const toolInput = {
      questions: [
        {
          question: "What would you like me to do in this workspace?",
          header: "Next step",
          options: [{ label: "Explore the repos" }],
        },
      ],
    };
    for (const event of ["PermissionRequest", "PreToolUse"]) {
      expect(
        observeClaudeHook(
          event,
          claude(event, {
            tool_name: "AskUserQuestion",
            tool_input: toolInput,
          }),
        ),
      ).toMatchObject({
        activity: "needs_input",
        // The question itself, not the name of the tool that asked it.
        detail: "What would you like me to do in this workspace?",
      });
    }
    expect(
      observeClaudeHook(
        "Notification",
        claude("Notification", {
          notification_type: "permission_prompt",
          message: "Claude needs your permission to use AskUserQuestion",
          tool_name: "AskUserQuestion",
          tool_input: toolInput,
        }),
      ),
    ).toMatchObject({ activity: "needs_input" });
  });

  test("a real tool permission is still a permission", () => {
    expect(
      observeClaudeHook(
        "PermissionRequest",
        claude("PermissionRequest", {
          tool_name: "Bash",
          tool_input: { command: "git push" },
        }),
      ),
    ).toMatchObject({ activity: "needs_permission", detail: "Bash(git push)" });
  });

  test("PermissionRequest reports the tool it is blocked on", () => {
    expect(
      observeClaudeHook(
        "PermissionRequest",
        claude("PermissionRequest", {
          tool_name: "Bash",
          tool_input: { command: "git push" },
        }),
      ),
    ).toMatchObject({ activity: "needs_permission", detail: "Bash(git push)" });
  });

  test("Stop only finishes a turn that was actually running", () => {
    const observed = observeClaudeHook(
      "Stop",
      claude("Stop", {
        stop_hook_active: false,
        last_assistant_message: "Output: `hello-hooks`",
      }),
    );
    expect(observed).toMatchObject({
      activity: "done",
      detail: "Output: `hello-hooks`",
    });
    // `idle` too: the pane can read the new `done` line before this lands.
    expect(observed?.ifActivity).toEqual([
      "working",
      "unknown",
      "error",
      "idle",
    ]);
  });

  test("Stop never reads the message for a question", () => {
    // Prose is not a signal. A question that needs the user arrives through
    // AskUserQuestion, a permission dialog, or `daedal attention`.
    expect(
      observeClaudeHook(
        "Stop",
        claude("Stop", {
          last_assistant_message: "Built the parser.\n\nShould I build A?",
        }),
      ),
    ).toMatchObject({
      activity: "done",
      detail: "Built the parser. Should I build A?",
    });
  });

  test("a session holding routines ends its turns idle", () => {
    const stop = (last_assistant_message: string) =>
      observeClaudeHook("Stop", claude("Stop", { last_assistant_message }), {
        routines: true,
      });
    expect(stop("Nothing new today.")).toMatchObject({ activity: "idle" });
  });

  test("StopFailure carries the error and SessionEnd clears", () => {
    expect(
      observeClaudeHook(
        "StopFailure",
        claude("StopFailure", {
          error: "overloaded_error",
        }),
      ),
    ).toMatchObject({ activity: "error", detail: "overloaded_error" });
    expect(
      observeClaudeHook(
        "SessionEnd",
        claude("SessionEnd", {
          reason: "other",
        }),
      ),
    ).toMatchObject({ clear: true });
  });

  test("PreCompact is work, not a pause", () => {
    expect(observeClaudeHook("PreCompact", claude("PreCompact"))).toMatchObject(
      {
        activity: "working",
        detail: "Compacting context",
      },
    );
  });

  test("subagent events only keep a working parent alive", () => {
    // Never a new reading, so the parent does not flap; only proof that its
    // turn is still running, so a long foreground subagent cannot decay it.
    const heartbeat = {
      activity: "working",
      heartbeat: true,
      ifActivity: ["working"],
    };
    const subagentStop = observeClaudeHook(
      "SubagentStop",
      claude("SubagentStop", { agent_id: "sub-1" }),
    );
    expect(subagentStop).toMatchObject(heartbeat);
    expect(subagentStop?.detail).toBeUndefined();
    // A tool call made by a subagent carries the same tell.
    expect(
      observeClaudeHook(
        "PreToolUse",
        claude("PreToolUse", {
          agent_id: "sub-1",
          tool_name: "Bash",
        }),
      ),
    ).toMatchObject(heartbeat);
  });

  test("an unknown event is ignored rather than guessed at", () => {
    expect(
      observeClaudeHook("SomethingNew", claude("SomethingNew")),
    ).toBeUndefined();
  });
});

const codex = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: "01a0ae20-2ae5-7441-b956-684136b05897",
  turn_id: "01a0ae20-5229-7310-9cd8-120910533e80",
  transcript_path: "/tmp/rollout.jsonl",
  cwd: "/tmp/work",
  hook_event_name: event,
  model: "gpt-5.6-sol",
  permission_mode: "default",
  ...extra,
});

describe("Claude background agents", () => {
  // Shaped like the #46 transcript that raised a false "needs you": an
  // `Agent` launch, the turn ending, then the report queued five minutes on.
  const now = Date.parse("2026-09-30T09:05:06.000Z");
  const launch = (agentId: string, timestamp = "2026-09-30T09:03:52.275Z") =>
    JSON.stringify({
      type: "user",
      isSidechain: false,
      timestamp,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [
              { type: "text", text: "Async agent launched successfully." },
            ],
          },
        ],
      },
      toolUseResult: {
        isAsync: true,
        status: "async_launched",
        agentId,
        description: "Map daedalus for on-call agent plan",
      },
    });
  const notification = (agentId: string) =>
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-09-30T09:08:43.894Z",
      content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n</task-notification>`,
    });
  const handBack = (agentId: string) =>
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-09-30T09:08:30.591Z",
      content: `<agent-message from="${agentId}">\n[Subagent hand-back] report\n</agent-message>`,
    });
  const collected = (agentId: string, status: string) =>
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-30T09:04:30.000Z",
      toolUseResult: {
        retrieval_status: status === "running" ? "timeout" : "success",
        task: { task_id: agentId, task_type: "local_agent", status },
      },
    });
  const stop = {
    last_assistant_message: "I'll write the plan when it reports.",
  };

  test("a launch with no report yet is pending", () => {
    expect(pendingBackgroundAgents(launch("a1"), now)).toBe(1);
    expect(
      pendingBackgroundAgents([launch("a1"), launch("a2")].join("\n"), now),
    ).toBe(2);
  });

  test("any of the three reports settles it", () => {
    for (const report of [
      notification("a1"),
      handBack("a1"),
      collected("a1", "completed"),
    ])
      expect(
        pendingBackgroundAgents([launch("a1"), report].join("\n"), now),
      ).toBe(0);
    // Asking for the output of a task still running settles nothing.
    expect(
      pendingBackgroundAgents(
        [launch("a1"), collected("a1", "running")].join("\n"),
        now,
      ),
    ).toBe(1);
  });

  test("conversation text that quotes the tags settles nothing", () => {
    const quoted = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "<task-id>a1</task-id>" }] },
    });
    expect(
      pendingBackgroundAgents([launch("a1"), quoted].join("\n"), now),
    ).toBe(1);
  });

  test("a launch nobody reported for hours is presumed dead", () => {
    // What a crash or resume under a running agent leaves behind; counting it
    // forever would silence the idle alert for the rest of the conversation.
    expect(
      pendingBackgroundAgents(launch("a1", "2026-09-30T05:00:00.000Z"), now),
    ).toBe(0);
  });

  test("a truncated tail and unrelated lines are skipped", () => {
    expect(
      pendingBackgroundAgents(
        ['ync_launched","agentId":"a0"}', "not json", launch("a1")].join("\n"),
        now,
      ),
    ).toBe(1);
  });

  test("Stop with an agent out reads as working, not as a finished turn", () => {
    expect(
      observeClaudeHook("Stop", claude("Stop", stop), { backgroundAgents: 1 }),
    ).toMatchObject({
      activity: "working",
      detail: "Waiting for 1 background agent",
      ifActivity: ["working", "unknown", "error"],
    });
    expect(
      observeClaudeHook("Stop", claude("Stop", stop), { backgroundAgents: 2 })
        ?.detail,
    ).toBe("Waiting for 2 background agents");
    expect(observeClaudeHook("Stop", claude("Stop", stop))).toMatchObject({
      activity: "done",
    });
  });

  test("the idle notice raises no badge, agent out or not", () => {
    const idle = claude("Notification", {
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    });
    expect(
      observeClaudeHook("Notification", idle, { backgroundAgents: 1 }),
    ).toBeUndefined();
    expect(observeClaudeHook("Notification", idle)).toBeUndefined();
    // A real permission dialog still needs the user, agent or no agent.
    expect(
      observeClaudeHook(
        "Notification",
        claude("Notification", {
          notification_type: "permission_prompt",
          message: "Claude needs your permission to use Bash",
        }),
        { backgroundAgents: 1 },
      ),
    ).toMatchObject({ activity: "needs_permission" });
  });
});

describe("Codex hook payloads", () => {
  test("the thread-title side turn does not end the turn", () => {
    expect(
      observeCodexHook(
        "Stop",
        codex("Stop", { last_assistant_message: '{"title":"Run echo hi"}' }),
      ),
    ).toBeUndefined();
    expect(
      observeCodexHook(
        "Stop",
        codex("Stop", {
          last_assistant_message: '{"title":"Plan","steps":["one"]}',
        }),
      ),
    ).toMatchObject({ activity: "done" });
  });

  test("a tool approval wait is needs_permission", () => {
    expect(
      observeCodexHook(
        "PermissionRequest",
        codex("PermissionRequest", {
          tool_name: "Bash",
          tool_input: { command: "rm -rf build" },
        }),
      ),
    ).toMatchObject({
      activity: "needs_permission",
      detail: "Bash(rm -rf build)",
      source: "hook",
    });
  });

  test("Codex reports the question text rather than the tool call", () => {
    expect(
      observeCodexHook(
        "PermissionRequest",
        codex("PermissionRequest", {
          tool_name: "request_user_input",
          tool_input: { question: "Which branch should I base this on?" },
        }),
      ),
    ).toMatchObject({
      activity: "needs_input",
      detail: "Which branch should I base this on?",
    });
  });

  test("request_user_input is a question, not a permission", () => {
    // This distinction is the entire reason that tool is in the matcher: the
    // two states mean different things to the person being waited on.
    for (const name of [
      "request_user_input",
      "functions.request_user_input",
      "request_user_input_async",
    ]) {
      expect(
        observeCodexHook(
          "PermissionRequest",
          codex("PermissionRequest", {
            tool_name: name,
            tool_input: { question: "Which branch?" },
          }),
        ),
      ).toMatchObject({ activity: "needs_input" });
      // An auto-approved question never reaches PermissionRequest, so it has
      // to be caught on PreToolUse as well.
      expect(
        observeCodexHook(
          "PreToolUse",
          codex("PreToolUse", {
            tool_name: name,
            tool_input: { question: "Which branch?" },
          }),
        ),
      ).toMatchObject({ activity: "needs_input" });
    }
  });

  test("Stop is done, or idle in a session holding routines", () => {
    expect(
      observeCodexHook(
        "Stop",
        codex("Stop", { last_assistant_message: "Tests pass." }),
      ),
    ).toMatchObject({ activity: "done", detail: "Tests pass." });
    expect(
      observeCodexHook(
        "Stop",
        codex("Stop", { last_assistant_message: "Which branch?" }),
        { routines: true },
      ),
    ).toMatchObject({ activity: "idle" });
  });

  test("Interrupt has no Claude equivalent and lands on idle", () => {
    expect(observeCodexHook("Interrupt", codex("Interrupt"))).toMatchObject({
      activity: "idle",
      detail: "Interrupted",
    });
  });

  test("the internal agent that runs beside a conversation is ignored", () => {
    expect(
      observeCodexHook("Stop", codex("Stop", { agent_type: "title" })),
    ).toBeUndefined();
  });
});

describe("codexHookInSession", () => {
  const folder = "/Users/x/.daedalus/workspaces/w/worktrees/t/codex-1";

  test("a thread in the session's folder belongs to it", () => {
    expect(codexHookInSession(folder, folder)).toBe(true);
    expect(codexHookInSession(`${folder}/repo`, folder)).toBe(true);
  });

  test("a thread elsewhere on the shared app server does not", () => {
    // The user's own Codex, run while the server carried this session's
    // environment.
    expect(codexHookInSession("/Users/x/code/app", folder)).toBe(false);
    expect(codexHookInSession(`${folder}-2`, folder)).toBe(false);
  });

  test("a session launched before sessions carried their folder is believed", () => {
    expect(codexHookInSession("/Users/x/code/app", undefined)).toBe(true);
    expect(codexHookInSession(undefined, folder)).toBe(true);
  });
});

describe("Codex rollout fallback", () => {
  const line = (payload: Record<string, unknown>) =>
    JSON.stringify({ type: "event_msg", payload });

  test("task_started is working and task_complete is done, as from the hook", () => {
    expect(observeCodexRollout(line({ type: "task_started" }))).toMatchObject({
      activity: "working",
      source: "transcript",
    });
    expect(observeCodexRollout(line({ type: "task_complete" }))).toMatchObject({
      activity: "done",
      source: "transcript",
    });
  });

  test("turn_aborted reads as an interruption", () => {
    expect(observeCodexRollout(line({ type: "turn_aborted" }))).toMatchObject({
      activity: "idle",
      detail: "Interrupted",
    });
  });

  test("the newest state wins and a later message supplies its detail", () => {
    const text = [
      line({ type: "task_complete" }),
      line({ type: "task_started" }),
      line({ type: "agent_message", message: "Reading the config" }),
    ].join("\n");
    expect(observeCodexRollout(text)).toMatchObject({
      activity: "working",
      detail: "Reading the config",
    });
  });

  test("a truncated leading line is expected when reading a tail", () => {
    const text = `{"type":"event_msg","pay\n${line({ type: "task_started" })}`;
    expect(observeCodexRollout(text)).toMatchObject({ activity: "working" });
  });

  test("a rollout with no state-bearing event is no observation", () => {
    expect(observeCodexRollout(line({ type: "token_count" }))).toBeUndefined();
    expect(observeCodexRollout("")).toBeUndefined();
  });
});

/**
 * Real entries, trimmed of the fields the reader never looks at, from a
 * Claude Code 2.1.272 transcript. The bookkeeping that follows an interrupt is
 * the point of the fixture: it is what a reader that simply took the last line
 * would see instead.
 */
describe("Claude transcript fallback", () => {
  const interrupted = (
    text = "[Request interrupted by user]",
    extra: Record<string, unknown> = {},
  ) =>
    JSON.stringify({
      type: "user",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text }] },
      ...extra,
    });
  const bookkeeping = [
    JSON.stringify({ type: "system", isMeta: false }),
    JSON.stringify({ type: "file-history-snapshot" }),
    JSON.stringify({ type: "last-prompt" }),
  ];
  const assistant = JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
  });

  test("an interrupted turn is idle, and outranks the hook that pinned it", () => {
    // Claude fires no hook for escape, so this reading has no higher tier to
    // defer to and must be allowed past the `working` its PreToolUse wrote.
    expect(observeClaudeTranscript(interrupted())).toMatchObject({
      activity: "idle",
      source: "transcript",
      detail: "Interrupted",
      authoritative: true,
    });
    expect(
      observeClaudeTranscript(
        interrupted("[Request interrupted by user for tool use]"),
      ),
    ).toMatchObject({ activity: "idle", detail: "Interrupted" });
  });

  test("the bookkeeping Claude writes after an interrupt does not hide it", () => {
    expect(
      observeClaudeTranscript([interrupted(), ...bookkeeping].join("\n")),
    ).toMatchObject({ activity: "idle", detail: "Interrupted" });
  });

  test("an interrupt the user has already answered is history", () => {
    const text = [
      interrupted(),
      ...bookkeeping,
      JSON.stringify({
        type: "user",
        isSidechain: false,
        message: { role: "user", content: "try that again" },
      }),
    ].join("\n");
    expect(observeClaudeTranscript(text)).toBeUndefined();
  });

  test("subagent turns are invisible, so one cannot mask the parent's interrupt", () => {
    const text = [
      interrupted(),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "..." }],
        },
      }),
    ].join("\n");
    expect(observeClaudeTranscript(text)).toMatchObject({ activity: "idle" });
  });

  test("a transcript that only says the turn is running is no observation", () => {
    // A Claude transcript cannot tell a finished turn from a streaming one —
    // the last entry is an assistant message either way — so it says nothing
    // rather than fabricating `working`.
    expect(observeClaudeTranscript(assistant)).toBeUndefined();
    expect(observeClaudeTranscript("")).toBeUndefined();
    expect(observeClaudeTranscript(bookkeeping.join("\n"))).toBeUndefined();
  });

  test("a truncated leading line is expected when reading a tail", () => {
    expect(
      observeClaudeTranscript(`{"type":"user","mess\n${interrupted()}`),
    ).toMatchObject({ activity: "idle" });
  });
});

/**
 * Real `capture-pane` output, taken from live sessions on this machine. The
 * five different verbs are the point: they were all on screen at the same
 * moment, which is why neither pattern may key on the word.
 */
describe("Claude pane fallback", () => {
  const box = [
    "──────────────────────────────────────── Test22 ─",
    "❯ ",
    "─────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    "                    Update available! Run: brew upgrade claude-code@latest",
  ];
  const pane = (status: string, trailing: string[] = []) =>
    ["⏺ Some earlier output", status, ...trailing, ...box].join("\n");

  test("a done line retracts working, whatever the verb happens to be", () => {
    for (const status of [
      "✻ Brewed for 3s · done 6:35 PM",
      "✻ Worked for 4m 56s · done 12:35 PM",
      "✻ Crunched for 10m 37s · done 1:32 PM",
      "✻ Sautéed for 3m 8s · done 3:07 PM",
      "✻ Baked for 7m 26s · done 8:24 PM",
    ])
      expect(observeClaudePane(pane(status))).toMatchObject({
        activity: "idle",
        source: "pane",
        // It may retract a working reading and do nothing else — never invent
        // work, never speak for a session that is blocked on the user.
        ifActivity: ["working"],
        authoritative: true,
      });
  });

  test("an interrupted turn leaves no done line, only Claude's own notice", () => {
    // Captured after escaping a live generation: there is no `done` status
    // line at all, which is why matching only that missed the reported bug.
    const text = [
      "  as easily as a few dozen letters, and the",
      "  ⎿  Interrupted · What should Claude do instead?",
      "──────────────────────────────── test ─",
      "❯ ",
      "  ⏵⏵ auto mode on · 1 shell",
    ].join("\n");
    expect(observeClaudePane(text)).toMatchObject({
      activity: "idle",
      source: "pane",
      detail: "Interrupted",
      ifActivity: ["working"],
    });
  });

  test("an interrupt in the scrollback loses to the turn that came after it", () => {
    const text = [
      "  ⎿  Interrupted · What should Claude do instead?",
      "❯ have another go",
      "✽ Generating… (14s · ↓ 900 tokens)",
      "──────────────────────────────── test ─",
    ].join("\n");
    expect(observeClaudePane(text)).toMatchObject({ heartbeat: true });
  });

  test("a live timer keeps working alive and retracts nothing", () => {
    for (const status of [
      "✽ Generating… (6m 17s · ↓ 24.8k tokens)",
      "· Generating… (6m 26s · ↓ 25.2k tokens)",
      "✢ Thinking… (3s)",
    ])
      expect(observeClaudePane(pane(status))).toEqual({
        activity: "working",
        source: "pane",
        heartbeat: true,
        ifActivity: ["working"],
      });
  });

  test("the newest status line wins, so a stale done never reads past a timer", () => {
    const text = [
      "✻ Brewed for 3s · done 6:35 PM",
      "❯ next thing",
      "✽ Generating… (12s · ↓ 1.1k tokens)",
      ...box,
    ].join("\n");
    expect(observeClaudePane(text)).toMatchObject({ heartbeat: true });
  });

  test("output that merely talks about a status line is not one", () => {
    // This very session had `done 6:35 PM` inside its own transcript while
    // working. Indented continuations and tool results are not status lines.
    expect(
      observeClaudePane(
        pane("✽ Generating… (5m 29s · ↓ 21.8k tokens)", [
          "  ⎿  │ idle │ ✻ Brewed for 3s · done 6:35 PM │",
        ]),
      ),
    ).toMatchObject({ heartbeat: true });
    expect(
      observeClaudePane(
        ["  ⎿  ✻ Brewed for 3s · done 6:35 PM", ...box].join("\n"),
      ),
    ).toBeUndefined();
  });

  test("waiting on a background agent is work, so an older done stays unread", () => {
    const text = [
      "✻ Brewed for 3s · done 9:01 AM",
      "❯ execute task #46",
      "⏺ I'll write the plan when it reports.",
      "✻ Waiting for 1 background agent to finish",
      ...box,
    ].join("\n");
    expect(observeClaudePane(text)).toMatchObject({ heartbeat: true });
  });

  test("a turn that has only just started is not read as finished", () => {
    // Captured in the first half second of a turn, before the timer is drawn.
    const starting = [
      "✻ Cogitated for 3s · done 9:12 PM",
      "❯ write a 300 word story about tortoises",
      "✻ Schlepping…",
      ...box,
    ].join("\n");
    expect(observeClaudePane(starting)).toMatchObject({ heartbeat: true });
    // And while the answer streams, when no status line shows at all.
    const streaming = [
      "✻ Cogitated for 3s · done 9:12 PM",
      "❯ write a 300 word story about tortoises",
      "  Thought for 1s",
      "⏺ The Slow Journey",
      ...box,
    ].join("\n");
    expect(observeClaudePane(streaming)).toBeUndefined();
  });

  test("an instant escape puts the prompt back in the box, so done still counts", () => {
    // Captured after escaping 0.3s into a turn: no echo above the box, and
    // the prompt sits in the input box between the two rules.
    const escaped = [
      "✻ Cogitated for 7s · done 9:12 PM",
      "──────────────────────────────────────── test ─",
      "❯ write a 100 word poem",
      "─────────────────────────────────────────────────",
      "  ⏸ manual mode on",
    ].join("\n");
    expect(observeClaudePane(escaped)).toMatchObject({
      activity: "idle",
      ifActivity: ["working"],
    });
  });

  test("a pane with no status line at all is no observation", () => {
    expect(observeClaudePane(box.join("\n"))).toBeUndefined();
    expect(observeClaudePane("")).toBeUndefined();
  });
});

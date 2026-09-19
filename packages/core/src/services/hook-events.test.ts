import { describe, expect, test } from "vitest";
import {
  observeClaudeHook,
  observeClaudeTranscript,
  observeCodexHook,
  observeCodexRollout,
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
    expect(type("idle_prompt")).toMatchObject({ activity: "needs_input" });
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
      activity: "idle",
      detail: "Output: `hello-hooks`",
    });
    expect(observed?.ifActivity).toEqual(["working", "unknown", "error"]);
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

  test("subagent events are invisible so the parent does not flap", () => {
    expect(
      observeClaudeHook(
        "SubagentStop",
        claude("SubagentStop", {
          agent_id: "sub-1",
        }),
      ),
    ).toBeUndefined();
    // A tool call made by a subagent carries the same tell.
    expect(
      observeClaudeHook(
        "PreToolUse",
        claude("PreToolUse", {
          agent_id: "sub-1",
          tool_name: "Bash",
        }),
      ),
    ).toBeUndefined();
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

describe("Codex hook payloads", () => {
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

describe("Codex rollout fallback", () => {
  const line = (payload: Record<string, unknown>) =>
    JSON.stringify({ type: "event_msg", payload });

  test("task_started is working and task_complete is idle, never done", () => {
    expect(observeCodexRollout(line({ type: "task_started" }))).toMatchObject({
      activity: "working",
      source: "transcript",
    });
    // "The turn ended" is not "the work is finished"; reporting `done` here
    // would claim something the rollout never says.
    expect(observeCodexRollout(line({ type: "task_complete" }))).toMatchObject({
      activity: "idle",
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

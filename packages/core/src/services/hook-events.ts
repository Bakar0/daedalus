import type { AgentActivity, AgentActivitySource } from "../domain";

/**
 * One reading of a provider hook payload. Detectors produce these; nothing
 * here touches SQLite, the filesystem, or a clock, so the whole mapping is
 * testable against a captured payload.
 *
 * The guards are the heart of it. Hooks fire concurrently and arrive out of
 * order, so every transition is conditional rather than absolute: routine
 * activity must never stomp a state that means "the user is the thing in the
 * way", and a turn-end may only finish a turn that was actually running.
 */
export interface ActivityObservation {
  activity: AgentActivity;
  detail?: string;
  source: AgentActivitySource;
  /** Apply only when the stored activity is one of these. */
  ifActivity?: readonly AgentActivity[];
  /** Skip when the stored activity is one of these. */
  ifNotActivity?: readonly AgentActivity[];
  /**
   * Exempts this reading from the source ranking.
   *
   * Ranking exists to stop a *guess* overwriting a fact, and an interrupt is
   * not a guess: the provider wrote it into its own transcript. It is also the
   * one reading with no higher tier to defer to — neither provider fires a
   * hook when the user presses escape — so without this the observation would
   * be dead code, rejected by exactly the fresh `working` hook it exists to
   * correct.
   */
  authoritative?: boolean;
  /** Drops the record entirely; lifecycle takes over from here. */
  clear?: boolean;
}

/**
 * Attention is the user's problem to solve, so nothing routine may overwrite
 * it. Only an event that proves the block is over — the tool actually ran, or
 * the user submitted a new prompt — is allowed through unguarded.
 */
const ATTENTION: readonly AgentActivity[] = ["needs_permission", "needs_input"];

/**
 * A turn can only end if it had started. Without this a late `Stop` from an
 * abandoned turn reports idle while the next turn is already working.
 */
const RUNNING: readonly AgentActivity[] = ["working", "unknown", "error"];

const MAX_DETAIL = 120;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const shorten = (value: string): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat;
};

const basename = (value: string): string =>
  value.slice(value.lastIndexOf("/") + 1) || value;

/**
 * "Bash(git push)", "Edit(agents.ts)" — the detail line is read at a glance in
 * a session row, so it names the thing being acted on rather than echoing the
 * whole tool input.
 */
export function summarizeTool(
  toolName: string | undefined,
  toolInput: unknown,
): string | undefined {
  const name = text(toolName);
  if (!name) return undefined;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const argument =
    text(input.command) ??
    text(input.description) ??
    (text(input.file_path) ? basename(text(input.file_path)!) : undefined) ??
    (text(input.path) ? basename(text(input.path)!) : undefined) ??
    text(input.pattern) ??
    text(input.query) ??
    text(input.prompt) ??
    text(input.question) ??
    // An MCP tool's arguments are arbitrary; the first string is still a far
    // better label than the bare tool name.
    Object.values(input).find(
      (value): value is string => typeof value === "string" && !!value.trim(),
    );
  return argument ? shorten(`${name}(${argument})`) : name;
}

/**
 * Both providers ask the user a question by calling a tool, which means the
 * hook that reports a permission wait is the same one that reports a question.
 * Telling them apart matters to the person being waited on: "approve this
 * command" and "answer this question" are different requests, and a session
 * that is really asking something should not claim it wants a tool approved.
 *
 * Claude's is `AskUserQuestion`; Codex's is `request_user_input`, which is why
 * dev-3.0 puts it in the tool matcher.
 */
export const CLAUDE_ASK_TOOL = /^AskUserQuestion$/;

export const CODEX_ASK_TOOL = /^(?:functions\.)?request_user_input(?:_async)?$/;

/**
 * The question itself, when the tool carries one. "Which branch should I use?"
 * is worth waking someone for; "AskUserQuestion" is not.
 */
export function askSummary(toolInput: unknown): string | undefined {
  const input = (toolInput ?? {}) as {
    questions?: Array<{ question?: unknown; header?: unknown }>;
    question?: unknown;
    prompt?: unknown;
  };
  const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
  const question =
    text(first?.question) ??
    text(first?.header) ??
    text(input.question) ??
    text(input.prompt);
  return question ? shorten(question) : undefined;
}

/**
 * Subagent chatter is deliberately invisible. A parent that flips to working
 * every time a subagent picks up a tool tells the user nothing they did not
 * already know, and hides the parent's real state while it does.
 */
const isSubagentPayload = (payload: Record<string, unknown>): boolean =>
  Boolean(text(payload.agent_id) ?? text(payload.agent_type)) ||
  String(payload.hook_event_name ?? "").startsWith("Subagent");

/**
 * Claude Code hook payloads, verified against Claude Code 2.1.272. The
 * `Notification` event is the one that matters most: it is what fires when an
 * interactive session puts a permission dialog on screen, which is the only
 * way to light the badge with no cooperation from the agent at all.
 */
export function observeClaudeHook(
  event: string,
  payload: Record<string, unknown>,
): ActivityObservation | undefined {
  if (isSubagentPayload(payload)) return undefined;
  const source: AgentActivitySource = "hook";
  const toolName = text(payload.tool_name);
  const tool = summarizeTool(toolName, payload.tool_input);
  const asking = toolName ? CLAUDE_ASK_TOOL.test(toolName) : false;
  const ask = asking ? askSummary(payload.tool_input) : undefined;
  switch (event) {
    case "SessionStart":
      return { activity: "idle", source };
    case "UserPromptSubmit":
      // The user is demonstrably back, so this is the one routine event that
      // is allowed to retract a badge.
      return { activity: "working", source };
    case "PreToolUse":
      // A question the user already allowed never reaches PermissionRequest,
      // so it has to be caught here too or an auto-approved question reads as
      // ordinary work and nobody is told they are being waited on.
      return asking
        ? { activity: "needs_input", source, ...(ask ? { detail: ask } : {}) }
        : {
            activity: "working",
            source,
            ...(tool ? { detail: tool } : {}),
            ifNotActivity: ATTENTION,
          };
    case "PostToolUse":
      // The tool ran, so whatever it was blocked on has been answered.
      return { activity: "working", source, ...(tool ? { detail: tool } : {}) };
    case "PermissionRequest":
      return {
        activity: asking ? "needs_input" : "needs_permission",
        source,
        ...(asking && ask ? { detail: ask } : tool ? { detail: tool } : {}),
      };
    case "Notification": {
      const message = text(payload.message);
      switch (text(payload.notification_type)) {
        case "permission_prompt":
          // `Notification` is the dialog going up, not what put it there: it
          // carries no tool name, so it cannot tell a question apart from a
          // command needing approval. `PermissionRequest` can, and fires for
          // the same wait. So this never downgrades a question that the
          // specific hook already identified — otherwise asking something
          // reads as "needs permission" purely because the vaguer hook
          // happened to arrive second.
          return asking
            ? {
                activity: "needs_input",
                source,
                detail: ask ?? shorten(message ?? "Waiting for your answer"),
              }
            : {
                activity: "needs_permission",
                source,
                detail: shorten(message ?? tool ?? "Waiting for permission"),
                ifNotActivity: ["needs_input"],
              };
        case "idle_prompt":
        case "agent_needs_input":
          return {
            activity: "needs_input",
            source,
            detail: shorten(message ?? "Waiting for your answer"),
          };
        case "agent_completed":
          return {
            activity: "done",
            source,
            ...(message ? { detail: shorten(message) } : {}),
          };
        default:
          return undefined;
      }
    }
    case "Stop": {
      const last = text(payload.last_assistant_message);
      return {
        activity: "idle",
        source,
        ...(last ? { detail: shorten(last) } : {}),
        ifActivity: RUNNING,
      };
    }
    case "StopFailure":
      return {
        activity: "error",
        source,
        detail: shorten(text(payload.error) ?? "The turn failed"),
      };
    case "PreCompact":
      return { activity: "working", source, detail: "Compacting context" };
    case "SessionEnd":
      return { activity: "unknown", source, clear: true };
    default:
      return undefined;
  }
}

/**
 * Codex hook payloads, verified against codex-cli 0.154.0. The event set is
 * near-identical to Claude's, which is why both providers land on the same
 * observation shape rather than each growing its own vocabulary.
 */
export function observeCodexHook(
  event: string,
  payload: Record<string, unknown>,
): ActivityObservation | undefined {
  if (isSubagentPayload(payload)) return undefined;
  const source: AgentActivitySource = "hook";
  const toolName = text(payload.tool_name);
  const tool = summarizeTool(toolName, payload.tool_input);
  const asking = toolName ? CODEX_ASK_TOOL.test(toolName) : false;
  const ask = asking ? askSummary(payload.tool_input) : undefined;
  switch (event) {
    case "SessionStart":
      return { activity: "idle", source };
    case "UserPromptSubmit":
      return { activity: "working", source };
    case "PreToolUse":
      // A question arrives as a tool call, so it has to be caught here as well
      // as on PermissionRequest; otherwise an auto-approved question reads as
      // ordinary work and the user is never told they are being waited on.
      return asking
        ? {
            activity: "needs_input",
            source,
            ...((ask ?? tool) ? { detail: ask ?? tool! } : {}),
          }
        : {
            activity: "working",
            source,
            ...(tool ? { detail: tool } : {}),
            ifNotActivity: ATTENTION,
          };
    case "PermissionRequest":
      return {
        activity: asking ? "needs_input" : "needs_permission",
        ...(asking && ask ? { detail: ask } : tool ? { detail: tool } : {}),
        source,
      };
    case "PostToolUse":
      return { activity: "working", source, ...(tool ? { detail: tool } : {}) };
    case "PreCompact":
    case "PostCompact":
      return { activity: "working", source, detail: "Compacting context" };
    case "Stop": {
      const last = text(payload.last_assistant_message);
      return {
        activity: "idle",
        source,
        ...(last ? { detail: shorten(last) } : {}),
        ifActivity: RUNNING,
      };
    }
    case "Interrupt":
      // Codex's Interrupt has no Claude equivalent. The turn is over and
      // nothing is blocked, so it retracts a badge the way a new prompt does.
      return { activity: "idle", source, detail: "Interrupted" };
    case "SessionEnd":
      return { activity: "unknown", source, clear: true };
    default:
      return undefined;
  }
}

/**
 * The floor for Codex builds whose hooks are unavailable or untrusted: the
 * rollout JSONL that `readCodexSession` already tails for token counts.
 *
 * Approvals never reach the rollout, so this tier genuinely cannot report
 * `needs_permission`. That limitation is the whole reason hooks are the
 * primary path, and reporting `working` for a session that is actually waiting
 * would be the worst outcome available — hence `task_complete` maps to `idle`
 * and never to `done`. "The turn ended" is not "the work is finished".
 */
export function observeCodexRollout(
  text_: string,
): ActivityObservation | undefined {
  const lines = text_.trimEnd().split("\n");
  let detail: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let event: {
      type?: unknown;
      payload?: { type?: unknown; message?: unknown; item?: unknown };
    };
    try {
      event = JSON.parse(lines[index]!);
    } catch {
      // A truncated first line is expected when reading a tail.
      continue;
    }
    const payload = event.payload;
    const kind = text(payload?.type);
    if (!kind) continue;
    // Walking backwards, the newest state-bearing event wins; any newer
    // message only supplies the detail line for it.
    if (kind === "agent_message" || kind === "item_completed") {
      detail ??= text(payload?.message)
        ? shorten(text(payload!.message)!)
        : undefined;
      continue;
    }
    const source: AgentActivitySource = "transcript";
    if (kind === "task_started")
      return {
        activity: "working",
        source,
        ...(detail ? { detail } : {}),
        ifNotActivity: ATTENTION,
      };
    if (kind === "task_complete")
      return {
        activity: "idle",
        source,
        ...(detail ? { detail } : {}),
        ifActivity: RUNNING,
      };
    if (kind === "turn_aborted")
      return {
        activity: "idle",
        source,
        detail: "Interrupted",
        authoritative: true,
      };
  }
  return undefined;
}

/**
 * The entry types that are the conversation. Everything else Claude writes —
 * hook records, file-history snapshots, prompt bookkeeping, attachments —
 * lands *after* an interrupt marker, so a reader that simply took the last
 * line would find bookkeeping and never see the interrupt.
 */
const CLAUDE_CONVERSATION_ENTRIES = new Set(["user", "assistant"]);

const INTERRUPTED = /^\[Request interrupted by user/;

/**
 * The tail of a Claude transcript, read for the one thing Claude's hooks do
 * not report.
 *
 * Claude has no `Interrupt` event and its `Stop` hook does not fire for a turn
 * the user ended with escape, so a session interrupted mid-tool is left on the
 * `working` its last `PreToolUse` wrote — right up until the ten-minute decay.
 * Claude does record the interrupt in its own transcript, as a user turn whose
 * text is `[Request interrupted by user]`, and that is what this reads.
 *
 * It reports nothing else on purpose. Unlike a Codex rollout, which has an
 * explicit `task_complete`, a Claude transcript cannot tell a finished turn
 * from one still streaming — the last entry is an assistant message either
 * way. Guessing `working` there would fabricate exactly the state this is
 * here to retract.
 */
export function observeClaudeTranscript(
  text_: string,
): ActivityObservation | undefined {
  const lines = text_.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: {
      type?: unknown;
      isSidechain?: unknown;
      message?: { content?: unknown };
    };
    try {
      entry = JSON.parse(lines[index]!);
    } catch {
      // A truncated first line is expected when reading a tail.
      continue;
    }
    const kind = text(entry.type);
    if (!kind || !CLAUDE_CONVERSATION_ENTRIES.has(kind)) continue;
    // Subagents write into the same transcript, and their turns are invisible
    // here for the same reason they are invisible to the hooks: a subagent
    // still running says nothing about whether the parent was interrupted.
    if (entry.isSidechain === true) continue;
    // The newest conversational entry is the whole answer. An interrupt the
    // user has already followed with a new prompt is history, and that
    // prompt's own `UserPromptSubmit` hook has already reported it.
    const content = entry.message?.content;
    const first = (
      Array.isArray(content) ? content[0] : { type: "text", text: content }
    ) as { type?: unknown; text?: unknown } | undefined;
    const body = first?.type === "text" ? text(first.text) : undefined;
    return body && INTERRUPTED.test(body)
      ? {
          activity: "idle",
          source: "transcript",
          detail: "Interrupted",
          authoritative: true,
        }
      : undefined;
  }
  return undefined;
}

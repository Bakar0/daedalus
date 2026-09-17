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
 * Codex's way of asking the user a question is a tool call, so the same hook
 * that reports a permission wait also reports a question. dev-3.0's matcher is
 * the reference; the distinction is what separates "approve this command" from
 * "answer this question" in the badge.
 */
export const CODEX_ASK_TOOL = /^(?:functions\.)?request_user_input(?:_async)?$/;

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
  const tool = summarizeTool(text(payload.tool_name), payload.tool_input);
  switch (event) {
    case "SessionStart":
      return { activity: "idle", source };
    case "UserPromptSubmit":
      // The user is demonstrably back, so this is the one routine event that
      // is allowed to retract a badge.
      return { activity: "working", source };
    case "PreToolUse":
      return {
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
        activity: "needs_permission",
        source,
        ...(tool ? { detail: tool } : {}),
      };
    case "Notification": {
      const message = text(payload.message);
      switch (text(payload.notification_type)) {
        case "permission_prompt":
          return {
            activity: "needs_permission",
            source,
            detail: shorten(message ?? tool ?? "Waiting for permission"),
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
        ? { activity: "needs_input", source, ...(tool ? { detail: tool } : {}) }
        : {
            activity: "working",
            source,
            ...(tool ? { detail: tool } : {}),
            ifNotActivity: ATTENTION,
          };
    case "PermissionRequest":
      return {
        activity: asking ? "needs_input" : "needs_permission",
        source,
        ...(tool ? { detail: tool } : {}),
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
      return { activity: "idle", source, detail: "Interrupted" };
  }
  return undefined;
}

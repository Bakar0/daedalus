import { isAbsolute, relative } from "node:path";
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
  /**
   * Evidence that the stored activity is still true, not a new reading. It
   * refreshes the timestamp the ten-minute decay reads and changes nothing
   * else: not the activity, the detail line, or the source. Applies only when
   * the stored activity is in `ifActivity`.
   */
  heartbeat?: boolean;
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

/**
 * What a turn's end may replace: a running turn, or an `idle` the pane set a
 * moment earlier. The pane is polled and `Stop` is an async hook, so the pane
 * can see the new `done` line first. Claude fires no `Stop` for an interrupted
 * turn, so this cannot turn an interrupt into `done`.
 */
const TURN_END: readonly AgentActivity[] = [...RUNNING, "idle"];

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
 * Subagent chatter never changes what the parent shows. A parent that flips to
 * working every time a subagent picks up a tool tells the user nothing they did
 * not already know, and hides the parent's real state while it does. Claude
 * still counts it as a heartbeat for a parent already `working`.
 */
const isSubagentPayload = (payload: Record<string, unknown>): boolean =>
  Boolean(text(payload.agent_id) ?? text(payload.agent_type)) ||
  String(payload.hook_event_name ?? "").startsWith("Subagent");

/**
 * How long a background agent may go unreported before it is presumed gone.
 *
 * A launch with no completion is normally an agent still running, but it is
 * also what a process that died under one leaves behind: after a crash or a
 * resume nothing will ever report it. Treating it as running forever would
 * silence the idle alert for the rest of the conversation, so past this age it
 * stops counting. Of 97 background agents in the local transcripts, all but
 * one reported within an hour. Missing the rare longer one only brings back
 * the idle alert, which is the behaviour from before this existed.
 */
export const BACKGROUND_AGENT_MAX_AGE_MS = 3 * 60 * 60_000;

/**
 * The detail on a turn that ended with background agents still out. Delivery
 * reads it to know the session is really at its prompt, so both sides go
 * through these two rather than each spelling the wording.
 */
export const backgroundWaitDetail = (count: number): string =>
  `Waiting for ${count} background agent${count === 1 ? "" : "s"}`;

export const isBackgroundWait = (detail: string | null | undefined): boolean =>
  /^Waiting for \d+ background agents?$/.test(detail ?? "");

/** The entries a background agent's report arrives in; see below. */
const TASK_ID = /<task-id>([^<]+)<\/task-id>/g;
const AGENT_MESSAGE = /<agent-message from="([^"]+)"/g;

/**
 * Counts the background agents a Claude conversation launched and has not yet
 * heard back from.
 *
 * When Claude ends a turn with one still out, it prints "Waiting for 1
 * background agent to finish" and resumes by itself when the report lands.
 * Nothing about that is the user's move, yet the hooks cannot tell: `Stop`
 * fires as for any finished turn, and sixty seconds later Claude sends the
 * same `idle_prompt` notification it sends when it really is waiting on a
 * person. The transcript can tell, so this reads it.
 *
 * A launch is the `Agent` tool result whose `toolUseResult.status` is
 * `async_launched`, which only a real launch writes. A report is any of the
 * three ways one comes back: the `<task-notification>` or the
 * `<agent-message>` hand-back Claude queues for the parent, or a `TaskOutput`
 * call that collected a finished task. Only queued entries and tool results
 * are read, never conversation text, so a transcript that merely quotes these
 * tags cannot settle an agent that is still running.
 */
export function pendingBackgroundAgents(
  text_: string,
  now = Date.now(),
): number {
  const launched = new Map<string, number>();
  const reported = new Set<string>();
  for (const line of text_.split("\n")) {
    // Most lines are none of this; parsing only the candidates keeps a
    // multi-megabyte tail cheap.
    if (
      !line.includes("async_launched") &&
      !line.includes("<task-notification>") &&
      !line.includes("<agent-message") &&
      !line.includes("retrieval_status")
    )
      continue;
    let entry: {
      type?: unknown;
      operation?: unknown;
      content?: unknown;
      timestamp?: unknown;
      attachment?: { type?: unknown; prompt?: unknown };
      toolUseResult?: {
        status?: unknown;
        agentId?: unknown;
        task?: { task_id?: unknown; status?: unknown };
      };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      // A truncated first line is expected when reading a tail.
      continue;
    }
    const result = entry.toolUseResult;
    const agentId = text(result?.agentId);
    if (result?.status === "async_launched" && agentId) {
      const at = Date.parse(String(entry.timestamp));
      launched.set(agentId, Number.isFinite(at) ? at : now);
    }
    const collected = text(result?.task?.task_id);
    if (collected && text(result?.task?.status) !== "running")
      reported.add(collected);
    const queued =
      entry.type === "queue-operation" && entry.operation === "enqueue"
        ? entry.content
        : entry.attachment?.type === "queued_command"
          ? entry.attachment.prompt
          : undefined;
    if (typeof queued !== "string") continue;
    for (const pattern of [TASK_ID, AGENT_MESSAGE])
      for (const match of queued.matchAll(pattern)) reported.add(match[1]!);
  }
  let pending = 0;
  for (const [agentId, at] of launched)
    if (!reported.has(agentId) && now - at < BACKGROUND_AGENT_MAX_AGE_MS)
      pending += 1;
  return pending;
}

/** What a hook cannot see in its own payload; the caller reads it elsewhere. */
export interface ClaudeHookContext {
  /** Background agents still out, from `pendingBackgroundAgents`. */
  backgroundAgents?: number;
  /**
   * The session holds routines. It sits at its prompt after every run, and a
   * run ending is not a result to review, so its turns end `idle`.
   */
  routines?: boolean;
}

/**
 * Where a turn that finished on its own lands: `done`, a result to look at.
 *
 * The final message is deliberately not read for questions. Telling "here is
 * what I did" from "what should I do?" in free text is a guess, and a wrong
 * Needs me teaches people to ignore it. An agent that needs the user says so
 * through a structured channel (`AskUserQuestion`, `request_user_input`, a
 * permission dialog, or `daedal attention`), and only those raise the badge.
 */
function turnEnded(
  payload: Record<string, unknown>,
  source: AgentActivitySource,
  routines: boolean,
): ActivityObservation {
  const last = text(payload.last_assistant_message);
  return {
    activity: routines ? "idle" : "done",
    source,
    ...(last ? { detail: shorten(last) } : {}),
    ifActivity: TURN_END,
  };
}

/**
 * Claude Code hook payloads, verified against Claude Code 2.1.272. The
 * `Notification` event is the one that matters most: it is what fires when an
 * interactive session puts a permission dialog on screen, which is the only
 * way to light the badge with no cooperation from the agent at all.
 */
export function observeClaudeHook(
  event: string,
  payload: Record<string, unknown>,
  context: ClaudeHookContext = {},
): ActivityObservation | undefined {
  // A subagent's own events never change what the parent shows, but they are
  // proof the parent's turn is alive. A foreground subagent can run for half
  // an hour while the parent fires nothing, and without this the parent
  // decays to `unknown` in the middle of it.
  if (isSubagentPayload(payload))
    return {
      activity: "working",
      source: "hook",
      heartbeat: true,
      ifActivity: ["working"],
    };
  const source: AgentActivitySource = "hook";
  const toolName = text(payload.tool_name);
  const tool = summarizeTool(toolName, payload.tool_input);
  const asking = toolName ? CLAUDE_ASK_TOOL.test(toolName) : false;
  const ask = asking ? askSummary(payload.tool_input) : undefined;
  const background = context.backgroundAgents ?? 0;
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
          // Claude sends this after a minute at the prompt, whatever the turn
          // ended with: a question, a finished result, or its own background
          // agents. `Stop` already told those apart when the turn ended, so
          // this says nothing new and must not overwrite it.
          return undefined;
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
      // The turn is over but the work is not: Claude resumes on its own when
      // the agent reports, which is `working` as far as the user is concerned.
      if (background > 0)
        return {
          activity: "working",
          source,
          detail: backgroundWaitDetail(background),
          ifActivity: RUNNING,
        };
      return turnEnded(payload, source, Boolean(context.routines));
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
  context: Pick<ClaudeHookContext, "routines"> = {},
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
    case "Stop":
      return isCodexTitleTurn(payload)
        ? undefined
        : turnEnded(payload, source, Boolean(context.routines));
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
 * Codex names a new thread in a side turn that runs alongside the first real
 * one and fires its own `Stop` about a second in, with a last message such as
 * `{"title":"Run echo hi"}` (seen on 0.162). Read as the end of the turn, it
 * showed a working session as done until its next tool call.
 */
function isCodexTitleTurn(payload: Record<string, unknown>): boolean {
  const last = text(payload.last_assistant_message)?.trim();
  if (!last?.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(last);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).join() === "title"
    );
  } catch {
    return false;
  }
}

/**
 * Whether a Codex hook came from the session it claims to be.
 *
 * Codex's shared app server runs the hooks of every thread it hosts with the
 * environment of whichever process started it. That process may have been a
 * Daedalus session, so `DAEDALUS_SESSION_ID` there names a session that has
 * nothing to do with the thread, and the user's own Codex in a terminal would
 * report as that session. Every Daedalus session has a folder nothing else
 * uses, so a thread working outside it is not the session's. Both paths must
 * already be resolved. With either one missing the hook is believed, as it
 * was before sessions carried their folder.
 */
export function codexHookInSession(
  cwd: string | undefined,
  sessionDirectory: string | undefined,
): boolean {
  if (!cwd || !sessionDirectory) return true;
  const inside = relative(sessionDirectory, cwd);
  return !inside.startsWith("..") && !isAbsolute(inside);
}

/**
 * The floor for Codex builds whose hooks are unavailable or untrusted: the
 * rollout JSONL that `readCodexSession` already tails for token counts.
 *
 * Approvals never reach the rollout, so this tier genuinely cannot report
 * `needs_permission`. That limitation is the whole reason hooks are the
 * primary path, and reporting `working` for a session that is actually waiting
 * would be the worst outcome available. `task_complete` maps to `done`, the
 * same as the `Stop` hook, so a session reads the same whichever tier saw the
 * turn end.
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
        activity: "done",
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

/**
 * Claude's live status line, as it appears at the foot of the pane.
 *
 * The verb is randomised — `Worked`, `Crunched`, `Sautéed`, `Baked`, `Brewed`
 * were all on this machine at once — so neither pattern may key on
 * vocabulary. What is invariant is the shape: a finished turn ends in
 * `· done <clock>`, and a live one carries a parenthesised elapsed timer.
 *
 * Both require the line to *start* with a single glyph and a space, which is
 * what the status line looks like and what ordinary output does not: tool
 * results and continuations are indented, so a transcript that merely
 * discusses these strings cannot be mistaken for the status line itself.
 */
const CLAUDE_PANE_DONE = /^\S .*·\s+done\s+\d{1,2}:\d{2}(?:\s*[AP]M)?$/;

/**
 * What an *interrupted* turn leaves behind, which is not a `done` line at all
 * — Claude replaces the status line with this and waits. It is the only mark
 * an instant escape makes anywhere, so the pane tier exists mostly for it.
 *
 * Anchored to the result glyph rather than the word: `Interrupted` on its own
 * appears in ordinary prose, and this session's own output proved it.
 */
const CLAUDE_PANE_INTERRUPTED = /^\s*⎿\s+Interrupted\b/;

const CLAUDE_PANE_BUSY = /^\S .*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\b[^)]*\)$/;

/**
 * The spinner in the half second before its timer is drawn: "✻ Schlepping…".
 * Without this the scan read past it to the previous turn's `done` line and
 * retracted a turn that had only just started.
 */
const CLAUDE_PANE_SPINNER = /^\S \S+…$/;

/**
 * A prompt the user submitted, as Claude echoes it into the transcript. The
 * input box draws the same `❯ text`, but always directly under a rule, so a
 * line that is not under one is the echo. Anything above it, a `done` line
 * included, belongs to an earlier turn.
 */
const CLAUDE_PANE_PROMPT = /^❯ \S/;
const CLAUDE_PANE_RULE = /^─/;

/**
 * "✻ Waiting for 1 background agent to finish": the turn has ended, but the
 * session resumes by itself when the agent reports. That is still work, so it
 * stops the scan the way a live timer does rather than letting it read past to
 * an older `done` line.
 */
const CLAUDE_PANE_BACKGROUND =
  /^\S Waiting for \d+ background agents? to finish/;

/**
 * The last resort, and the only signal that survives an *instant* escape.
 *
 * Escaping after Claude has begun responding leaves `[Request interrupted by
 * user]` in the transcript. Escaping before its first token leaves nothing at
 * all: no hook, and a transcript holding only the user's prompt. The pane is
 * then the sole evidence that the turn is over, and it is unambiguous — a
 * finished turn says `done`, a live one is still counting.
 *
 * It may only *retract* a `working` reading or keep one alive, never create
 * one. A stale or misread pane that could invent work, or speak for a session
 * blocked on the user, is the failure this tier is ranked lowest to avoid.
 * Retracting a `working` that no hook is coming to retract, and vouching for
 * one that no hook is coming to refresh, are the two things it can do that
 * nothing else can.
 */
export function observeClaudePane(
  text: string,
): ActivityObservation | undefined {
  const lines = text.replace(/\s+$/, "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trimEnd();
    // A live timer is the newest word on the turn: whatever sits above it is
    // older, so the scan stops rather than reading past it to a stale `done`.
    // It is also the best proof of work there is, for a long tool call or a
    // long answer that fires no hook for minutes, so it keeps `working` alive.
    if (
      CLAUDE_PANE_BUSY.test(line) ||
      CLAUDE_PANE_SPINNER.test(line) ||
      CLAUDE_PANE_BACKGROUND.test(line)
    )
      return {
        activity: "working",
        source: "pane",
        heartbeat: true,
        ifActivity: ["working"],
      };
    const interrupted = CLAUDE_PANE_INTERRUPTED.test(line);
    if (interrupted || CLAUDE_PANE_DONE.test(line))
      return {
        // `idle`, not `done`, even for a `done` line. A turn that really
        // finished fired `Stop`, which already said `done`; the pane is only
        // still reading `working` here when no hook came. That is an escape
        // before the first token, which leaves the *previous* turn's `done`
        // line as the newest one on screen.
        activity: "idle",
        source: "pane",
        // The interrupt line says why, and matches what the transcript tier
        // calls the same event. A `done` line cannot.
        ...(interrupted ? { detail: "Interrupted" } : {}),
        ifActivity: ["working"],
        authoritative: true,
      };
    // A submitted prompt with no `done` or interrupt below it is a turn in
    // progress, typically while its answer streams and no status line shows.
    // An instant escape never gets here: Claude puts the prompt back in the
    // input box rather than leaving it echoed above.
    if (
      CLAUDE_PANE_PROMPT.test(line) &&
      !CLAUDE_PANE_RULE.test(lines[index - 1] ?? "")
    )
      return undefined;
  }
  return undefined;
}

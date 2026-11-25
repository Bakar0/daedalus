/**
 * The steps of an agent's turns, as its hooks report them, and the turns
 * they add up to. A turn runs from the user's prompt to the agent's stop.
 */

/** A step a hook reported: a prompt, a finished tool call, or a turn's end. */
export interface SessionStep {
  kind: "prompt" | "tool" | "stop";
  /** A tool step's name, such as `Bash`. */
  tool: string | null;
  /** What it ran on: a command or a file's name. On a prompt, its text. */
  detail: string | null;
  /** The whole path of the file an editing tool wrote. */
  file: string | null;
  failed: boolean;
  durationMs: number | null;
  at: string;
}

export interface SessionTurnStep {
  tool: string;
  detail: string | null;
  failed: boolean;
  durationMs: number | null;
  at: string;
}

export interface SessionTurn {
  startedAt: string;
  /** Null while the agent still works on it. */
  endedAt: string | null;
  /** How many tool calls finished in it, also those `steps` leaves out. */
  toolCalls: number;
  /** Its last tool calls, oldest first. */
  steps: SessionTurnStep[];
  /** The files it edited, each once, in the order first touched. */
  files: string[];
}

const DETAIL_LENGTH = 160;
/** How many of a turn's tool calls are listed; the count covers them all. */
export const TURN_STEPS_KEPT = 200;

const EDITING_TOOL = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const shorten = (value: string): string => {
  const line = value.split("\n")[0]!.trim();
  return line.length > DETAIL_LENGTH
    ? `${line.slice(0, DETAIL_LENGTH - 1)}…`
    : line;
};

const baseName = (path: string): string => path.split("/").at(-1) || path;

/** What a tool ran on, from its input: the command, or the file's name. */
function toolDetail(input: Record<string, unknown>): string | null {
  const path =
    text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
  const value =
    text(input.command) ??
    (path ? baseName(path) : undefined) ??
    text(input.pattern) ??
    text(input.query) ??
    text(input.url) ??
    text(input.description) ??
    text(input.prompt);
  return value ? shorten(value) : null;
}

/**
 * The step a hook's payload is, when it is one. Only the hooks that mark a
 * turn's progress count: `PreToolUse` says a tool began and its own
 * `PostToolUse` follows, so counting both would count the call twice.
 */
export function stepFromHook(
  event: string,
  payload: Record<string, unknown>,
): Omit<SessionStep, "at"> | undefined {
  const step = {
    tool: null,
    detail: null,
    file: null,
    failed: false,
    durationMs: null,
  };
  switch (event) {
    case "UserPromptSubmit": {
      const prompt = text(payload.prompt);
      return {
        ...step,
        kind: "prompt",
        detail: prompt ? shorten(prompt) : null,
      };
    }
    case "Stop":
    case "Interrupt":
      return { ...step, kind: "stop" };
    case "PostToolUse":
    case "PostToolUseFailure": {
      const tool = text(payload.tool_name);
      if (!tool) return undefined;
      const input =
        payload.tool_input && typeof payload.tool_input === "object"
          ? (payload.tool_input as Record<string, unknown>)
          : {};
      const failed = event === "PostToolUseFailure";
      const duration = payload.duration_ms;
      return {
        kind: "tool",
        tool,
        detail: toolDetail(input),
        file:
          !failed && EDITING_TOOL.test(tool)
            ? (text(input.file_path) ?? text(input.notebook_path) ?? null)
            : null,
        failed,
        durationMs:
          typeof duration === "number" && Number.isFinite(duration)
            ? Math.round(duration)
            : null,
      };
    }
    default:
      return undefined;
  }
}

/**
 * A session's steps, oldest first, as turns. A prompt starts a turn and a
 * stop ends it. A tool call after a stop belongs to the same turn: the agent
 * went on by itself, as it does when its background agents report. Tool
 * calls before any prompt (the session was running when recording began)
 * make a turn that starts at the first of them.
 */
export function turnsFromSteps(steps: readonly SessionStep[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let open: SessionTurn | undefined;
  const start = (at: string) => {
    open = { startedAt: at, endedAt: null, toolCalls: 0, steps: [], files: [] };
    turns.push(open);
    return open;
  };
  for (const step of steps) {
    if (step.kind === "prompt") {
      // A prompt typed while the agent works is queued into the same turn.
      if (!open || open.endedAt !== null) start(step.at);
      continue;
    }
    if (step.kind === "stop") {
      if (open) open.endedAt = step.at;
      continue;
    }
    const turn = open ?? start(step.at);
    turn.endedAt = null;
    turn.toolCalls += 1;
    turn.steps.push({
      tool: step.tool ?? "Tool",
      detail: step.detail,
      failed: step.failed,
      durationMs: step.durationMs,
      at: step.at,
    });
    if (turn.steps.length > TURN_STEPS_KEPT) turn.steps.shift();
    if (step.file && !turn.files.includes(step.file))
      turn.files.push(step.file);
  }
  return turns;
}

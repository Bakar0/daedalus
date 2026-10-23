import type { MoveSessionNameDto, WorkspaceMoveDto } from "@daedalus/protocol";
import { plainLine } from "./dialogs";

/** Lines a dialog lists at most; the rest are counted on one more line. */
const MOST_LINES = 12;

const capped = (lines: string[]): string[] =>
  lines.length > MOST_LINES
    ? [
        ...lines.slice(0, MOST_LINES - 1),
        `and ${lines.length - MOST_LINES + 1} more`,
      ]
    : lines;

/** 1.5 GB, 256 MB, 12 KB: binary units, as the caps are set. */
export function byteSize(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown =
    unit === 0 || value >= 10 || Number.isInteger(value)
      ? Math.round(value).toString()
      : value.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${units[unit]}`;
}

/** Paths from the pod, one plain line each. */
export const pathLines = (paths: string[]): string[] =>
  capped(paths.map((path) => plainLine(path, 120)));

/** Session names, one plain line each. */
export const sessionLines = (sessions: MoveSessionNameDto[]): string[] =>
  capped(sessions.map((session) => plainLine(session.name, 80)));

/** What is over its cap: "repos/app: 1.5 GB, at most 1 GB". */
export const tooBigLines = (
  items: { what: string; bytes: number; maxBytes: number }[],
): string[] =>
  capped(
    items.map(
      (item) =>
        `${plainLine(item.what, 80)}: ${byteSize(item.bytes)}, at most ${byteSize(item.maxBytes)}`,
    ),
  );

/** The steps a move goes through, in order, as the workspace shows them. */
export const MOVE_STEPS: readonly {
  phase: WorkspaceMoveDto["phase"];
  label: string;
}[] = [
  { phase: "waiting", label: "Waiting for turns" },
  { phase: "stopping", label: "Stopping sessions" },
  { phase: "copying", label: "Copying" },
  { phase: "starting", label: "Starting sessions" },
];

/** The workspace's one-line state while it moves. */
export function moveLabel(move: WorkspaceMoveDto): string {
  if (move.phase === "failed") return "Move failed";
  if (move.phase === "moved")
    return move.to === "cloud" ? "Moved to the cloud" : "Moved to this Mac";
  return move.to === "cloud" ? "Moving to the cloud…" : "Moving to this Mac…";
}

/**
 * A moving workspace, under its card: where it is going, the steps with
 * the one it is on, and the host's detail as a plain line. Cancel only
 * while it waits for turns to end. A failed move says why until it goes,
 * and one that failed before the host answered can be dismissed.
 */
export function WorkspaceMoveState({
  name,
  move,
  error,
  onCancel,
  onDismiss,
}: {
  name: string;
  /** The host's entry; absent when only `error` is there. */
  move?: WorkspaceMoveDto;
  /** Why the move call failed, when the host has no entry to show it. */
  error?: string;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const failed = move?.phase === "failed" || (!move && Boolean(error));
  const at = move
    ? MOVE_STEPS.findIndex((step) => step.phase === move.phase)
    : -1;
  const why = failed ? (move?.message ?? error) : move?.detail;
  return (
    <div
      aria-label={`${name}: ${move ? moveLabel(move) : "Move failed"}`}
      aria-live="polite"
      className="workspace-move"
      data-phase={failed ? "failed" : move?.phase}
      data-testid="workspace-move"
      role="status"
    >
      <div className="workspace-move-row">
        <strong className="workspace-move-label">
          {move ? moveLabel(move) : "Move failed"}
        </strong>
        {move?.phase === "waiting" && (
          <button
            className="quiet workspace-move-cancel"
            data-testid="workspace-move-cancel"
            onClick={onCancel}
            title="Stop waiting; the workspace stays where it is"
            type="button"
          >
            Cancel
          </button>
        )}
        {!move && error && (
          <button
            className="quiet workspace-move-cancel"
            data-testid="workspace-move-dismiss"
            onClick={onDismiss}
            type="button"
          >
            Dismiss
          </button>
        )}
      </div>
      {!failed && at >= 0 && (
        <ol aria-hidden="true" className="workspace-move-steps">
          {MOVE_STEPS.map((step, index) => (
            <li
              data-state={
                index < at ? "done" : index === at ? "now" : undefined
              }
              key={step.phase}
              title={step.label}
            />
          ))}
        </ol>
      )}
      {why && (
        <small
          className="workspace-move-detail"
          data-testid="workspace-move-detail"
        >
          {failed
            ? `${plainLine(why, 200)} The workspace stays where it was.`
            : plainLine(why, 120)}
        </small>
      )}
    </div>
  );
}

/**
 * A one-line notice on the workspace until the user has read it: what a
 * move did, or that it came back from its backup. Plain text, cut short.
 */
export function WorkspaceNotice({
  text,
  testId,
  onDismiss,
}: {
  text: string;
  testId: string;
  onDismiss: () => void;
}) {
  return (
    <div className="workspace-notice" data-testid={testId} role="note">
      <span>{plainLine(text, 400)}</span>
      <button
        className="quiet"
        data-testid={`${testId}-dismiss`}
        onClick={onDismiss}
        type="button"
      >
        Got it
      </button>
    </div>
  );
}

import { useEffect, useState } from "react";
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

/**
 * The gateway's own workspace limit, said with the workspaces this Mac
 * knows are in the cloud: "5 workspaces are already in the cloud: A, B and
 * 3 more from another Mac or an earlier install. Move one home first." The
 * names are the Mac's records, never the gateway's; what the limit holds
 * beyond them is only counted. Any other message is left as it came.
 */
export function cloudLimitMessage(message: string, inCloud: string[]): string {
  const limit = /at most (\d+) workspaces/i.exec(message);
  if (!limit) return message;
  const total = Math.max(Number(limit[1]), inCloud.length);
  const others = total - inCloud.length;
  const are = `${total} ${total === 1 ? "workspace is" : "workspaces are"} already in the cloud`;
  const elsewhere = `${others} more from another Mac or an earlier install`;
  if (inCloud.length === 0)
    return `${are}, all from another Mac or an earlier install. The gateway deletes them after 30 days asleep.`;
  const names = inCloud.map((name) => plainLine(name, 60)).join(", ");
  return `${are}: ${names}${others > 0 ? ` and ${elsewhere}` : ""}. Move one home first.`;
}

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

/** The current step's short label, under the move's animation. */
export function moveStepLabel(move: WorkspaceMoveDto): string {
  switch (move.phase) {
    case "waiting":
      return "Waiting for sessions";
    case "stopping":
      return "Stopping sessions";
    case "copying":
      return "Copying";
    case "starting":
      return move.to === "cloud"
        ? "Starting in the cloud"
        : "Starting on this Mac";
    case "moved":
      return move.to === "cloud" ? "In the cloud" : "On this Mac";
    case "failed":
      return "Move failed";
  }
}

/** How long the settled picture stays after a move ends well. */
const SETTLE_MS = 2400;

function MacIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
    >
      <rect height="10.5" rx="1.6" width="15" x="4.5" y="5.5" />
      <path d="M2.5 18.5h19" />
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
    >
      <path d="M7 18.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7 9.2 4.7 4.7 0 0 0 7 18.5Z" />
    </svg>
  );
}

/**
 * The Mac, the cloud and dots flowing from where the workspace is to where
 * it goes. Settled, the dots stop and the side it reached lights. CSS
 * only; under reduced motion it gives way to the plain progress line.
 */
function MoveScene({
  to,
  settled,
}: {
  to: WorkspaceMoveDto["to"];
  settled: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className="workspace-move-scene"
      data-settled={settled ? "true" : undefined}
      data-testid="workspace-move-scene"
      data-to={to}
    >
      <span className="workspace-move-end" data-end="mac">
        <MacIcon />
      </span>
      <span className="workspace-move-track">
        <i />
        <i />
        <i />
      </span>
      <span className="workspace-move-end" data-end="cloud">
        <CloudIcon />
      </span>
    </div>
  );
}

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
  const moved = move?.phase === "moved";
  // A move that ended well shows its settled picture a moment, then goes.
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setGone(false);
    if (!moved) return;
    const timer = setTimeout(() => setGone(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [moved]);
  if (moved && gone) return null;
  const at = move
    ? MOVE_STEPS.findIndex((step) => step.phase === move.phase)
    : -1;
  const why = failed ? (move?.message ?? error) : undefined;
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
      {move && !failed && (
        <>
          <MoveScene settled={moved} to={move.to} />
          <small
            className="workspace-move-step"
            data-testid="workspace-move-step"
          >
            {/* The host's detail says more than the step's name. */}
            {move.detail && !moved
              ? plainLine(move.detail, 80)
              : moveStepLabel(move)}
          </small>
        </>
      )}
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
          {`${plainLine(why, 200)} The workspace stays where it was.`}
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

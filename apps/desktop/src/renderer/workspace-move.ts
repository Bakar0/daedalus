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

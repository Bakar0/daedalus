import type {
  DesktopSnapshotDto,
  DesktopSnapshotPart,
  DesktopSnapshotPartsDto,
} from "@daedalus/protocol";

/** What a `dataChanged` message carries for the window. */
export interface DataChange {
  /** Only these parts changed. Absent means everything may have. */
  parts?: DesktopSnapshotPart[];
}

/**
 * Parts that nothing but the snapshot reads. A change to only these leaves
 * the workspace content, the task timeline and the Changes view as they
 * were, so none of them is asked for again. A session's activity and token
 * counts move on most ticks while agents work, and each of those used to
 * refetch all three.
 */
const SNAPSHOT_ONLY_PARTS: ReadonlySet<DesktopSnapshotPart> = new Set([
  "sessionActivity",
  "telemetry",
  "toasts",
  "largeFiles",
]);

/** Whether a change can move anything outside the snapshot. */
export const changeReachesBeyondSnapshot = (change?: DataChange): boolean =>
  !change?.parts?.length ||
  change.parts.some((part) => !SNAPSHOT_ONLY_PARTS.has(part));

/**
 * The parts asked for by the changes since the last snapshot request, or
 * `"full"` when one of them, or a caller, needs everything.
 */
export class PendingSnapshotParts {
  private pending: Set<DesktopSnapshotPart> | "full" = "full";

  note(change?: DataChange): void {
    if (!change?.parts?.length) this.pending = "full";
    else if (this.pending !== "full")
      for (const part of change.parts) this.pending.add(part);
  }

  /** Asks for the whole snapshot next, as a mutation's refresh does. */
  full(): void {
    this.pending = "full";
  }

  /**
   * What the next request reads, and starts collecting afresh. Nothing noted
   * since the last request also means everything: that is a refresh nobody
   * announced, such as the first load.
   */
  take(): DesktopSnapshotPart[] | "full" {
    const pending = this.pending;
    this.pending = new Set();
    return pending === "full" || pending.size === 0 ? "full" : [...pending];
  }
}

/** The snapshot with the reloaded parts in place of their old values. */
export const mergeSnapshotParts = (
  snapshot: DesktopSnapshotDto,
  parts: DesktopSnapshotPartsDto,
): DesktopSnapshotDto => ({ ...snapshot, ...parts });

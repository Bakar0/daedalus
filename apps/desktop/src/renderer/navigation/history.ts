/**
 * Back and forward through the sessions and tasks visited, as ⌘[ and ⌘]
 * move. Pure: each step returns a new state.
 */

export interface Visit {
  readonly kind: "session" | "task";
  readonly id: string;
  readonly workspaceId: string;
}

export interface VisitHistory {
  readonly entries: readonly Visit[];
  /** The entry being shown; -1 when empty. */
  readonly index: number;
}

export const EMPTY_HISTORY: VisitHistory = { entries: [], index: -1 };

const LIMIT = 100;

const sameVisit = (a: Visit | undefined, b: Visit) =>
  a?.kind === b.kind && a.id === b.id;

/**
 * Records a visit. Visiting what is already shown changes nothing; a new
 * visit after going back drops the entries ahead, as a browser does.
 */
export function recordVisit(history: VisitHistory, visit: Visit): VisitHistory {
  if (sameVisit(history.entries[history.index], visit)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), visit].slice(
    -LIMIT,
  );
  return { entries, index: entries.length - 1 };
}

/**
 * Steps back (-1) or forward (1) to the nearest entry that still exists.
 * Entries that no longer do (an archived session, a deleted task) are
 * skipped and dropped. Returns undefined when there is nowhere to go.
 */
export function stepHistory(
  history: VisitHistory,
  direction: 1 | -1,
  exists: (visit: Visit) => boolean,
): { history: VisitHistory; visit: Visit } | undefined {
  const current = history.entries[history.index];
  const kept = history.entries.filter(
    (entry, index) => index === history.index || exists(entry),
  );
  const index = current ? kept.indexOf(current) : -1;
  const target = kept[index + direction];
  if (!target || index < 0) return undefined;
  return {
    history: { entries: kept, index: index + direction },
    visit: target,
  };
}

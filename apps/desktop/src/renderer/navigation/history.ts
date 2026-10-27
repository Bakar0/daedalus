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
 * skipped and dropped. `away` says the entry at `index` is no longer on
 * screen (the user went to the Workspace view, say): Back then returns to
 * it first rather than to the one before it. Returns undefined when there
 * is nowhere to go.
 */
export function stepHistory(
  history: VisitHistory,
  direction: 1 | -1,
  exists: (visit: Visit) => boolean,
  { away = false }: { away?: boolean } = {},
): { history: VisitHistory; visit: Visit } | undefined {
  if (history.index < 0) return undefined;
  const kept: Visit[] = [];
  // How many kept entries sit at or before the current one.
  let upToCurrent = 0;
  history.entries.forEach((entry, index) => {
    const keep = (index === history.index && !away) || exists(entry);
    if (!keep) return;
    kept.push(entry);
    if (index <= history.index) upToCurrent += 1;
  });
  const target = direction === 1 ? upToCurrent : upToCurrent - (away ? 1 : 2);
  const visit = kept[target];
  if (!visit || target < 0) return undefined;
  return { history: { entries: kept, index: target }, visit };
}

/**
 * Go Back and Go Forward: the places the center showed, in the order they
 * were shown, and where in that list the user is now. A browser's history:
 * going back moves the cursor, and going somewhere new from there drops the
 * places ahead of it.
 */

/**
 * Something the center showed in one workspace. The session and task tabs
 * each show whichever one is selected, so those places name it; every other
 * tab (a file, a diff, a plan, a web page, a terminal) is named by its tab.
 */
export type Place =
  | { workspaceId: string; kind: "session"; id: string }
  | { workspaceId: string; kind: "task"; id: string }
  | { workspaceId: string; kind: "tab"; id: string }
  /** A page of Home's own (Activity, Routines), which has no tab. */
  | { workspaceId: string; kind: "home"; id: string }
  | { workspaceId: string; kind: "board" };

/** The places shown, oldest first, and which one is in front. */
export interface NavHistory {
  readonly places: readonly Place[];
  /** The place shown now; -1 while the list is empty. */
  readonly cursor: number;
}

/** How many places the history remembers. */
export const HISTORY_LIMIT = 50;

/** A step through the history: back is -1, forward is 1. */
export type Step = 1 | -1;

/** The history before anything has been shown. */
export const emptyHistory: NavHistory = { places: [], cursor: -1 };

/** The session, task or tab a place shows; a board has none. */
export const placeId = (place: Place): string | undefined =>
  "id" in place ? place.id : undefined;

/** Whether two places are the same session, task, tab or page. */
export const samePlace = (a: Place | undefined, b: Place | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.workspaceId === b.workspaceId &&
  a.kind === b.kind &&
  placeId(a) === placeId(b);

/**
 * The center now shows `place`. The place under the cursor already (a step
 * back or forward arriving) leaves the history as it is; anything else goes
 * after the cursor and drops what was ahead of it. Unchanged, the same
 * object comes back, so a caller can skip a render.
 */
export function visit(
  history: NavHistory,
  place: Place,
  limit = HISTORY_LIMIT,
): NavHistory {
  if (samePlace(history.places[history.cursor], place)) return history;
  const places = [...history.places.slice(0, history.cursor + 1), place];
  const kept = places.slice(-limit);
  return { places: kept, cursor: kept.length - 1 };
}

/**
 * The nearest place behind (`-1`) or ahead (`1`) of the cursor that can
 * still be opened, as its index. Undefined when there is none: an archived
 * session or a deleted task is stepped over, not landed on.
 */
export function stepTarget(
  history: NavHistory,
  direction: Step,
  canOpen: (place: Place) => boolean,
): number | undefined {
  const current = history.places[history.cursor];
  for (
    let index = history.cursor + direction;
    index >= 0 && index < history.places.length;
    index += direction
  ) {
    const place = history.places[index];
    // Two entries for one place, with a dead one between them that was
    // stepped over, would make a step look like it did nothing.
    if (place && canOpen(place) && !samePlace(place, current)) return index;
  }
  return undefined;
}

/** The history with the cursor moved to `index`. */
export const moveTo = (history: NavHistory, index: number): NavHistory => ({
  ...history,
  cursor: index,
});

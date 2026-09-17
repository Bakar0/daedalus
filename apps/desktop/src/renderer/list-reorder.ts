/**
 * The arithmetic behind dragging a card to a new place in a list.
 *
 * Kept out of the component because it is the part that can actually be wrong:
 * where a card lands, whether a gesture was a drag or a click, and whether the
 * order changed at all. The DOM plumbing around it — pointer capture, measuring
 * rects — has nothing to decide.
 */

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * These cards are buttons first: a click selects the workspace or session. A
 * threshold is what lets one gesture serve both without a press-and-hold delay,
 * and 5px is far enough that the tremor in a click never crosses it.
 */
export const DRAG_THRESHOLD_PX = 5;

export function exceedsDragThreshold(
  start: { x: number; y: number },
  current: { x: number; y: number },
): boolean {
  return (
    Math.hypot(current.x - start.x, current.y - start.y) >= DRAG_THRESHOLD_PX
  );
}

/** Moves one item, returning a new array. Out-of-range indices are a no-op. */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  )
    return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * Which slot the dragged card should occupy, given where the pointer is.
 *
 * The dragged card's own midpoint is deliberately excluded from the count.
 * Including it makes the answer depend on the card's current position, which
 * is what makes naive implementations flicker between two slots when the
 * pointer sits near a boundary.
 */
export function dropIndexFor(
  midpoints: readonly number[],
  fromIndex: number,
  pointerY: number,
): number {
  let index = 0;
  for (let position = 0; position < midpoints.length; position += 1) {
    if (position === fromIndex) continue;
    if ((midpoints[position] ?? 0) < pointerY) index += 1;
  }
  return index;
}

/** True when two orders differ, so an unchanged drop costs no round trip. */
export function orderChanged(
  before: readonly string[],
  after: readonly string[],
): boolean {
  return (
    before.length !== after.length ||
    before.some((id, index) => id !== after[index])
  );
}

/**
 * Where ⌥↑/⌥↓ puts a card. Clamped rather than wrapping: a card at the top
 * that jumps to the bottom on one more press is a keystroke people undo.
 */
export function keyboardMoveTarget(
  index: number,
  direction: "up" | "down",
  length: number,
): number | undefined {
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= length) return undefined;
  return target;
}

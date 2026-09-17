import { DaedalusError } from "../errors";

/**
 * Applies a new order for *some* of a list's members without disturbing the
 * rest.
 *
 * Both navigator lists hide part of themselves: archived workspaces sit in a
 * collapsed section, and the session list can be filtered to just the sessions
 * blocked on you. A drag inside what you can see must not shuffle what you
 * cannot, so a reorder names only the subset it is rearranging.
 *
 * The named items are dealt back into the slots the named items already
 * occupied, in their new order; everything else keeps its exact place. Drag
 * the second of three visible sessions to the top and an archived session
 * between them in the underlying order does not move.
 */
export function applyManualOrder(
  currentIds: readonly string[],
  orderedSubset: readonly string[],
  label: string,
): string[] {
  const seen = new Set<string>();
  for (const id of orderedSubset) {
    if (seen.has(id))
      throw new DaedalusError(
        "VALIDATION",
        `${label} '${id}' was listed twice in the new order`,
      );
    seen.add(id);
  }

  const known = new Set(currentIds);
  for (const id of orderedSubset) {
    if (!known.has(id))
      throw new DaedalusError("NOT_FOUND", `${label} '${id}' was not found`);
  }

  const queue = [...orderedSubset];
  return currentIds.map((id) => (seen.has(id) ? queue.shift()! : id));
}

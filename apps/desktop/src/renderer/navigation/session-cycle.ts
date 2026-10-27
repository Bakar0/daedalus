/**
 * The session after or before `current` in sidebar order, wrapping; from
 * no session, ⌥⌘↓ starts at the first and ⌥⌘↑ at the last.
 */
export function stepSession(
  order: readonly string[],
  current: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (order.length === 0) return undefined;
  const index = current ? order.indexOf(current) : -1;
  if (index < 0) return direction === 1 ? order[0] : order.at(-1);
  const next = order[(index + direction + order.length) % order.length];
  return next === current ? undefined : next;
}

/**
 * The next session that needs the user, after `current` in sidebar order
 * and wrapping, so pressing ⇧⌘A again goes round them all. Undefined when
 * none other does.
 */
export function nextNeedingYou(
  order: readonly string[],
  needsYou: (id: string) => boolean,
  current: string | undefined,
): string | undefined {
  const start = current ? order.indexOf(current) : -1;
  for (let step = 1; step <= order.length; step += 1) {
    const id = order[(start + step + order.length) % order.length];
    if (id !== undefined && id !== current && needsYou(id)) return id;
  }
  return undefined;
}

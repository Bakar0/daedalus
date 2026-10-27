/**
 * Moving between sessions: the ⌃Tab switcher's most-recently-used order,
 * and the next session that needs the user.
 */

/** How many sessions the recent order remembers. */
export const MRU_LIMIT = 50;

/**
 * `id` moved to the front of the recent order: the session just opened or
 * focused. Already first, the same list comes back, so a caller can skip a
 * render.
 */
export function recordMru(
  order: readonly string[],
  id: string,
  limit = MRU_LIMIT,
): readonly string[] {
  if (order[0] === id) return order;
  return [id, ...order.filter((item) => item !== id)].slice(0, limit);
}

/**
 * The sessions the switcher lists: the live ones used lately, most recent
 * first, then every other live one in `fallback` order (the sidebar's), so
 * a session never opened since start can still be reached.
 */
export function switcherOrder(
  mru: readonly string[],
  live: readonly string[],
): string[] {
  const alive = new Set(live);
  const recent = mru.filter((id) => alive.has(id));
  const seen = new Set(recent);
  return [...recent, ...live.filter((id) => !seen.has(id))];
}

/**
 * Where the switcher's highlight goes from `index` among `count` rows,
 * wrapping: Tab is 1, ⇧Tab is -1.
 */
export const stepSwitcher = (
  index: number,
  count: number,
  direction: 1 | -1,
): number => (count === 0 ? 0 : (index + direction + count) % count);

/**
 * The next session that needs the user, after `current` in sidebar order
 * and wrapping, so running it again goes round them all. Undefined when
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

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
 * Where the highlight starts: the first Tab lands on the session before the
 * one showing (from a view with no session, on the last one used), so a
 * quick tap goes back to the previous session; ⇧Tab lands on the oldest.
 */
export function switcherStart(
  ids: readonly string[],
  shown: string | undefined,
  direction: 1 | -1,
): number {
  if (ids.length === 0) return 0;
  if (direction === -1) return ids.length - 1;
  return Math.min(ids[0] === shown ? 1 : 0, ids.length - 1);
}

/** The switcher while it is open: its sessions and the highlighted one. */
export interface SwitcherState {
  ids: readonly string[];
  index: number;
}

/**
 * The switcher's sessions kept to the ones still live (one archived while
 * it is open drops out). The highlight stays on its session when that is
 * still there, else on the row that took its place. Undefined when none is
 * left: the switcher closes, so ⌃Tab is not swallowed by an empty list.
 */
export function pruneSwitcher<T extends SwitcherState>(
  state: T,
  live: ReadonlySet<string>,
): T | undefined {
  const ids = state.ids.filter((id) => live.has(id));
  if (ids.length === 0) return undefined;
  if (ids.length === state.ids.length) return state;
  const highlighted = state.ids[state.index];
  const kept = highlighted === undefined ? -1 : ids.indexOf(highlighted);
  return {
    ...state,
    ids,
    index: kept >= 0 ? kept : Math.min(state.index, ids.length - 1),
  };
}

/** One step of the highlight over the live rows, Tab and the arrows alike. */
export function moveSwitcher<T extends SwitcherState>(
  state: T,
  live: ReadonlySet<string>,
  direction: 1 | -1,
): T | undefined {
  const pruned = pruneSwitcher(state, live);
  return pruned
    ? {
        ...pruned,
        index: stepSwitcher(pruned.index, pruned.ids.length, direction),
      }
    : undefined;
}

/** The modifiers the opening key held; the switcher opens when they go. */
export interface HeldModifiers {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
}

export const holdsAny = (held: HeldModifiers | undefined): boolean =>
  Boolean(held && (held.mod || held.ctrl || held.alt));

/** Whether a key event says the held modifiers are still down. */
export const stillHeld = (
  held: HeldModifiers,
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">,
): boolean =>
  (!held.mod || event.metaKey) &&
  (!held.ctrl || event.ctrlKey) &&
  (!held.alt || event.altKey);

/** What reaches the open switcher. */
export type SwitcherInput =
  | ({
      type: "keydown" | "keyup";
      key: string;
      /** The key's target is inside the switcher's list. */
      inList: boolean;
    } & Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">)
  /** The window lost focus. */
  | { type: "blur" }
  /** Focus left the shown list for somewhere outside it. */
  | { type: "focusout" };

export interface SwitcherDecision {
  action: "commit" | "cancel" | "move" | "none";
  direction?: 1 | -1;
  /** The key was the switcher's: keep it from the page and the terminal. */
  consume: boolean;
}

const NONE: SwitcherDecision = { action: "none", consume: false };

/**
 * What the open switcher does with an event. A dialog opening on top (the
 * palette, a confirm) cancels it and leaves the key alone. In the held
 * flow, any key or key release without the held modifiers opens the
 * highlighted session, and a key that arrives that way is consumed, so it
 * is not typed into the terminal being left. Otherwise only keys aimed at
 * the list are its own (the held flow's list may not have focus yet):
 * Escape cancels, Enter opens, ↑/↓ move.
 */
export function switcherDecision(
  held: HeldModifiers | undefined,
  input: SwitcherInput,
  { scopeOpen = false }: { scopeOpen?: boolean } = {},
): SwitcherDecision {
  if (input.type === "blur" || input.type === "focusout")
    return { action: "cancel", consume: false };
  if (scopeOpen) return { action: "cancel", consume: false };
  const holding = holdsAny(held);
  if (held && holding && !stillHeld(held, input))
    return { action: "commit", consume: input.type === "keydown" };
  if (input.type === "keyup") return NONE;
  if (!holding && !input.inList) return NONE;
  if (input.key === "Escape") return { action: "cancel", consume: true };
  if (input.key === "Enter") return { action: "commit", consume: true };
  if (input.key === "ArrowDown")
    return { action: "move", direction: 1, consume: true };
  if (input.key === "ArrowUp")
    return { action: "move", direction: -1, consume: true };
  return NONE;
}

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

import {
  COMMAND_SPECS,
  type CommandId,
  type KeyChord,
  type KeyEventLike,
  type KeyOverrides,
  chordText,
  chordsFromEvent,
  commandSpec,
  isModifierOnly,
  keysOf,
  normalizeKey,
  parseKey,
} from "@daedalus/protocol";
import {
  compileBindings,
  findConflicts,
  isComposingKey,
  prefixRelated,
} from "./dispatch";

/**
 * Settings › Keyboard's key recorder and its conflict check, as pure
 * functions so they are tested without a window. The recorder takes one
 * chord: a sequence (`mod+k mod+s`) is written in `keybindings.json` by hand.
 */

export type RecordedKey =
  /** A modifier alone, or a key that names nothing: keep listening. */
  | { kind: "ignore" }
  /** Escape with no modifier: stop recording, change nothing. */
  | { kind: "cancel" }
  /** Backspace or Delete with no modifier: remove the command's first key. */
  | { kind: "clear" }
  | { kind: "key"; key: string };

const noModifier = (chord: KeyChord) =>
  !chord.mod && !chord.ctrl && !chord.alt && !chord.shift;

/** Punctuation typed without ⇧ on a US layout, which a key code also names. */
const UNSHIFTED = /^[a-z0-9[\]`,./;'\-=\\]$/;

/**
 * The chord a key press records. Of the chords an event may mean, the first
 * (the layout's character) is kept, except that ⇧ with a key whose shifted
 * character is punctuation records the physical key: ⇧⌘] is written
 * `shift+mod+]`, as the defaults are, rather than `shift+mod+}`.
 *
 * A key an input method or a dead key composes (`isComposing`, keyCode
 * 229) is ignored when typed alone or with ⇧, as it is text; with ⌥, ⌃ or
 * ⌘ it is recorded by its physical key, so ⌥E, ⌥N, ⌥U and ⌥` (dead keys on
 * a US layout, whose `key` is "Dead") record as `alt+e` and so on.
 */
export function recordKeyEvent(
  event: KeyEventLike & Partial<Pick<KeyboardEvent, "isComposing" | "keyCode">>,
): RecordedKey {
  if (isModifierOnly(event)) return { kind: "ignore" };
  if (
    isComposingKey(event) &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  )
    return { kind: "ignore" };
  const chords = chordsFromEvent(event);
  let chord = chords[0];
  if (!chord) return { kind: "ignore" };
  if (chord.shift && !UNSHIFTED.test(chord.key)) {
    const physical = [...chords]
      .reverse()
      .find((candidate) => candidate.shift && UNSHIFTED.test(candidate.key));
    if (physical) chord = physical;
  }
  if (noModifier(chord) && chord.key === "escape") return { kind: "cancel" };
  if (
    noModifier(chord) &&
    (chord.key === "backspace" || chord.key === "delete")
  )
    return { kind: "clear" };
  const key = chordText(chord);
  try {
    normalizeKey(key);
  } catch {
    return { kind: "ignore" };
  }
  return { kind: "key", key };
}

/**
 * A command's keys once `key` is recorded for it: it replaces the first key,
 * the one menus and tooltips show, and the others stay.
 */
export function recordedKeys(
  id: CommandId,
  key: string,
  overrides: KeyOverrides,
): string[] {
  const wanted = normalizeKey(key);
  const [, ...rest] = keysOf(commandSpec(id), overrides);
  return [key, ...rest.filter((own) => normalizeKey(own) !== wanted)];
}

/** A command's keys once its first key is removed (⌫ while recording). */
export const clearedKeys = (id: CommandId, overrides: KeyOverrides) =>
  keysOf(commandSpec(id), overrides).slice(1);

/**
 * The commands that would get in the way of `id` bound to `key` (as
 * `recordedKeys` binds it): the pairs `findConflicts` reports for that key,
 * the same keys in the same place, one beginning the other, or a menu key.
 */
export function keyConflicts(
  id: CommandId,
  key: string,
  overrides: KeyOverrides,
): CommandId[] {
  const wanted = normalizeKey(key);
  const bindings = compileBindings(COMMAND_SPECS, {
    ...overrides,
    [id]: recordedKeys(id, key, overrides),
  });
  const others = new Set<CommandId>();
  for (const [a, b] of findConflicts(bindings)) {
    if (a.id === id && a.key === wanted) others.add(b.id);
    else if (b.id === id && b.key === wanted) others.add(a.id);
  }
  return [...others];
}

/**
 * A command's keys without any that conflict with `key` (the same keys, or
 * one beginning the other), for taking it away when `key` replaces it.
 */
export function keysWithout(
  id: CommandId,
  key: string,
  overrides: KeyOverrides,
): string[] {
  const removed = parseKey(key);
  return keysOf(commandSpec(id), overrides).filter(
    (own) => !prefixRelated(parseKey(own), removed),
  );
}

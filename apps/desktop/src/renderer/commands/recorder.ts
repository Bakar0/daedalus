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
} from "@daedalus/protocol";
import { compileBindings, findConflicts } from "./dispatch";

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
  /** Backspace or Delete with no modifier: unbind the command. */
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
 */
export function recordKeyEvent(event: KeyEventLike): RecordedKey {
  if (isModifierOnly(event)) return { kind: "ignore" };
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
 * The commands that would claim `key` in the same place as `id` if `id`
 * were bound to it alone: the pairs `findConflicts` reports, as the
 * dispatcher would decide them only by table order.
 */
export function keyConflicts(
  id: CommandId,
  key: string,
  overrides: KeyOverrides,
): CommandId[] {
  const wanted = normalizeKey(key);
  const bindings = compileBindings(COMMAND_SPECS, {
    ...overrides,
    [id]: [key],
  });
  const others = new Set<CommandId>();
  for (const [a, b] of findConflicts(bindings)) {
    if (a.key !== wanted) continue;
    if (a.id === id) others.add(b.id);
    else if (b.id === id) others.add(a.id);
  }
  return [...others];
}

/** A command's keys without `key`, for taking it away when it is replaced. */
export function keysWithout(
  id: CommandId,
  key: string,
  overrides: KeyOverrides,
): string[] {
  const removed = normalizeKey(key);
  return keysOf(commandSpec(id), overrides).filter(
    (own) => normalizeKey(own) !== removed,
  );
}

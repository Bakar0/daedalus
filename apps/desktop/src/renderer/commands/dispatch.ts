import {
  type CommandArea,
  type CommandId,
  type CommandSpec,
  type CommandWhen,
  type KeyChord,
  type KeyEventLike,
  type KeyOverrides,
  type KeySequence,
  chordsFromEvent,
  isModifierOnly,
  isTypingChord,
  keysOf,
  menuAccelerator,
  normalizeKey,
  parseKey,
  sameChord,
} from "@daedalus/protocol";
import type { CommandContext } from "./context";

/**
 * One key of one command, compiled. A command with two keys has two bindings.
 * Pure data and pure functions, so the matcher, precedence and the terminal's
 * decision are tested without a window.
 */
export interface Binding {
  readonly id: CommandId;
  /** Canonical spelling, as `normalizeKey` writes it. */
  readonly key: string;
  readonly sequence: KeySequence;
  readonly when?: CommandWhen;
  /** Position in the table; earlier wins a tie. */
  readonly order: number;
  /**
   * The native menu owns this key: it is the accelerator of the command's
   * menu item, which the host builds from the same keys and overrides. macOS
   * delivers such a key through the menu, by id, so the dispatcher leaves it
   * alone and it never runs twice; a terminal still keeps it from the shell.
   */
  readonly native: boolean;
  readonly allowRepeat: boolean;
  readonly inModal: boolean;
}

/**
 * Compiles every key of every command. Keys are expected to be valid (the
 * defaults are tested; overrides go through `validateKeyOverrides`); one that
 * still does not parse throws, so a caller compiles before it commits.
 */
export function compileBindings(
  specs: readonly CommandSpec[],
  overrides: KeyOverrides = {},
): Binding[] {
  return specs.flatMap((spec, order) => {
    const id = spec.id as CommandId;
    const accelerator = menuAccelerator(spec, overrides);
    return keysOf(spec, overrides).map((key, index) => ({
      id,
      key: normalizeKey(key),
      sequence: parseKey(key),
      ...(spec.when ? { when: spec.when } : {}),
      order,
      // Only the first key is the menu item's accelerator; another key of the
      // same command, or a host command with no menu item, is the
      // dispatcher's to run.
      native: index === 0 && accelerator !== undefined,
      allowRepeat: spec.allowRepeat ?? false,
      inModal: spec.inModal ?? false,
    }));
  });
}

const GLOBAL_RANK = 1_000;

/**
 * How closely a binding fits where focus is: the position of the innermost
 * area it names (0 is the focused area itself), `GLOBAL_RANK` for a binding
 * that acts everywhere, or `undefined` when it does not act here at all.
 * A lower rank wins, so a key bound in the editor beats the same key bound in
 * the center, which beats it bound globally. For a key (`forKey`), the
 * areas its `keysNot` leaves alone count as well.
 */
export function rankIn(
  when: CommandWhen | undefined,
  areas: readonly CommandArea[],
  { forKey = true }: { forKey?: boolean } = {},
): number | undefined {
  if (when?.not?.some((area) => areas.includes(area))) return undefined;
  if (forKey && when?.keysNot?.some((area) => areas.includes(area)))
    return undefined;
  if (!when?.areas) return GLOBAL_RANK;
  const index = areas.findIndex((area) => when.areas?.includes(area));
  return index < 0 ? undefined : index;
}

const blockedByTyping = (binding: Binding, context: CommandContext) =>
  context.typing && binding.sequence.some(isTypingChord);

const startsWith = (sequence: KeySequence, typed: readonly KeyChord[]) =>
  typed.length <= sequence.length &&
  typed.every((chord, index) => {
    const own = sequence[index];
    return own !== undefined && sameChord(own, chord);
  });

/**
 * The bindings that act here for these chords, best first: by rank, then by
 * table order. Native bindings are included only when asked for. While a
 * dialog is open only `inModal` bindings act.
 */
export function applicableBindings(
  bindings: readonly Binding[],
  typed: readonly KeyChord[],
  context: CommandContext,
  { includeNative = false } = {},
): Binding[] {
  return bindings
    .flatMap((binding) => {
      if (binding.native && !includeNative) return [];
      if (context.modal && !binding.inModal) return [];
      if (blockedByTyping(binding, context)) return [];
      if (!startsWith(binding.sequence, typed)) return [];
      const rank = rankIn(binding.when, context.areas);
      return rank === undefined ? [] : [{ binding, rank }];
    })
    .sort((a, b) => a.rank - b.rank || a.binding.order - b.binding.order)
    .map(({ binding }) => binding);
}

export type IsEnabled = (id: CommandId, context: CommandContext) => boolean;

export type MatchResult =
  | { kind: "run"; binding: Binding }
  /** The chords so far begin a longer sequence: wait for the next one. */
  | { kind: "pending" }
  /** A held key repeating a command that does not repeat: swallow it. */
  | { kind: "repeat"; binding: Binding }
  | undefined;

/**
 * The best enabled binding for these chords decides: one whose keys are
 * exactly these chords runs; one that continues them makes the matcher wait.
 * So an exact match in the center does not shadow a longer sequence bound in
 * the editor, nor the other way round.
 */
export function matchChords(
  bindings: readonly Binding[],
  typed: readonly KeyChord[],
  context: CommandContext,
  isEnabled: IsEnabled,
): MatchResult {
  const best = applicableBindings(bindings, typed, context).find((binding) =>
    isEnabled(binding.id, context),
  );
  if (!best) return undefined;
  return best.sequence.length === typed.length
    ? { kind: "run", binding: best }
    : { kind: "pending" };
}

/** The first of an event's possible chords that means something here. */
function matchEvent(
  bindings: readonly Binding[],
  pending: readonly KeyChord[],
  event: KeyEventLike,
  context: CommandContext,
  isEnabled: IsEnabled,
): { result: MatchResult; typed: KeyChord[] } {
  for (const chord of chordsFromEvent(event)) {
    const typed = [...pending, chord];
    const result = matchChords(bindings, typed, context, isEnabled);
    if (result) return { result, typed };
  }
  return { result: undefined, typed: [] };
}

/** Keeps the chords of a sequence in progress between key presses. */
export class KeyMatcher {
  private pending: KeyChord[] = [];
  private pendingAt = 0;

  constructor(
    private readonly bindings: () => readonly Binding[],
    private readonly isEnabled: IsEnabled,
    private readonly timeoutMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Forgets a sequence in progress: focus moved, or the window lost it. */
  reset(): void {
    this.pending = [];
  }

  handle(
    event: KeyEventLike & Partial<Pick<KeyboardEvent, "repeat">>,
    context: CommandContext,
  ): MatchResult {
    if (isModifierOnly(event)) return undefined;
    if (this.pending.length > 0 && this.now() - this.pendingAt > this.timeoutMs)
      this.pending = [];
    const hadPending = this.pending.length > 0;
    const { result, typed } = matchEvent(
      this.bindings(),
      this.pending,
      event,
      context,
      this.isEnabled,
    );
    if (result?.kind === "pending") {
      this.pending = typed;
      this.pendingAt = this.now();
      return result;
    }
    this.pending = [];
    if (result?.kind === "run" && event.repeat && !result.binding.allowRepeat)
      return { kind: "repeat", binding: result.binding };
    if (result || !hadPending) return result;
    // A sequence that went nowhere: the last chord may start something.
    return this.handle(event, context);
  }
}

/** One sequence begins the other (equal sequences included). */
export const prefixRelated = (a: KeySequence, b: KeySequence) => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((chord, index) => {
    const other = long[index];
    return other !== undefined && sameChord(chord, other);
  });
};

/** Whether two bindings can be asked for with focus in the same place. */
const placesOverlap = (a: Binding, b: Binding) => {
  // A menu key fires wherever focus is, before any area's binding sees it.
  if (a.native || b.native) return true;
  const aAreas = a.when?.areas;
  const bAreas = b.when?.areas;
  if (!aAreas && !bAreas) return true;
  // A global binding and an area binding of the dispatcher's own are not
  // a conflict: in the area the area's wins, elsewhere the global one.
  if (!aAreas || !bAreas) return false;
  return aAreas.some((area) => bAreas.includes(area));
};

/**
 * Pairs of bindings that get in each other's way where focus can be in both
 * their places: the same keys, where only table order would decide; or one
 * sequence beginning the other (⌘K and ⌘K ⌘S), where the shorter runs at
 * once or the longer waits. A menu-owned key takes its chord everywhere, so
 * it conflicts with any binding that starts with that chord.
 */
export function findConflicts(
  bindings: readonly Binding[],
): [Binding, Binding][] {
  const conflicts: [Binding, Binding][] = [];
  bindings.forEach((a, index) => {
    for (const b of bindings.slice(index + 1)) {
      if (a.id === b.id) continue;
      if (!prefixRelated(a.sequence, b.sequence)) continue;
      if (placesOverlap(a, b)) conflicts.push([a, b]);
    }
  });
  return conflicts;
}

/**
 * Whether a key pressed in a terminal belongs to the app rather than the
 * shell: only a key an enabled command is bound to here (a menu's key
 * included, so the shell never sees it). Everything else, ⌃C, ⌃R, the ⌥
 * keys, function keys and plain typing, goes to the program.
 */
export function terminalKeepsKey(
  event: KeyEventLike,
  context: CommandContext,
  bindings: readonly Binding[],
  isEnabled: IsEnabled,
): boolean {
  return chordsFromEvent(event).some((chord) =>
    applicableBindings(bindings, [chord], context, {
      includeNative: true,
    }).some((binding) => binding.native || isEnabled(binding.id, context)),
  );
}

/**
 * Whether a held key repeating a native menu key should be swallowed:
 * macOS fires a menu's key equivalent on every repeat, so a held ⌘T would
 * make a terminal per repeat. The window sees the key first; marking it
 * handled keeps WebKit from passing it on to the menu. A command that
 * allows repeating keeps its repeats.
 */
export function swallowsNativeRepeat(
  event: KeyEventLike & Partial<Pick<KeyboardEvent, "repeat">>,
  context: CommandContext,
  bindings: readonly Binding[],
): boolean {
  if (!event.repeat) return false;
  return chordsFromEvent(event).some((chord) =>
    applicableBindings(bindings, [chord], context, {
      includeNative: true,
    }).some((binding) => binding.native && !binding.allowRepeat),
  );
}

/**
 * A key pressed while an input method composes text (Japanese, Chinese,
 * dead keys): it belongs to the composition, never to a command or a list.
 * WebKit marks such keys with `isComposing`, or `keyCode` 229.
 */
export const isComposingKey = (
  event: Partial<Pick<KeyboardEvent, "isComposing" | "keyCode">>,
): boolean => Boolean(event.isComposing) || event.keyCode === 229;

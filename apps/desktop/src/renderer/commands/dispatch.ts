import {
  type CommandArea,
  type CommandId,
  type CommandSpec,
  type CommandWhen,
  type KeyChord,
  type KeyEventLike,
  type KeySequence,
  chordFromEvent,
  isModifierOnly,
  isTypingChord,
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
   * The native menu owns this key (it is the accelerator of the command's
   * menu item), or the host runs the command. macOS delivers such a key
   * through the menu, so the dispatcher leaves it alone and it never runs
   * twice; a terminal still keeps it from the shell.
   */
  readonly native: boolean;
}

/** User keys per command, replacing the defaults (a later keybindings file). */
export type KeyOverrides = Partial<Record<CommandId, readonly string[]>>;

export function compileBindings(
  specs: readonly CommandSpec[],
  overrides: KeyOverrides = {},
): Binding[] {
  return specs.flatMap((spec, order) => {
    const id = spec.id as CommandId;
    const keys = overrides[id] ?? spec.keys;
    const accelerator = menuAccelerator(spec);
    return keys.map((key, index) => ({
      id,
      key: normalizeKey(key),
      sequence: parseKey(key),
      ...(spec.when ? { when: spec.when } : {}),
      order,
      native:
        spec.runsIn === "host" ||
        // Only the first key is the menu item's accelerator, and only while
        // it is still the default the host built the menu from.
        (index === 0 && accelerator !== undefined && !overrides[id]),
    }));
  });
}

const GLOBAL_RANK = 1_000;

/**
 * How closely a binding fits where focus is: the position of the innermost
 * area it names (0 is the focused area itself), `GLOBAL_RANK` for a binding
 * that acts everywhere, or `undefined` when it does not act here at all.
 * A lower rank wins, so a key bound in the editor beats the same key bound in
 * the center, which beats it bound globally.
 */
export function rankIn(
  when: CommandWhen | undefined,
  areas: readonly CommandArea[],
): number | undefined {
  if (when?.not?.some((area) => areas.includes(area))) return undefined;
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
 * table order. Native bindings are included only when asked for.
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
  | undefined;

/**
 * The first enabled binding whose keys are exactly these chords; failing
 * that, whether an enabled binding continues them.
 */
export function matchChords(
  bindings: readonly Binding[],
  typed: readonly KeyChord[],
  context: CommandContext,
  isEnabled: IsEnabled,
): MatchResult {
  const candidates = applicableBindings(bindings, typed, context).filter(
    (binding) => isEnabled(binding.id, context),
  );
  const exact = candidates.find(
    (binding) => binding.sequence.length === typed.length,
  );
  if (exact) return { kind: "run", binding: exact };
  return candidates.length > 0 ? { kind: "pending" } : undefined;
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

  handle(
    event: KeyEventLike & Pick<KeyboardEvent, "key">,
    context: CommandContext,
  ): MatchResult {
    if (isModifierOnly(event)) return undefined;
    const chord = chordFromEvent(event);
    if (this.pending.length > 0 && this.now() - this.pendingAt > this.timeoutMs)
      this.pending = [];
    const typed = [...this.pending, chord];
    const result = matchChords(this.bindings(), typed, context, this.isEnabled);
    if (result?.kind === "pending") {
      this.pending = typed;
      this.pendingAt = this.now();
      return result;
    }
    const hadPending = this.pending.length > 0;
    this.pending = [];
    if (result || !hadPending) return result;
    // A sequence that went nowhere: the last chord may start something.
    return this.handle(event, context);
  }
}

/**
 * Pairs of bindings that claim the same keys in overlapping places with the
 * same precedence, where only table order would decide. A global binding
 * and an area binding of the same key are not a conflict: the area wins.
 */
export function findConflicts(
  bindings: readonly Binding[],
): [Binding, Binding][] {
  const conflicts: [Binding, Binding][] = [];
  bindings.forEach((a, index) => {
    for (const b of bindings.slice(index + 1)) {
      if (a.key !== b.key || a.id === b.id) continue;
      const aAreas = a.when?.areas;
      const bAreas = b.when?.areas;
      const overlap =
        !aAreas && !bAreas
          ? true
          : Boolean(aAreas && bAreas?.some((area) => aAreas.includes(area)));
      if (overlap) conflicts.push([a, b]);
    }
  });
  return conflicts;
}

/** Keys a terminal always gives the app: area cycling and the panel toggle. */
const TERMINAL_RESERVED = (chord: KeyChord) =>
  chord.key === "f6" ||
  (chord.key === "`" && chord.ctrl && !chord.mod && !chord.alt && !chord.shift);

/**
 * Whether a key pressed in a terminal belongs to the app rather than the
 * shell: F6, ⌃`, and a key an enabled command is bound to here (a menu's key
 * included, so the shell never sees it). Everything else, ⌃C, ⌃R, the ⌥
 * keys and plain typing, goes to the program.
 */
export function terminalKeepsKey(
  event: KeyEventLike,
  context: CommandContext,
  bindings: readonly Binding[],
  isEnabled: IsEnabled,
): boolean {
  const chord = chordFromEvent(event);
  if (TERMINAL_RESERVED(chord)) return true;
  return applicableBindings(bindings, [chord], context, {
    includeNative: true,
  }).some((binding) => binding.native || isEnabled(binding.id, context));
}

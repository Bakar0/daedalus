/**
 * Keys as data. A key is written the way a keybindings file would write it:
 * a chord such as `mod+shift+]`, or a sequence of chords separated by spaces
 * such as `mod+k mod+s`. `mod` is ⌘ (the app is macOS only). The same string
 * is parsed for the renderer's matcher, formatted as glyphs for menus, the
 * palette and tooltips, as `aria-keyshortcuts`, and as a native menu
 * accelerator, so a key is written once and shown the same everywhere.
 */

export interface KeyChord {
  /** The base key, lower case: `s`, `]`, `` ` ``, `up`, `escape`, `f6`. */
  readonly key: string;
  /** ⌘ */
  readonly mod: boolean;
  /** ⌃ */
  readonly ctrl: boolean;
  /** ⌥ */
  readonly alt: boolean;
  /** ⇧ */
  readonly shift: boolean;
}

export type KeySequence = readonly KeyChord[];

const MODIFIER_ALIASES: Record<string, "mod" | "ctrl" | "alt" | "shift"> = {
  mod: "mod",
  cmd: "mod",
  command: "mod",
  meta: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  shift: "shift",
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  del: "delete",
  " ": "space",
  spacebar: "space",
  backquote: "`",
  plus: "+",
};

const NAMED_KEYS = new Set([
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "contextmenu",
]);

const isFunctionKey = (key: string) => /^f([1-9]|1[0-9]|2[0-4])$/.test(key);

const validKey = (key: string) =>
  NAMED_KEYS.has(key) || isFunctionKey(key) || /^[\x21-\x7e]$/.test(key);

/** Parses `mod+shift+]` or `mod+k mod+s`. Throws on a key it cannot read. */
export function parseKey(text: string): KeySequence {
  const chords = text.trim().split(/\s+/).filter(Boolean);
  if (chords.length === 0) throw new Error(`Empty key: "${text}"`);
  return chords.map((chord) => parseChord(chord, text));
}

function parseChord(chord: string, whole: string): KeyChord {
  // `mod++` binds the plus key: the last `+` that ends the chord is the key.
  const parts = chord.endsWith("++")
    ? [...chord.slice(0, -2).split("+"), "+"]
    : chord.split("+");
  const keyPart = parts.pop()?.toLowerCase() ?? "";
  const key = KEY_ALIASES[keyPart] ?? keyPart;
  const flags = { mod: false, ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) throw new Error(`Unknown modifier "${part}" in "${whole}"`);
    flags[modifier] = true;
  }
  if (!validKey(key)) throw new Error(`Unknown key "${keyPart}" in "${whole}"`);
  return { key, ...flags };
}

/** The canonical spelling of a key, so two spellings of one key compare. */
export function normalizeKey(text: string): string {
  return parseKey(text).map(chordText).join(" ");
}

/** One chord written as a keybindings file writes it: `shift+mod+]`. */
export function chordText(chord: KeyChord): string {
  return [
    chord.ctrl && "ctrl",
    chord.alt && "alt",
    chord.shift && "shift",
    chord.mod && "mod",
    chord.key,
  ]
    .filter(Boolean)
    .join("+");
}

export const sameChord = (a: KeyChord, b: KeyChord) =>
  a.key === b.key &&
  a.mod === b.mod &&
  a.ctrl === b.ctrl &&
  a.alt === b.alt &&
  a.shift === b.shift;

/**
 * A chord with no ⌘, ⌃ or ⌥ types a character (or moves the caret) when an
 * input has focus, so it never acts as a command there. Function keys are the
 * exception: nothing types them.
 */
export const isTypingChord = (chord: KeyChord) =>
  !chord.mod && !chord.ctrl && !chord.alt && !isFunctionKey(chord.key);

const CODE_KEYS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Backslash: "\\",
  Space: "space",
};

const EVENT_KEY_NAMES: Record<string, string> = {
  Escape: "escape",
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ContextMenu: "contextmenu",
};

/** The fields of a `KeyboardEvent` the matcher reads. */
export type KeyEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

const keyFromCode = (code: string): string | undefined => {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) return letter.toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit) return digit;
  return CODE_KEYS[code];
};

/** The key an event's `key` names, before any fallback to the physical key. */
const keyFromKey = (key: string): string | undefined => {
  const named = EVENT_KEY_NAMES[key];
  if (named) return named;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toLowerCase();
  if (key === " ") return "space";
  if (/^[\x21-\x7e]$/.test(key)) return key.toLowerCase();
  return undefined;
};

/**
 * The chords an event may mean, best first. The layout's character comes
 * first, so ⌘/ matches on a German keyboard, where / is ⇧7; when ⇧ was needed
 * to type a punctuation character it is also tried without ⇧. The physical
 * key comes last, and only when the layout produced no plain letter or
 * digit: that is what turns ⌥⌘B (which types ∫) and ⇧⌘] (which types }) into
 * their chords, without making Dvorak's ⌘X mean the key QWERTY calls B.
 */
export function chordsFromEvent(event: KeyEventLike): KeyChord[] {
  const modifiers = {
    mod: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
  const chords: KeyChord[] = [];
  const add = (chord: KeyChord) => {
    if (!chords.some((known) => sameChord(known, chord))) chords.push(chord);
  };
  const fromKey = keyFromKey(event.key);
  if (fromKey) {
    add({ ...modifiers, key: fromKey });
    if (
      event.shiftKey &&
      /^[\x21-\x7e]$/.test(fromKey) &&
      !/^[a-z0-9]$/.test(fromKey)
    )
      add({ ...modifiers, key: fromKey, shift: false });
  }
  if (!fromKey || !/^[a-z0-9]$/.test(fromKey) || event.altKey) {
    const fromCode = keyFromCode(event.code);
    if (fromCode) add({ ...modifiers, key: fromCode });
  }
  if (chords.length === 0) add({ ...modifiers, key: event.key.toLowerCase() });
  return chords;
}

/** The event's best chord; see `chordsFromEvent`. */
export function chordFromEvent(event: KeyEventLike): KeyChord {
  return chordsFromEvent(event)[0] as KeyChord;
}

/** A press of ⌘, ⇧, ⌥ or ⌃ alone, which never starts or breaks a chord. */
export const isModifierOnly = (event: Pick<KeyboardEvent, "key">) =>
  ["Meta", "Shift", "Alt", "Control", "CapsLock", "Fn", "OS"].includes(
    event.key,
  );

const GLYPHS: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  escape: "⎋",
  enter: "↩",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
  space: "Space",
  home: "↖",
  end: "↘",
  pageup: "⇞",
  pagedown: "⇟",
  contextmenu: "Menu",
};

const keyGlyph = (key: string) =>
  GLYPHS[key] ?? (isFunctionKey(key) ? key.toUpperCase() : key.toUpperCase());

/**
 * The key as macOS shows it: modifiers in the HIG order ⌃⌥⇧⌘, then the key,
 * as in `⇧⌘]`. A sequence puts a space between its chords.
 */
export function formatKeyGlyphs(text: string): string {
  return parseKey(text)
    .map(
      (chord) =>
        `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.mod ? "⌘" : ""}${keyGlyph(chord.key)}`,
    )
    .join(" ");
}

const ARIA_KEYS: Record<string, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  escape: "Escape",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  space: "Space",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  contextmenu: "ContextMenu",
};

/**
 * The `aria-keyshortcuts` value for some keys: each chord as
 * `Control+Alt+Shift+Meta+Key`, alternatives separated by spaces. ARIA has
 * no way to write a sequence, so sequences are left out.
 */
export function formatAriaKeyShortcuts(keys: readonly string[]): string {
  return keys
    .map(parseKey)
    .filter((sequence) => sequence.length === 1)
    .map((sequence) => {
      const chord = sequence[0] as KeyChord;
      return [
        chord.ctrl && "Control",
        chord.alt && "Alt",
        chord.shift && "Shift",
        chord.mod && "Meta",
        ARIA_KEYS[chord.key] ??
          (isFunctionKey(chord.key)
            ? chord.key.toUpperCase()
            : chord.key.toUpperCase()),
      ]
        .filter(Boolean)
        .join("+");
    })
    .join(" ");
}

const ACCELERATOR_KEYS: Record<string, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  escape: "Escape",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  space: "Space",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/**
 * The native menu accelerator for a key, as Electrobun spells it:
 * `Command+Shift+Q`, `Command+Option+4`, `Control+\``. A menu item can show
 * only one chord, so a sequence has none.
 */
export function formatAccelerator(text: string): string | undefined {
  const sequence = parseKey(text);
  if (sequence.length !== 1) return undefined;
  const chord = sequence[0] as KeyChord;
  return [
    chord.mod && "Command",
    chord.ctrl && "Control",
    chord.alt && "Option",
    chord.shift && "Shift",
    ACCELERATOR_KEYS[chord.key] ?? chord.key.toUpperCase(),
  ]
    .filter(Boolean)
    .join("+");
}

/**
 * Chords macOS or the app's native menu roles take before the app could see
 * them: app switching, Spotlight and input sources, screenshots, Force Quit,
 * lock screen, Hide / Hide Others / Minimize, and the Edit menu's
 * cut/copy/paste/select all/undo/redo. Binding one would either never fire
 * or break that system key, so a keybindings file, Settings and the CLI all
 * refuse them.
 */
const RESERVED_CHORDS: Record<string, string> = {
  "mod+tab": "macOS switches apps with ⌘⇥",
  "shift+mod+tab": "macOS switches apps with ⇧⌘⇥",
  "mod+`": "macOS cycles an app's windows with ⌘`",
  "mod+space": "Spotlight takes ⌘Space",
  "alt+mod+space": "Finder search takes ⌥⌘Space",
  "ctrl+space": "macOS switches input sources with ⌃Space",
  "shift+mod+3": "macOS takes screenshots with ⇧⌘3",
  "shift+mod+4": "macOS takes screenshots with ⇧⌘4",
  "shift+mod+5": "macOS takes screenshots with ⇧⌘5",
  "alt+mod+escape": "⌥⌘⎋ is Force Quit",
  "ctrl+mod+q": "⌃⌘Q locks the screen",
  "mod+h": "⌘H hides the app (Daedalus › Hide)",
  "alt+mod+h": "⌥⌘H hides other apps",
  "mod+m": "⌘M minimizes the window (Window › Minimize)",
  "mod+c": "⌘C is Copy",
  "mod+v": "⌘V is Paste",
  "mod+x": "⌘X is Cut",
  "mod+a": "⌘A is Select All",
  "mod+z": "⌘Z is Undo",
  "shift+mod+z": "⇧⌘Z is Redo",
};

/**
 * Why a key cannot be bound, or undefined when it can. Only the first chord
 * of a sequence matters: macOS takes it before the rest is typed.
 */
export function reservedKeyReason(text: string): string | undefined {
  const first = parseKey(text)[0];
  return first ? RESERVED_CHORDS[chordText(first)] : undefined;
}

/**
 * Why a key that may be bound is still a risk, or undefined when it is not:
 * ⌘Q (a slip quits), ⌃ and a letter (a terminal's control keys: ⌃C, ⌃D,
 * ⌃R...; bound, the shell never gets it), and a key with no ⌘, ⌃ or ⌥ (it
 * acts only outside text fields and terminals, and takes the key from lists
 * and the tree, where letters and arrows move). Settings asks before
 * binding one; a keybindings file and the CLI accept it.
 */
export function keyWarning(text: string): string | undefined {
  const first = parseKey(text)[0];
  if (!first) return undefined;
  const written = chordText(first);
  if (written === "mod+q")
    return "⌘Q quits Daedalus everywhere else on a Mac; a slip would quit it here too.";
  if (first.ctrl && !first.mod && !first.alt && /^[a-z]$/.test(first.key))
    return `${formatKeyGlyphs(text)} is a terminal control key; bound, the shell and agents never get it.`;
  if (isTypingChord(first))
    return `${formatKeyGlyphs(text)} has no ⌘, ⌃ or ⌥: it acts only outside text fields and terminals, and lists and the sidebar tree lose it.`;
  return undefined;
}

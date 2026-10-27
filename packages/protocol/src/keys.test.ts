import { describe, expect, test } from "vitest";
import {
  chordFromEvent,
  formatAccelerator,
  formatAriaKeyShortcuts,
  formatKeyGlyphs,
  isTypingChord,
  normalizeKey,
  parseKey,
  sameChord,
} from "./keys";

const press = (
  key: string,
  code: string,
  modifiers: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("parseKey", () => {
  test("reads a chord, its modifiers in any order and spelling", () => {
    expect(parseKey("mod+shift+]")).toEqual([
      { key: "]", mod: true, ctrl: false, alt: false, shift: true },
    ]);
    expect(normalizeKey("Shift+Cmd+]")).toBe(normalizeKey("mod+shift+]"));
    expect(normalizeKey("option+command+B")).toBe("alt+mod+b");
    expect(normalizeKey("ctrl+`")).toBe("ctrl+`");
    expect(normalizeKey("esc")).toBe("escape");
  });

  test("reads a sequence of chords", () => {
    expect(parseKey("mod+k mod+s")).toHaveLength(2);
    expect(normalizeKey("g  b")).toBe("g b");
  });

  test("binds the plus key itself", () => {
    expect(parseKey("mod++")[0]?.key).toBe("+");
  });

  test("refuses what it cannot read", () => {
    expect(() => parseKey("")).toThrow();
    expect(() => parseKey("hyper+k")).toThrow();
    expect(() => parseKey("mod+banana")).toThrow();
  });
});

describe("chordFromEvent", () => {
  test("letters come from the layout's key", () => {
    expect(chordFromEvent(press("s", "KeyS", { metaKey: true }))).toEqual(
      parseKey("mod+s")[0],
    );
    expect(chordFromEvent(press("S", "KeyS", { shiftKey: true })).key).toBe(
      "s",
    );
  });

  test("⌥ and ⇧ fall back to the physical key", () => {
    // ⌥⌘B types ∫ on a US layout; ⇧] types }.
    expect(
      sameChord(
        chordFromEvent(press("∫", "KeyB", { metaKey: true, altKey: true })),
        parseKey("mod+alt+b")[0]!,
      ),
    ).toBe(true);
    expect(
      sameChord(
        chordFromEvent(
          press("}", "BracketRight", { metaKey: true, shiftKey: true }),
        ),
        parseKey("mod+shift+]")[0]!,
      ),
    ).toBe(true);
    expect(
      chordFromEvent(press("¡", "Digit1", { metaKey: true, altKey: true })).key,
    ).toBe("1");
  });

  test("named keys and function keys", () => {
    expect(chordFromEvent(press("Escape", "Escape")).key).toBe("escape");
    expect(chordFromEvent(press("ArrowUp", "ArrowUp")).key).toBe("up");
    expect(chordFromEvent(press("F6", "F6")).key).toBe("f6");
    expect(chordFromEvent(press(" ", "Space")).key).toBe("space");
  });

  test("modifiers must match exactly", () => {
    expect(
      sameChord(
        chordFromEvent(press("s", "KeyS", { metaKey: true, altKey: true })),
        parseKey("mod+s")[0]!,
      ),
    ).toBe(false);
  });
});

describe("isTypingChord", () => {
  test("a key without ⌘, ⌃ or ⌥ types, except a function key", () => {
    expect(isTypingChord(parseKey("j")[0]!)).toBe(true);
    expect(isTypingChord(parseKey("shift+/")[0]!)).toBe(true);
    expect(isTypingChord(parseKey("escape")[0]!)).toBe(true);
    expect(isTypingChord(parseKey("f6")[0]!)).toBe(false);
    expect(isTypingChord(parseKey("mod+k")[0]!)).toBe(false);
    expect(isTypingChord(parseKey("ctrl+`")[0]!)).toBe(false);
  });
});

describe("formatKeyGlyphs", () => {
  test("puts modifiers in the HIG order ⌃⌥⇧⌘", () => {
    expect(formatKeyGlyphs("mod+shift+]")).toBe("⇧⌘]");
    expect(formatKeyGlyphs("shift+mod+alt+ctrl+k")).toBe("⌃⌥⇧⌘K");
    expect(formatKeyGlyphs("mod+alt+b")).toBe("⌥⌘B");
    expect(formatKeyGlyphs("ctrl+`")).toBe("⌃`");
  });

  test("shows named keys as glyphs and sequences with a space", () => {
    expect(formatKeyGlyphs("alt+mod+up")).toBe("⌥⌘↑");
    expect(formatKeyGlyphs("escape")).toBe("⎋");
    expect(formatKeyGlyphs("shift+f6")).toBe("⇧F6");
    expect(formatKeyGlyphs("mod+k mod+s")).toBe("⌘K ⌘S");
  });
});

describe("formatAriaKeyShortcuts", () => {
  test("writes each chord the ARIA way, alternatives separated by spaces", () => {
    expect(formatAriaKeyShortcuts(["mod+shift+]"])).toBe("Shift+Meta+]");
    expect(formatAriaKeyShortcuts(["mod+s", "ctrl+alt+up"])).toBe(
      "Meta+S Control+Alt+ArrowUp",
    );
  });

  test("leaves out sequences, which ARIA cannot express", () => {
    expect(formatAriaKeyShortcuts(["g b"])).toBe("");
  });
});

describe("formatAccelerator", () => {
  test("spells keys as the existing menu did", () => {
    expect(formatAccelerator("mod+q")).toBe("Command+Q");
    expect(formatAccelerator("mod+shift+q")).toBe("Command+Shift+Q");
    expect(formatAccelerator("mod+alt+4")).toBe("Command+Option+4");
    expect(formatAccelerator("ctrl+`")).toBe("Control+`");
  });

  test("has nothing for a sequence", () => {
    expect(formatAccelerator("mod+k mod+s")).toBeUndefined();
  });
});

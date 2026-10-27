import { describe, expect, test } from "vitest";
import {
  COMMAND_SPECS,
  type KeyEventLike,
  keyWarning,
  normalizeKey,
  reservedKeyReason,
} from "@daedalus/protocol";
import {
  clearedKeys,
  keyConflicts,
  keysWithout,
  recordKeyEvent,
  recordedKeys,
} from "./recorder";
import { compileBindings, findConflicts } from "./dispatch";

const press = (
  key: string,
  code: string,
  modifiers: Partial<
    Pick<KeyEventLike, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
  > = {},
): KeyEventLike => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("the key recorder", () => {
  test("records a chord as a keybindings file writes it", () => {
    expect(
      recordKeyEvent(press("p", "KeyP", { metaKey: true, shiftKey: true })),
    ).toEqual({
      kind: "key",
      key: "shift+mod+p",
    });
    expect(recordKeyEvent(press("F6", "F6"))).toEqual({
      kind: "key",
      key: "f6",
    });
    // ⌥⌘B types ∫; the physical key is what is meant.
    expect(
      recordKeyEvent(press("∫", "KeyB", { metaKey: true, altKey: true })),
    ).toEqual({ kind: "key", key: "alt+mod+b" });
  });

  test("records ⇧ with punctuation as the key the defaults name", () => {
    // ⇧⌘] types }: recorded as the default ⇧⌘] is written.
    const recorded = recordKeyEvent(
      press("}", "BracketRight", { metaKey: true, shiftKey: true }),
    );
    expect(recorded).toEqual({ kind: "key", key: "shift+mod+]" });
    expect(normalizeKey("mod+shift+]")).toBe(
      recorded.kind === "key" ? recorded.key : "",
    );
  });

  test("a modifier alone keeps listening; Escape cancels; Backspace and Delete clear", () => {
    expect(
      recordKeyEvent(press("Meta", "MetaLeft", { metaKey: true })),
    ).toEqual({
      kind: "ignore",
    });
    expect(recordKeyEvent(press("Escape", "Escape"))).toEqual({
      kind: "cancel",
    });
    expect(recordKeyEvent(press("Backspace", "Backspace"))).toEqual({
      kind: "clear",
    });
    expect(recordKeyEvent(press("Delete", "Delete"))).toEqual({
      kind: "clear",
    });
    // With a modifier they are keys like any other.
    expect(
      recordKeyEvent(press("Backspace", "Backspace", { metaKey: true })),
    ).toEqual({ kind: "key", key: "mod+backspace" });
    expect(
      recordKeyEvent(press("Escape", "Escape", { shiftKey: true })),
    ).toEqual({ kind: "key", key: "shift+escape" });
  });

  test("a dead key with ⌥ records its physical key; composing text is left alone", () => {
    // ⌥E, ⌥N, ⌥U and ⌥` are dead keys on a US layout: the key is "Dead".
    for (const [code, key] of [
      ["KeyE", "alt+e"],
      ["KeyN", "alt+n"],
      ["KeyU", "alt+u"],
      ["Backquote", "alt+`"],
    ])
      expect(
        recordKeyEvent({
          ...press("Dead", code!, { altKey: true }),
          isComposing: true,
          keyCode: 229,
        }),
      ).toEqual({ kind: "key", key });
    expect(
      recordKeyEvent({
        ...press("Dead", "KeyE", { altKey: true, metaKey: true }),
        keyCode: 229,
      }),
    ).toEqual({ kind: "key", key: "alt+mod+e" });
    // Typed alone or with ⇧, it is text for the input method.
    expect(
      recordKeyEvent({ ...press("a", "KeyA"), isComposing: true }),
    ).toEqual({ kind: "ignore" });
    expect(
      recordKeyEvent({
        ...press("Process", "KeyA", { shiftKey: true }),
        keyCode: 229,
      }),
    ).toEqual({ kind: "ignore" });
  });

  test("a key that names nothing is ignored", () => {
    expect(recordKeyEvent(press("Unidentified", ""))).toEqual({
      kind: "ignore",
    });
  });
});

describe("conflicts in the editor", () => {
  test("names the command already on the key in the same place", () => {
    expect(keyConflicts("view.board", "mod+n", {})).toEqual(["session.new"]);
    // Rebinding away first leaves no conflict.
    expect(
      keyConflicts("view.board", "mod+n", { "session.new": ["mod+shift+j"] }),
    ).toEqual([]);
    // A spelling of the same key is the same key.
    expect(keyConflicts("view.board", "cmd+N", {})).toEqual(["session.new"]);
  });

  test("an area key and a global key of the dispatcher's are no conflict: the area wins", () => {
    // F6 is the dispatcher's (the menu only shows it): ⌘W in the tabs still
    // closes the tab, F6's command elsewhere.
    expect(keyConflicts("area.next", "mod+w", {})).toEqual([]);
    // Two tab keys collide.
    expect(keyConflicts("tab.next", "mod+w", {})).toEqual(["tab.close"]);
  });

  test("a menu-owned key conflicts with an area key too: the menu fires first", () => {
    // The Board's ⌘2 is its menu item's accelerator, so ⌘W there would
    // never reach the tabs.
    expect(keyConflicts("view.board", "mod+w", {})).toEqual(["tab.close"]);
    expect(keyConflicts("tab.close", "mod+2", {})).toEqual(["view.board"]);
  });

  test("one sequence beginning another is a conflict", () => {
    // ⌘K opens the palette at once, so ⌘K ⌘S would never be typed.
    expect(keyConflicts("view.board", "mod+k mod+s", {})).toEqual([
      "palette.open",
    ]);
    const bindings = compileBindings(COMMAND_SPECS, {
      "area.next": ["mod+j mod+j"],
      "area.previous": ["mod+j"],
    });
    expect(
      findConflicts(bindings).map(([a, b]) => [a.id, b.id]),
    ).toContainEqual(["area.next", "area.previous"]);
    // A sequence starting with a menu key's chord, in any area.
    expect(keyConflicts("tab.close", "mod+n mod+w", {})).toEqual([
      "session.new",
    ]);
  });

  test("a command's own key is no conflict", () => {
    expect(keyConflicts("session.new", "mod+n", {})).toEqual([]);
  });

  test("replacing takes the key from the other command and keeps its others", () => {
    expect(keysWithout("session.new", "mod+n", {})).toEqual([]);
    expect(keysWithout("item.menu", "contextmenu", {})).toEqual(["shift+f10"]);
    // A key that begins the new one goes too.
    expect(keysWithout("palette.open", "mod+k mod+s", {})).toEqual([]);
  });

  test("a recorded key replaces only the first key; ⌫ removes only that", () => {
    expect(recordedKeys("item.menu", "mod+i", {})).toEqual([
      "mod+i",
      "contextmenu",
    ]);
    expect(recordedKeys("item.menu", "contextmenu", {})).toEqual([
      "contextmenu",
    ]);
    expect(recordedKeys("view.board", "mod+shift+b", {})).toEqual([
      "mod+shift+b",
    ]);
    expect(clearedKeys("item.menu", {})).toEqual(["contextmenu"]);
    expect(clearedKeys("view.board", {})).toEqual([]);
  });
});

describe("reserved and risky keys", () => {
  test("keys macOS or the Edit menu own are reserved", () => {
    for (const key of [
      "mod+tab",
      "mod+c",
      "mod+shift+z",
      "cmd+h",
      "mod+m",
      "mod+space",
      "mod+shift+4",
      "mod+tab mod+x",
      "mod+alt+shift+v",
      "ctrl+mod+space",
      "mod+shift+/",
      "mod+?",
    ])
      expect(reservedKeyReason(key)).toBeDefined();
    for (const key of ["mod+q", "mod+n", "ctrl+c", "f6", "mod+k mod+c"])
      expect(reservedKeyReason(key)).toBeUndefined();
  });

  // So no setting to turn single-letter keys off is needed yet: no command
  // has a key that types a character.
  test("no default key is a printable key with no modifier", () => {
    for (const spec of COMMAND_SPECS)
      for (const key of spec.keys)
        expect(/^(shift\+)?[\x21-\x7e]$/.test(normalizeKey(key))).toBe(false);
  });

  test("no default key is reserved", () => {
    for (const spec of COMMAND_SPECS)
      for (const key of spec.keys)
        expect(reservedKeyReason(key)).toBeUndefined();
  });

  test("⌘Q, ⌃ and a letter, and a key with no ⌘ ⌃ ⌥ are warned about", () => {
    expect(keyWarning("mod+q")).toMatch(/quits/);
    expect(keyWarning("ctrl+c")).toMatch(/control key terminals/);
    expect(keyWarning("ctrl+shift+c")).toMatch(/control key terminals/);
    expect(keyWarning("j")).toMatch(/no ⌘, ⌃ or ⌥/);
    expect(keyWarning("shift+enter")).toMatch(/no ⌘, ⌃ or ⌥/);
    for (const key of ["mod+n", "ctrl+`", "f6", "shift+f6", "alt+mod+b"])
      expect(keyWarning(key)).toBeUndefined();
  });
});

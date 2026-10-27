import { describe, expect, test } from "vitest";
import {
  COMMAND_SPECS,
  type KeyEventLike,
  keyWarning,
  normalizeKey,
  reservedKeyReason,
} from "@daedalus/protocol";
import { keyConflicts, keysWithout, recordKeyEvent } from "./recorder";

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

  test("an area key and a global key are no conflict: the area wins", () => {
    // ⌘W closes a tab only in the tabs; a global ⌘W elsewhere is fine.
    expect(keyConflicts("view.board", "mod+w", {})).toEqual([]);
    // Two tab keys collide.
    expect(keyConflicts("tab.next", "mod+w", {})).toEqual(["tab.close"]);
  });

  test("a command's own key is no conflict", () => {
    expect(keyConflicts("session.new", "mod+n", {})).toEqual([]);
  });

  test("replacing takes the key from the other command and keeps its others", () => {
    expect(keysWithout("session.new", "mod+n", {})).toEqual([]);
    expect(keysWithout("item.menu", "contextmenu", {})).toEqual(["shift+f10"]);
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
    expect(keyWarning("ctrl+c")).toMatch(/terminal control key/);
    expect(keyWarning("j")).toMatch(/no ⌘, ⌃ or ⌥/);
    expect(keyWarning("shift+enter")).toMatch(/no ⌘, ⌃ or ⌥/);
    for (const key of ["mod+n", "ctrl+`", "f6", "shift+f6", "alt+mod+b"])
      expect(keyWarning(key)).toBeUndefined();
  });
});

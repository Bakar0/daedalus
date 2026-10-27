import { describe, expect, test } from "vitest";
import {
  COMMAND_SPECS,
  type CommandArea,
  type CommandId,
  type CommandSpec,
} from "@daedalus/protocol";
import {
  type CommandContext,
  type ElementLike,
  contextFor,
  typingOutsideTerminal,
} from "./context";
import {
  KeyMatcher,
  applicableBindings,
  compileBindings,
  findConflicts,
  isComposingKey,
  matchChords,
  rankIn,
  swallowsNativeRepeat,
  terminalKeepsKey,
} from "./dispatch";
import { chordFromEvent } from "@daedalus/protocol";

// --- helpers ---------------------------------------------------------------

const el = (
  tagName: string,
  attributes: Record<string, string> = {},
  classes: string[] = [],
  parentElement: ElementLike | null = null,
): ElementLike => ({
  tagName,
  parentElement,
  getAttribute: (name) => attributes[name] ?? null,
  classList: { contains: (token) => classes.includes(token) },
});

const context = (
  areas: CommandArea[],
  typing = false,
  source: CommandContext["source"] = "key",
  modal = false,
): CommandContext => ({ areas, typing, target: null, source, modal });

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

const cmd = (key: string, code: string) => press(key, code, { metaKey: true });

const always = () => true;
const id = (value: string) => value as CommandId;

const spec = (
  value: string,
  keys: string[],
  extra: Partial<CommandSpec> = {},
): CommandSpec => ({ id: value, title: value, group: "View", keys, ...extra });

const realBindings = compileBindings(COMMAND_SPECS);

// The DOM a session terminal sits in: center > tabs > xterm > textarea.
const center = el("SECTION", { "data-area": "center" });
const tabs = el("DIV", { "data-area": "tabs" }, [], center);
const xterm = el("DIV", {}, ["xterm"], tabs);
const xtermInput = el("TEXTAREA", {}, ["xterm-helper-textarea"], xterm);
const monaco = el("DIV", {}, ["monaco-editor"], tabs);
const monacoInput = el("TEXTAREA", {}, [], monaco);
const preview = el("DIV", { tabindex: "0" }, [], tabs);
const sidebar = el("ASIDE", { "data-area": "sidebar" });
const sidebarButton = el("BUTTON", {}, [], sidebar);
const sidebarInput = el("INPUT", { type: "text" }, [], sidebar);
const integratedPanel = el("SECTION", { "data-area": "terminal-panel" });
const integratedXterm = el("DIV", {}, ["xterm"], integratedPanel);
const integratedInput = el("TEXTAREA", {}, [], integratedXterm);

// --- context ---------------------------------------------------------------

describe("contextFor", () => {
  test("lists the areas focus is inside, innermost first", () => {
    expect(contextFor(xtermInput, "key").areas).toEqual([
      "terminal",
      "tabs",
      "center",
    ]);
    expect(contextFor(monacoInput, "key").areas).toEqual([
      "editor",
      "tabs",
      "center",
    ]);
    expect(contextFor(sidebarButton, "key").areas).toEqual(["sidebar"]);
    expect(contextFor(null, "menu").areas).toEqual([]);
  });

  test("knows when focus is in something that types", () => {
    expect(contextFor(xtermInput, "key").typing).toBe(true);
    expect(contextFor(monacoInput, "key").typing).toBe(true);
    expect(contextFor(sidebarInput, "key").typing).toBe(true);
    expect(contextFor(el("DIV", { contenteditable: "" }), "key").typing).toBe(
      true,
    );
    expect(contextFor(sidebarButton, "key").typing).toBe(false);
    expect(contextFor(preview, "key").typing).toBe(false);
    expect(
      contextFor(el("INPUT", { type: "checkbox" }, [], sidebar), "key").typing,
    ).toBe(false);
  });

  test("ignores a data-area it does not know", () => {
    expect(
      contextFor(el("DIV", { "data-area": "nowhere" }), "key").areas,
    ).toEqual([]);
  });
});

// --- precedence ------------------------------------------------------------

describe("typingOutsideTerminal", () => {
  test("a field or Monaco counts, a terminal or a button does not", () => {
    expect(typingOutsideTerminal(contextFor(sidebarInput, "key"))).toBe(true);
    expect(typingOutsideTerminal(contextFor(monacoInput, "key"))).toBe(true);
    expect(typingOutsideTerminal(contextFor(xtermInput, "key"))).toBe(false);
    expect(typingOutsideTerminal(contextFor(integratedInput, "key"))).toBe(
      false,
    );
    expect(typingOutsideTerminal(contextFor(sidebarButton, "key"))).toBe(false);
  });
});

describe("rankIn", () => {
  test("the innermost area wins, then any area, then global", () => {
    const areas: CommandArea[] = ["editor", "tabs", "center"];
    expect(rankIn({ areas: ["editor"] }, areas)).toBe(0);
    expect(rankIn({ areas: ["center"] }, areas)).toBe(2);
    expect(rankIn(undefined, areas)).toBeGreaterThan(2);
    expect(rankIn({ areas: ["sidebar"] }, areas)).toBeUndefined();
    expect(rankIn({ areas: ["tabs"], not: ["editor"] }, areas)).toBeUndefined();
  });
});

describe("matchChords", () => {
  const bindings = compileBindings([
    spec("global.k", ["mod+k"]),
    spec("center.k", ["mod+k"], { when: { areas: ["center"] } }),
    spec("editor.k", ["mod+k"], { when: { areas: ["editor"] } }),
    spec("list.j", ["j"], { when: { areas: ["sidebar"] } }),
  ]);
  const chord = chordFromEvent(cmd("k", "KeyK"));

  test("runs the most specific binding for where focus is", () => {
    const run = (areas: CommandArea[]) => {
      const result = matchChords(bindings, [chord], context(areas), always);
      return result?.kind === "run" ? result.binding.id : result?.kind;
    };
    expect(run(["editor", "tabs", "center"])).toBe("editor.k");
    expect(run(["tabs", "center"])).toBe("center.k");
    expect(run(["sidebar"])).toBe("global.k");
    expect(run([])).toBe("global.k");
  });

  test("falls through to the next binding when one is disabled", () => {
    const result = matchChords(
      bindings,
      [chord],
      context(["editor", "tabs", "center"]),
      (command) => command !== id("editor.k"),
    );
    expect(result?.kind === "run" && result.binding.id).toBe("center.k");
  });

  test("runs nothing when nothing is enabled", () => {
    expect(
      matchChords(bindings, [chord], context(["sidebar"]), () => false),
    ).toBeUndefined();
  });

  test("a single key never fires while typing", () => {
    const j = chordFromEvent(press("j", "KeyJ"));
    expect(matchChords(bindings, [j], context(["sidebar"]), always)?.kind).toBe(
      "run",
    );
    expect(
      matchChords(bindings, [j], context(["sidebar"], true), always),
    ).toBeUndefined();
  });

  test("table order breaks a tie", () => {
    const tie = compileBindings([
      spec("first", ["mod+k"]),
      spec("second", ["mod+k"]),
    ]);
    const result = matchChords(tie, [chord], context([]), always);
    expect(result?.kind === "run" && result.binding.id).toBe("first");
  });

  test("keys a native menu item owns are left to the menu", () => {
    const menu = compileBindings([
      spec("menu.k", ["mod+k", "mod+shift+k"], {
        menu: { bar: "View", section: 0 },
      }),
      spec("host.j", ["mod+j"], { runsIn: "host" }),
    ]);
    // Only the menu item's accelerator is native; a second key, and a host
    // command with no menu item, are the dispatcher's.
    expect(menu.map((binding) => binding.native)).toEqual([true, false, false]);
    expect(matchChords(menu, [chord], context([]), always)).toBeUndefined();
    const j = chordFromEvent(cmd("j", "KeyJ"));
    expect(matchChords(menu, [j], context([]), always)?.kind).toBe("run");
  });

  test("a rebound menu command's new key is the menu's, the old one is free", () => {
    const menu = [
      spec("menu.k", ["mod+k"], { menu: { bar: "View", section: 0 } }),
    ];
    const rebound = compileBindings(menu, {
      [id("menu.k")]: ["mod+shift+p", "g k"],
    });
    expect(rebound.map(({ key, native }) => [key, native])).toEqual([
      ["shift+mod+p", true],
      ["g k", false],
    ]);
    expect(matchChords(rebound, [chord], context([]), always)).toBeUndefined();
  });

  test("while a dialog is open only inModal commands act", () => {
    const modal = compileBindings([
      spec("global.k", ["mod+k"]),
      spec("quit.k", ["mod+k"], { inModal: true }),
    ]);
    const run = (open: boolean) => {
      const result = matchChords(
        modal,
        [chord],
        context([], false, "key", open),
        always,
      );
      return result?.kind === "run" ? result.binding.id : undefined;
    };
    expect(run(false)).toBe("global.k");
    expect(run(true)).toBe("quit.k");
    expect(
      matchChords(
        compileBindings([spec("global.k", ["mod+k"])]),
        [chord],
        context([], false, "key", true),
        always,
      ),
    ).toBeUndefined();
  });

  test("the best rank decides between a key and a longer sequence", () => {
    const mixed = compileBindings([
      spec("center.k", ["mod+k"], { when: { areas: ["center"] } }),
      spec("editor.ks", ["mod+k mod+s"], { when: { areas: ["editor"] } }),
    ]);
    expect(
      matchChords(mixed, [chord], context(["editor", "center"]), always)?.kind,
    ).toBe("pending");
    expect(matchChords(mixed, [chord], context(["center"]), always)?.kind).toBe(
      "run",
    );
  });

  test("an override replaces the default keys", () => {
    const overridden = compileBindings([spec("global.k", ["mod+k"])], {
      [id("global.k")]: ["mod+shift+p"],
    });
    expect(overridden.map((binding) => binding.key)).toEqual(["shift+mod+p"]);
  });
});

describe("KeyMatcher", () => {
  const bindings = compileBindings([
    spec("chord", ["mod+k mod+s"]),
    spec("plain", ["mod+s"]),
  ]);

  test("waits for the rest of a sequence, then runs it", () => {
    const matcher = new KeyMatcher(() => bindings, always);
    expect(matcher.handle(cmd("k", "KeyK"), context([]))?.kind).toBe("pending");
    const result = matcher.handle(cmd("s", "KeyS"), context([]));
    expect(result?.kind === "run" && result.binding.id).toBe("chord");
  });

  test("a modifier alone does not break a sequence", () => {
    const matcher = new KeyMatcher(() => bindings, always);
    matcher.handle(cmd("k", "KeyK"), context([]));
    expect(
      matcher.handle(press("Meta", "MetaLeft", { metaKey: true }), context([])),
    ).toBeUndefined();
    const result = matcher.handle(cmd("s", "KeyS"), context([]));
    expect(result?.kind === "run" && result.binding.id).toBe("chord");
  });

  test("a sequence that goes nowhere starts over with the last key", () => {
    const matcher = new KeyMatcher(() => bindings, always);
    matcher.handle(cmd("k", "KeyK"), context([]));
    expect(matcher.handle(cmd("x", "KeyX"), context([]))).toBeUndefined();
    const result = matcher.handle(cmd("s", "KeyS"), context([]));
    expect(result?.kind === "run" && result.binding.id).toBe("plain");
  });

  test("focus moving forgets a sequence in progress", () => {
    const matcher = new KeyMatcher(() => bindings, always);
    matcher.handle(cmd("k", "KeyK"), context([]));
    matcher.reset();
    const result = matcher.handle(cmd("s", "KeyS"), context([]));
    expect(result?.kind === "run" && result.binding.id).toBe("plain");
  });

  test("a held key does not repeat a command unless it allows it", () => {
    const held = { ...cmd("s", "KeyS"), repeat: true };
    const matcher = new KeyMatcher(() => bindings, always);
    expect(matcher.handle(held, context([]))?.kind).toBe("repeat");
    const repeating = new KeyMatcher(
      () => compileBindings([spec("plain", ["mod+s"], { allowRepeat: true })]),
      always,
    );
    expect(repeating.handle(held, context([]))?.kind).toBe("run");
  });

  test("a key matches by the layout's character first", () => {
    // German: / is ⇧7.
    const slash = compileBindings([spec("help", ["mod+/"])]);
    const matcher = new KeyMatcher(() => slash, always);
    const result = matcher.handle(
      press("/", "Digit7", { metaKey: true, shiftKey: true }),
      context([]),
    );
    expect(result?.kind === "run" && result.binding.id).toBe("help");
  });

  test("a sequence times out", () => {
    let now = 0;
    const matcher = new KeyMatcher(
      () => bindings,
      always,
      1_000,
      () => now,
    );
    matcher.handle(cmd("k", "KeyK"), context([]));
    now = 5_000;
    const result = matcher.handle(cmd("s", "KeyS"), context([]));
    expect(result?.kind === "run" && result.binding.id).toBe("plain");
  });
});

describe("findConflicts", () => {
  test("flags one key claimed twice in the same place", () => {
    const conflicts = findConflicts(
      compileBindings([
        spec("a", ["mod+k"], { when: { areas: ["sidebar", "center"] } }),
        spec("b", ["cmd+K"], { when: { areas: ["center"] } }),
        spec("c", ["mod+k"]),
        spec("d", ["mod+k"]),
        spec("e", ["mod+k"], { when: { areas: ["editor"] } }),
      ]),
    );
    expect(conflicts.map(([a, b]) => `${a.id}/${b.id}`)).toEqual([
      "a/b",
      "c/d",
    ]);
  });

  test("the app's own table has none", () => {
    expect(findConflicts(realBindings)).toEqual([]);
  });
});

// --- the real table --------------------------------------------------------

describe("the command table", () => {
  test("a menu item with a key acts everywhere, as the menu does", () => {
    // macOS delivers a menu accelerator wherever focus is, so a command that
    // owns one must not be limited to an area: it would fire from the menu
    // where its keys say it should not, or reach a terminal and fire too.
    // A `showKeyOnly` item owns no accelerator, so it may be limited.
    const specs: readonly CommandSpec[] = COMMAND_SPECS;
    for (const entry of specs.filter(
      (item) => item.menu && !item.menu.showKeyOnly && item.keys.length > 0,
    ))
      expect({ id: entry.id, when: entry.when }).toEqual({
        id: entry.id,
        when: undefined,
      });
  });

  test("every key in it parses, and ids are unique", () => {
    const ids = COMMAND_SPECS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(realBindings.length).toBeGreaterThan(0);
  });

  const run = (event: ReturnType<typeof press>, target: ElementLike) => {
    // As the dispatcher does: a fresh matcher, every chord the event may mean.
    const result = new KeyMatcher(() => realBindings, always).handle(
      event,
      contextFor(target, "key"),
    );
    return result?.kind === "run" ? result.binding.id : undefined;
  };

  test("the center tab keys act in the tabs, on a preview as in Monaco", () => {
    expect(run(cmd("s", "KeyS"), monacoInput)).toBe("tab.save");
    expect(run(cmd("s", "KeyS"), preview)).toBe("tab.save");
    expect(run(cmd("w", "KeyW"), preview)).toBe("tab.close");
    expect(
      run(
        press("}", "BracketRight", { metaKey: true, shiftKey: true }),
        monacoInput,
      ),
    ).toBe("tab.next");
    expect(
      run(
        press("{", "BracketLeft", { metaKey: true, shiftKey: true }),
        preview,
      ),
    ).toBe("tab.previous");
  });

  test("and not outside them", () => {
    expect(run(cmd("s", "KeyS"), sidebarButton)).toBeUndefined();
    expect(run(cmd("w", "KeyW"), integratedInput)).toBeUndefined();
  });

  test("⌘S is not taken from a session terminal; ⌘W is", () => {
    expect(run(cmd("s", "KeyS"), xtermInput)).toBeUndefined();
    expect(run(cmd("w", "KeyW"), xtermInput)).toBe("tab.close");
  });

  /** The command whose native menu item owns the key, if one does. */
  const menuOwner = (event: ReturnType<typeof press>, target: ElementLike) =>
    applicableBindings(
      realBindings,
      [chordFromEvent(event)],
      contextFor(target, "key"),
      { includeNative: true },
    ).find((binding) => binding.native)?.id;

  test("⌘B toggles the side panel from anywhere, typing included", () => {
    // Its View menu item owns the key, which macOS delivers wherever focus is.
    const cmdB = cmd("b", "KeyB");
    expect(run(cmdB, sidebarInput)).toBeUndefined();
    expect(menuOwner(cmdB, sidebarInput)).toBe("panel.toggleWorkspacePanel");
    expect(menuOwner(cmdB, xtermInput)).toBe("panel.toggleWorkspacePanel");
    expect(menuOwner(cmdB, monacoInput)).toBe("panel.toggleWorkspacePanel");
    // ⌥⌘B is free again.
    expect(
      menuOwner(press("∫", "KeyB", { metaKey: true, altKey: true }), preview),
    ).toBeUndefined();
  });

  test("the removed focus and history keys are free", () => {
    for (const event of [
      press("F6", "F6"),
      press("F6", "F6", { shiftKey: true }),
      cmd("0", "Digit0"),
      cmd("[", "BracketLeft"),
      cmd("]", "BracketRight"),
      cmd("/", "Slash"),
      press("E", "KeyE", { metaKey: true, shiftKey: true }),
      press("R", "KeyR", { metaKey: true, shiftKey: true }),
      press("A", "KeyA", { metaKey: true, shiftKey: true }),
      press("ArrowDown", "ArrowDown", { metaKey: true, altKey: true }),
      press("ArrowUp", "ArrowUp", { metaKey: true, altKey: true }),
    ]) {
      expect(run(event, sidebarButton)).toBeUndefined();
      expect(menuOwner(event, sidebarButton)).toBeUndefined();
    }
  });

  test("the new-item keys act everywhere, typing included", () => {
    expect(menuOwner(cmd("n", "KeyN"), monacoInput)).toBe("session.new");
    expect(
      menuOwner(press("N", "KeyN", { metaKey: true, shiftKey: true }), preview),
    ).toBe("task.new");
    expect(menuOwner(cmd(",", "Comma"), xtermInput)).toBe("app.settings");
  });

  test("a key a menu item only shows stays the dispatcher's, with its when", () => {
    const specs: readonly CommandSpec[] = COMMAND_SPECS;
    const shown = specs.filter((entry) => entry.menu?.showKeyOnly);
    expect(shown.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "tab.save",
        "tab.close",
        "tab.next",
        "session.switch",
        "palette.open",
      ]),
    );
    for (const entry of shown)
      expect(
        realBindings.filter(
          (binding) => binding.id === entry.id && binding.native,
        ),
      ).toEqual([]);
    // So ⌘W still reaches a field outside the tabs.
    expect(menuOwner(cmd("w", "KeyW"), sidebarInput)).toBeUndefined();
    expect(run(cmd("w", "KeyW"), sidebarInput)).toBeUndefined();
  });

  test("⌘K opens the palette from anywhere, a terminal and Monaco included", () => {
    expect(run(cmd("k", "KeyK"), xtermInput)).toBe("palette.open");
    expect(run(cmd("k", "KeyK"), monacoInput)).toBe("palette.open");
    expect(run(cmd("k", "KeyK"), sidebarButton)).toBe("palette.open");
    expect(
      terminalKeepsKey(
        cmd("k", "KeyK"),
        contextFor(xtermInput, "key"),
        realBindings,
        always,
      ),
    ).toBe(true);
  });

  test("⌃Tab and ⌃⇧Tab switch sessions from a terminal and Monaco, and repeat", () => {
    const ctrlTab = press("Tab", "Tab", { ctrlKey: true });
    const ctrlShiftTab = press("Tab", "Tab", { ctrlKey: true, shiftKey: true });
    for (const target of [xtermInput, monacoInput, sidebarButton, preview]) {
      expect(run(ctrlTab, target)).toBe("session.switch");
      expect(run(ctrlShiftTab, target)).toBe("session.switchBack");
    }
    for (const event of [ctrlTab, ctrlShiftTab])
      expect(
        terminalKeepsKey(
          event,
          contextFor(xtermInput, "key"),
          realBindings,
          always,
        ),
      ).toBe(true);
    // A held Tab keeps moving down the list.
    expect(
      new KeyMatcher(() => realBindings, always).handle(
        { ...ctrlTab, repeat: true },
        contextFor(xtermInput, "key"),
      )?.kind,
    ).toBe("run");
    // Plain Tab and ⌃ letters still reach the shell.
    expect(run(press("Tab", "Tab"), xtermInput)).toBeUndefined();
    expect(
      run(press("r", "KeyR", { ctrlKey: true }), xtermInput),
    ).toBeUndefined();
  });

  test("⌘1 to ⌘9 go to a center tab from anywhere, a terminal included", () => {
    for (let digit = 1; digit <= 9; digit += 1) {
      const key = cmd(String(digit), `Digit${digit}`);
      const expected = digit === 9 ? "tab.goToLast" : `tab.goTo${digit}`;
      expect(run(key, xtermInput)).toBe(expected);
      expect(run(key, monacoInput)).toBe(expected);
      expect(run(key, sidebarButton)).toBe(expected);
      expect(menuOwner(key, sidebarButton)).toBeUndefined();
    }
  });

  test("a key's keysNot leaves an area to its owner, the menu and palette still run it", () => {
    expect(rankIn({ keysNot: ["editor"] }, ["editor", "tabs"])).toBeUndefined();
    expect(
      rankIn({ keysNot: ["editor"] }, ["editor", "tabs"], { forKey: false }),
    ).toBeDefined();
  });

  test("⇧F10 opens an item's actions in the sidebar, the board and the panel", () => {
    const shiftF10 = press("F10", "F10", { shiftKey: true });
    const board = el("DIV", { "data-area": "board" });
    const card = el("ARTICLE", {}, ["board-card"], board);
    const panel = el("ASIDE", { "data-area": "right-panel" });
    const row = el("DIV", {}, ["file-tree-row"], panel);
    expect(run(shiftF10, sidebarButton)).toBe("item.menu");
    expect(run(shiftF10, card)).toBe("item.menu");
    expect(run(shiftF10, row)).toBe("item.menu");
    expect(run(shiftF10, xtermInput)).toBeUndefined();
  });

  test("the menu's keys are left to the menu", () => {
    expect(run(cmd("b", "KeyB"), sidebarButton)).toBeUndefined();
    expect(
      run(press("`", "Backquote", { ctrlKey: true }), sidebarButton),
    ).toBeUndefined();
  });
});

describe("swallowsNativeRepeat", () => {
  const held = (event: ReturnType<typeof press>) => ({
    ...event,
    repeat: true,
  });

  test("a held menu key is swallowed, so the menu does not run it again", () => {
    expect(
      swallowsNativeRepeat(
        held(cmd("t", "KeyT")),
        contextFor(sidebarButton, "key"),
        realBindings,
      ),
    ).toBe(true);
    expect(
      swallowsNativeRepeat(
        held(cmd("b", "KeyB")),
        contextFor(xtermInput, "key"),
        realBindings,
      ),
    ).toBe(true);
  });

  test("the first press, a dispatcher key and a repeating command pass", () => {
    const where = contextFor(sidebarButton, "key");
    expect(swallowsNativeRepeat(cmd("t", "KeyT"), where, realBindings)).toBe(
      false,
    );
    expect(
      swallowsNativeRepeat(held(cmd("k", "KeyK")), where, realBindings),
    ).toBe(false);
    const repeating = compileBindings([
      spec("x.zoom", ["mod+="], {
        allowRepeat: true,
        menu: { bar: "View", section: 0 },
      }),
    ]);
    expect(
      swallowsNativeRepeat(held(cmd("=", "Equal")), where, repeating),
    ).toBe(false);
  });
});

describe("isComposingKey", () => {
  test("a key of an input method's composition is never a command's", () => {
    expect(isComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe("terminalKeepsKey", () => {
  const keeps = (
    event: ReturnType<typeof press>,
    target: ElementLike = xtermInput,
    isEnabled: (command: CommandId) => boolean = always,
  ) =>
    terminalKeepsKey(event, contextFor(target, "key"), realBindings, isEnabled);

  test("the app keeps the keys of its commands, ⌃` among them", () => {
    expect(keeps(press("`", "Backquote", { ctrlKey: true }))).toBe(true);
    expect(keeps(cmd("w", "KeyW"))).toBe(true);
    expect(keeps(cmd("1", "Digit1"))).toBe(true);
    expect(
      keeps(press("}", "BracketRight", { metaKey: true, shiftKey: true })),
    ).toBe(true);
    expect(keeps(cmd("b", "KeyB"))).toBe(true);
    expect(keeps(press("Tab", "Tab", { ctrlKey: true }))).toBe(true);
  });

  test("the shell gets everything else", () => {
    expect(keeps(press("c", "KeyC", { ctrlKey: true }))).toBe(false);
    expect(keeps(press("r", "KeyR", { ctrlKey: true }))).toBe(false);
    expect(keeps(press("ƒ", "KeyF", { altKey: true }))).toBe(false);
    expect(keeps(press("a", "KeyA"))).toBe(false);
    expect(keeps(press("Escape", "Escape"))).toBe(false);
    expect(keeps(press("Enter", "Enter"))).toBe(false);
    // The other function keys stay the program's (htop, mc).
    expect(keeps(press("F5", "F5"))).toBe(false);
    expect(keeps(press("F10", "F10"))).toBe(false);
    // ⌃§ on an international keyboard is not ⌃`.
    expect(keeps(press("§", "IntlBackslash", { ctrlKey: true }))).toBe(false);
    // ⌘S is no command in a terminal.
    expect(keeps(cmd("s", "KeyS"))).toBe(false);
  });

  test("the new-item keys are kept, being ⌘ keys; the removed ones are the shell's", () => {
    expect(keeps(cmd("n", "KeyN"))).toBe(true);
    expect(keeps(cmd("t", "KeyT"))).toBe(true);
    expect(keeps(press("F6", "F6"))).toBe(false);
    expect(keeps(press("[", "BracketLeft", { metaKey: true }))).toBe(false);
    expect(
      keeps(press("ArrowDown", "ArrowDown", { metaKey: true, altKey: true })),
    ).toBe(false);
  });

  test("a command that is disabled leaves its key to the shell", () => {
    expect(
      keeps(cmd("w", "KeyW"), xtermInput, (command) => command !== "tab.close"),
    ).toBe(false);
  });

  test("an integrated terminal keeps the global keys but not the tab keys", () => {
    expect(keeps(cmd("w", "KeyW"), integratedInput)).toBe(false);
    expect(keeps(cmd("2", "Digit2"), integratedInput)).toBe(true);
    expect(
      keeps(press("`", "Backquote", { ctrlKey: true }), integratedInput),
    ).toBe(true);
  });
});

describe("registry", () => {
  test("runCommand honours where a command acts, for the menu too", async () => {
    const { registerCommand, runCommand, isCommandEnabled } =
      await import("./registry");
    let ran = 0;
    const dispose = registerCommand("tab.close", { run: () => (ran += 1) });
    const where = (areas: CommandArea[], modal = false) =>
      context(areas, false, "menu", modal);
    expect(runCommand("tab.close", where(["sidebar"]))).toBe(false);
    expect(isCommandEnabled("tab.close", where(["sidebar"]))).toBe(false);
    expect(runCommand("tab.close", where(["tabs", "center"]))).toBe(true);
    expect(runCommand("tab.close", where(["tabs", "center"], true))).toBe(
      false,
    );
    expect(ran).toBe(1);
    dispose();
    expect(runCommand("tab.close", where(["tabs", "center"]))).toBe(false);
  });

  test("host commands run through the host; the person's keys apply here", async () => {
    const { connectHost, runCommand, setKeyOverrides, commandKeys } =
      await import("./registry");
    const ran: string[] = [];
    expect(runCommand("app.quit", context([], false, "palette"))).toBe(false);
    const disconnect = connectHost({
      run: (command) => ran.push(command),
    });
    expect(runCommand("app.quit", context([], false, "palette"))).toBe(true);
    // Quit acts while a dialog is open.
    expect(runCommand("app.quit", context([], false, "palette", true))).toBe(
      true,
    );
    expect(ran).toEqual(["app.quit", "app.quit"]);

    // A bad key is dropped and reported; the rest take effect at once.
    const rejected = setKeyOverrides({
      "tab.close": ["mod+banana", "mod+shift+w"],
      "no.such": ["mod+x"],
    });
    expect(rejected.map((item) => [item.id, item.key])).toEqual([
      ["tab.close", "mod+banana"],
      ["no.such", undefined],
    ]);
    expect(commandKeys("tab.close")).toEqual(["mod+shift+w"]);
    setKeyOverrides({});
    expect(commandKeys("tab.close")).toEqual(["mod+w"]);
    disconnect();
  });

  test("a menu command rebound to a key that types is the dispatcher's, with its typing guard", async () => {
    const overrides = { "session.new": ["j"] } as const;
    const bindings = compileBindings(COMMAND_SPECS, overrides);
    const binding = bindings.find((entry) => entry.id === "session.new");
    expect(binding?.native).toBe(false);
    const press = {
      key: "j",
      code: "KeyJ",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const enabled = () => true;
    // Typed into a field, it stays text.
    expect(
      matchChords(
        bindings,
        [chordFromEvent(press)],
        context([], true),
        enabled,
      ),
    ).toBeUndefined();
    expect(
      matchChords(
        bindings,
        [chordFromEvent(press)],
        context([], false),
        enabled,
      ),
    ).toMatchObject({ kind: "run", binding: { id: "session.new" } });
  });
});

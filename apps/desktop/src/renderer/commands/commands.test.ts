import { describe, expect, test } from "vitest";
import {
  COMMAND_SPECS,
  type CommandArea,
  type CommandId,
  type CommandSpec,
} from "@daedalus/protocol";
import { type CommandContext, type ElementLike, contextFor } from "./context";
import {
  KeyMatcher,
  compileBindings,
  findConflicts,
  matchChords,
  rankIn,
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
): CommandContext => ({ areas, typing, target: null, source });

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
      spec("menu.k", ["mod+k"], { menu: { bar: "View", section: 0 } }),
      spec("host.j", ["mod+j"], { runsIn: "host" }),
    ]);
    expect(menu.every((binding) => binding.native)).toBe(true);
    expect(matchChords(menu, [chord], context([]), always)).toBeUndefined();
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
  test("every key in it parses, and ids are unique", () => {
    const ids = COMMAND_SPECS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(realBindings.length).toBeGreaterThan(0);
  });

  const run = (event: ReturnType<typeof press>, target: ElementLike) => {
    const result = matchChords(
      realBindings,
      [chordFromEvent(event)],
      contextFor(target, "key"),
      always,
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

  test("⌥⌘B folds the panel from anywhere, typing included", () => {
    const optCmdB = press("∫", "KeyB", { metaKey: true, altKey: true });
    expect(run(optCmdB, sidebarInput)).toBe("panel.toggleWorkspacePanel");
    expect(run(optCmdB, xtermInput)).toBe("panel.toggleWorkspacePanel");
  });

  test("the menu's keys are left to the menu", () => {
    expect(run(cmd("1", "Digit1"), sidebarButton)).toBeUndefined();
    expect(
      run(press("`", "Backquote", { ctrlKey: true }), sidebarButton),
    ).toBeUndefined();
  });
});

describe("terminalKeepsKey", () => {
  const keeps = (
    event: ReturnType<typeof press>,
    target: ElementLike = xtermInput,
    isEnabled: (command: CommandId) => boolean = always,
  ) =>
    terminalKeepsKey(event, contextFor(target, "key"), realBindings, isEnabled);

  test("the app keeps F6, ⌃` and the keys of its commands", () => {
    expect(keeps(press("F6", "F6"))).toBe(true);
    expect(keeps(press("F6", "F6", { shiftKey: true }))).toBe(true);
    expect(keeps(press("`", "Backquote", { ctrlKey: true }))).toBe(true);
    expect(keeps(cmd("w", "KeyW"))).toBe(true);
    expect(keeps(cmd("1", "Digit1"))).toBe(true);
    expect(
      keeps(press("}", "BracketRight", { metaKey: true, shiftKey: true })),
    ).toBe(true);
    expect(keeps(press("∫", "KeyB", { metaKey: true, altKey: true }))).toBe(
      true,
    );
  });

  test("the shell gets everything else", () => {
    expect(keeps(press("c", "KeyC", { ctrlKey: true }))).toBe(false);
    expect(keeps(press("r", "KeyR", { ctrlKey: true }))).toBe(false);
    expect(keeps(press("ƒ", "KeyF", { altKey: true }))).toBe(false);
    expect(keeps(press("a", "KeyA"))).toBe(false);
    expect(keeps(press("Escape", "Escape"))).toBe(false);
    expect(keeps(press("Enter", "Enter"))).toBe(false);
    // ⌘S is no command in a terminal.
    expect(keeps(cmd("s", "KeyS"))).toBe(false);
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

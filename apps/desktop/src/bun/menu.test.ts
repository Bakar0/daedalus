import { describe, expect, test } from "vitest";
import {
  COMMAND_SPECS,
  type CommandSpec,
  isHostCommandId,
  isRendererCommandId,
  menuItemLabel,
  menuKeyLabel,
} from "@daedalus/protocol";
import { APPLICATION_MENU, buildApplicationMenu } from "./menu";

type Item = (typeof APPLICATION_MENU)[number];
const actionsIn = (items: readonly Item[]): Item[] =>
  items.flatMap((item) => [
    item,
    ...("submenu" in item && item.submenu ? actionsIn(item.submenu) : []),
  ]);

describe("desktop application menu", () => {
  test("provides native macOS editing commands", () => {
    const editMenu = APPLICATION_MENU.find(
      (item) => "label" in item && item.label === "Edit",
    );
    const roles =
      editMenu && "submenu" in editMenu
        ? editMenu.submenu?.flatMap((item) =>
            "role" in item && item.role ? [item.role] : [],
          )
        : [];

    expect(roles).toEqual(
      expect.arrayContaining([
        "undo",
        "redo",
        "cut",
        "copy",
        "paste",
        "selectAll",
      ]),
    );
  });

  test("routes quit through our own code rather than the native role", () => {
    const appMenu = APPLICATION_MENU.find(
      (item) => "label" in item && item.label === "Daedalus",
    );
    const submenu =
      (appMenu && "submenu" in appMenu ? appMenu.submenu : []) ?? [];
    // `{ role: "quit" }` is an NSApplication selector: Cmd+Q would terminate
    // the app without ever reaching us, and the user would never be told what
    // keeps running.
    expect(submenu.some((item) => "role" in item && item.role === "quit")).toBe(
      false,
    );
    expect(
      Object.fromEntries(
        submenu.flatMap((item) =>
          "action" in item && item.action
            ? [[item.action, item.accelerator] as const]
            : [],
        ),
      ),
    ).toEqual({
      "app.checkForUpdates": undefined,
      "app.settings": "Command+,",
      "app.quit": "Command+Q",
      "app.quitAndShutDown": "Command+Shift+Q",
    });
  });

  test("provides native navigation and terminal shortcuts", () => {
    const viewMenu = APPLICATION_MENU.find(
      (item) => "label" in item && item.label === "View",
    );
    const shortcuts =
      viewMenu && "submenu" in viewMenu
        ? viewMenu.submenu?.flatMap((item) =>
            "action" in item && item.action
              ? [[item.action, item.accelerator] as const]
              : [],
          )
        : [];

    expect(Object.fromEntries(shortcuts ?? [])).toEqual({
      "view.workspace": "Command+1",
      "view.board": "Command+2",
      "view.session": "Command+3",
      "view.world": "Command+4",
      "view.worldWindow": "Command+Option+4",
      "terminal.toggle": "Control+`",
      "panel.toggleWorkspacePanel": "Command+Option+B",
    });
  });

  test("keeps the View menu's order and divides its sections", () => {
    const viewMenu = APPLICATION_MENU.find(
      (item) => "label" in item && item.label === "View",
    );
    const submenu =
      (viewMenu && "submenu" in viewMenu ? viewMenu.submenu : []) ?? [];
    expect(
      submenu.map((item) =>
        "action" in item && item.action
          ? item.action
          : "type" in item
            ? item.type
            : "?",
      ),
    ).toEqual([
      "view.workspace",
      "view.board",
      "view.session",
      "view.world",
      "view.worldWindow",
      "divider",
      "terminal.toggle",
      "panel.toggleWorkspacePanel",
    ]);
  });

  test("every menu action is a command from the table, titled as the table says", () => {
    const specs: readonly CommandSpec[] = COMMAND_SPECS;
    const items = actionsIn(APPLICATION_MENU).flatMap((item) =>
      "action" in item && item.action ? [item] : [],
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const action = "action" in item ? item.action : undefined;
      expect(isHostCommandId(action) || isRendererCommandId(action)).toBe(true);
      const spec = specs.find((entry) => entry.id === action);
      expect("label" in item ? item.label : undefined).toBe(
        spec && menuItemLabel(spec.title, menuKeyLabel(spec)),
      );
    }
    // And every command the table places in a menu is there.
    expect(
      new Set(items.map((item) => ("action" in item ? item.action : ""))),
    ).toEqual(
      new Set(specs.filter((spec) => spec.menu).map((spec) => spec.id)),
    );
  });

  test("is rebuilt with the person's keys, so a rebound command has one", () => {
    const view = buildApplicationMenu({
      "view.board": ["mod+shift+b"],
      "terminal.toggle": [],
    }).find((item) => "label" in item && item.label === "View");
    const submenu = (view && "submenu" in view ? view.submenu : []) ?? [];
    const accelerators = Object.fromEntries(
      submenu.flatMap((item) =>
        "action" in item && item.action
          ? [[item.action, item.accelerator] as const]
          : [],
      ),
    );
    expect(accelerators["view.board"]).toBe("Command+Shift+B");
    expect(accelerators["terminal.toggle"]).toBeUndefined();
    expect(accelerators["view.session"]).toBe("Command+3");
  });
});

const menuNamed = (label: string) => {
  const menu = APPLICATION_MENU.find(
    (item) => "label" in item && item.label === label,
  );
  return (menu && "submenu" in menu ? menu.submenu : []) ?? [];
};
const rows = (items: readonly Item[]) =>
  items.map((item) =>
    "action" in item && item.action
      ? [item.action, item.label, item.accelerator ?? null]
      : "type" in item
        ? item.type
        : "?",
  );

describe("File, Go and Help menus", () => {
  test("stand in the order every Mac app keeps", () => {
    expect(
      APPLICATION_MENU.map((item) => ("label" in item ? item.label : "")),
    ).toEqual(["Daedalus", "File", "Edit", "View", "Go", "Window", "Help"]);
  });

  test("File holds the new-item commands, and the tab keys it only shows", () => {
    expect(rows(menuNamed("File"))).toEqual([
      ["session.new", "New Session…", "Command+N"],
      ["task.new", "New Task…", "Command+Shift+N"],
      ["terminal.new", "New Terminal", "Command+T"],
      "divider",
      // ⌘S and ⌘W act on the tabs only, so the menu must not own them: they
      // show in the title and the dispatcher keeps them.
      ["tab.save", "Save (⌘S)", null],
      ["tab.close", "Close Tab (⌘W)", null],
    ]);
  });

  test("Go owns the keys that act everywhere and only shows the others", () => {
    expect(rows(menuNamed("Go"))).toEqual([
      ["area.sidebar", "Focus Workspaces", "Command+0"],
      ["panel.files", "Show Files", "Command+Shift+E"],
      ["panel.repositories", "Show Repositories", "Command+Shift+R"],
      "divider",
      ["area.next", "Focus Next Area (F6)", null],
      ["area.previous", "Focus Previous Area (⇧F6)", null],
      "divider",
      ["session.next", "Next Session (⌥⌘↓)", null],
      ["session.previous", "Previous Session (⌥⌘↑)", null],
      [
        "session.nextNeedsYou",
        "Next Session That Needs You",
        "Command+Shift+A",
      ],
      "divider",
      ["history.back", "Back (⌘[)", null],
      ["history.forward", "Forward (⌘])", null],
      "divider",
      ["tab.next", "Next Tab (⇧⌘])", null],
      ["tab.previous", "Previous Tab (⇧⌘[)", null],
      "divider",
      ["palette.open", "Command Palette… (⌘K)", null],
    ]);
  });

  test("Help opens the shortcuts sheet, and Settings is in the app menu", () => {
    expect(rows(menuNamed("Help"))).toEqual([
      ["help.shortcuts", "Keyboard Shortcuts (⌘/)", null],
    ]);
    expect(rows(menuNamed("Daedalus")).slice(0, 4)).toEqual([
      "?",
      ["app.checkForUpdates", "Check for Updates…", null],
      "divider",
      ["app.settings", "Settings…", "Command+,"],
    ]);
  });

  test("a rebound key a menu only shows is shown rebound, an unbound one not at all", () => {
    const go = buildApplicationMenu({
      "history.back": ["mod+alt+left"],
      "palette.open": [],
    }).find((item) => "label" in item && item.label === "Go");
    const items = (go && "submenu" in go ? go.submenu : []) ?? [];
    const labels = Object.fromEntries(
      items.flatMap((item) =>
        "action" in item && item.action ? [[item.action, item.label]] : [],
      ),
    );
    expect(labels["history.back"]).toBe("Back (⌥⌘←)");
    expect(labels["palette.open"]).toBe("Command Palette…");
  });
});

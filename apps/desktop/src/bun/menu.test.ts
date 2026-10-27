import { describe, expect, test } from "vitest";
import {
  COMMAND_SPECS,
  type CommandSpec,
  isHostCommandId,
  isRendererCommandId,
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
      expect("label" in item ? item.label : undefined).toBe(spec?.title);
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

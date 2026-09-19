import { describe, expect, test } from "vitest";
import { QUIT_MENU_ACTION, SHUTDOWN_MENU_ACTION } from "@daedalus/protocol";
import { APPLICATION_MENU } from "./menu";

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
      [QUIT_MENU_ACTION]: "Command+Q",
      [SHUTDOWN_MENU_ACTION]: "Command+Shift+Q",
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
      "view-workspace": "Command+1",
      "view-board": "Command+2",
      "view-sessions": "Command+3",
      "toggle-terminal": "Control+`",
    });
  });
});

import { describe, expect, test } from "vitest";
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
      "view-board": "Command+1",
      "view-sessions": "Command+2",
      "view-workspace": "Command+3",
      "toggle-terminal": "Control+`",
    });
  });
});

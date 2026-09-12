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
});

import { describe, expect, test } from "vitest";
import { deleteKeyCloses, tabCloseRequest } from "./tab-keys";

/** A dockview tab element holding one of our tab components. */
const tab = (panelId: string | null, className = "dv-tab") => ({
  classList: {
    contains: (name: string) => className.split(" ").includes(name),
  },
  querySelector: (selector: string) =>
    selector === "[data-panel-id]" && panelId !== null
      ? {
          getAttribute: (name: string) =>
            name === "data-panel-id" ? panelId : null,
        }
      : null,
});

describe("tabCloseRequest", () => {
  test("Delete and Backspace on a tab name its panel, for the app's close", () => {
    expect(tabCloseRequest({ key: "Delete", target: tab("file:/a.ts") })).toBe(
      "file:/a.ts",
    );
    expect(
      tabCloseRequest({ key: "Backspace", target: tab("terminal:t1") }),
    ).toBe("terminal:t1");
  });

  test("other keys are left to dockview", () => {
    for (const key of ["Enter", " ", "ArrowRight", "Home", "x"])
      expect(
        tabCloseRequest({ key, target: tab("file:/a.ts") }),
      ).toBeUndefined();
  });

  test("Backspace inside a tab, or outside the strip, is not a close", () => {
    expect(
      tabCloseRequest({
        key: "Backspace",
        target: tab("file:/a.ts", "file-tab-close"),
      }),
    ).toBeUndefined();
    expect(tabCloseRequest({ key: "Backspace", target: null })).toBeUndefined();
    expect(
      tabCloseRequest({ key: "Backspace", target: { value: "text" } }),
    ).toBeUndefined();
  });

  test("a tab that is not one of ours is left alone", () => {
    expect(
      tabCloseRequest({ key: "Delete", target: tab(null) }),
    ).toBeUndefined();
  });
});

describe("deleteKeyCloses", () => {
  test("a terminal tab is never closed by Delete, which would end its shell", () => {
    expect(deleteKeyCloses("terminal")).toBe(false);
  });

  test("files and other views close", () => {
    for (const kind of [
      undefined,
      "session",
      "task",
      "web",
      "team",
      "routines",
    ])
      expect(deleteKeyCloses(kind)).toBe(true);
  });
});

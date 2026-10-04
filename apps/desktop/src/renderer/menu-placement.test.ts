import { describe, expect, test } from "vitest";
import { placeMenu } from "./Menu";

const viewport = { width: 1200, height: 800 };
const menu = { width: 240, height: 300 };

describe("placing a menu beside its trigger (#54)", () => {
  test("opens on the trigger's left when there is room", () => {
    const trigger = { top: 100, left: 600, width: 28, height: 28 };
    expect(
      placeMenu({ align: "end", menu, placement: "left", trigger, viewport }),
    ).toEqual({ top: 100, left: 600 - 5 - 240 });
  });

  test("a card near the window's left edge opens the menu on its right", () => {
    const trigger = { top: 100, left: 150, width: 28, height: 28 };
    expect(
      placeMenu({ align: "end", menu, placement: "left", trigger, viewport }),
    ).toEqual({ top: 100, left: 150 + 28 + 5 });
  });

  test("with no room on either side, it stays inside the window", () => {
    const narrow = { width: 300, height: 800 };
    const trigger = { top: 100, left: 150, width: 28, height: 28 };
    expect(
      placeMenu({
        align: "end",
        menu,
        placement: "left",
        trigger,
        viewport: narrow,
      }).left,
    ).toBe(8);
  });

  test("the last card in a tall list moves the menu up to fit", () => {
    const trigger = { top: 700, left: 600, width: 28, height: 28 };
    expect(
      placeMenu({ align: "end", menu, placement: "left", trigger, viewport })
        .top,
    ).toBe(800 - 8 - 300);
  });
});

describe("placing a menu below its trigger", () => {
  const trigger = { top: 100, left: 400, width: 80, height: 24 };

  test("lines up with the trigger's start or end edge", () => {
    expect(
      placeMenu({
        align: "start",
        menu,
        placement: "below",
        trigger,
        viewport,
      }),
    ).toEqual({ top: 129, left: 400 });
    expect(
      placeMenu({ align: "end", menu, placement: "below", trigger, viewport }),
    ).toEqual({ top: 129, left: 480 - 240 });
  });

  test("opens above a trigger near the window's bottom", () => {
    const low = { ...trigger, top: 700 };
    expect(
      placeMenu({
        align: "start",
        menu,
        placement: "below",
        trigger: low,
        viewport,
      }).top,
    ).toBe(700 - 5 - 300);
  });

  test("a trigger at the right edge keeps the menu inside the window", () => {
    const edge = { ...trigger, left: 1100 };
    expect(
      placeMenu({
        align: "start",
        menu,
        placement: "below",
        trigger: edge,
        viewport,
      }).left,
    ).toBe(1200 - 8 - 240);
  });
});

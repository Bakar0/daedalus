import { describe, expect, test } from "vitest";
import { sgrWheelReports, WheelLines, wheelToReports } from "./terminal-wheel";

const pixels = (deltaY: number) => ({
  deltaY,
  deltaMode: 0,
  altKey: false,
  ctrlKey: false,
});

describe("WheelLines", () => {
  test("a gesture moves one line per line height the finger travelled", () => {
    const wheel = new WheelLines();
    // A momentum flick: many events, several worth more than one line.
    const deltas = [-4, -22, -55, -80, -74, -60, -41, -25, -12, -5, -2, -1];
    const lines = deltas.map((deltaY) => wheel.take(pixels(deltaY), 15, 50));
    expect(lines.reduce((sum, value) => sum + value, 0)).toBe(
      Math.trunc(deltas.reduce((sum, value) => sum + value, 0) / 15),
    );
    expect(Math.min(...lines)).toBe(-5);
  });

  test("slow movement adds up instead of being lost", () => {
    const wheel = new WheelLines();
    const lines = Array.from({ length: 10 }, () =>
      wheel.take(pixels(3), 15, 50),
    );
    expect(lines.reduce((sum, value) => sum + value, 0)).toBe(2);
  });

  test("turning around starts the count over", () => {
    const wheel = new WheelLines();
    expect(wheel.take(pixels(14), 15, 50)).toBe(0);
    expect(wheel.take(pixels(-14), 15, 50)).toBe(0);
    expect(wheel.take(pixels(-2), 15, 50)).toBe(-1);
  });

  test("line and page deltas, capped at a screen", () => {
    const wheel = new WheelLines();
    expect(wheel.take({ ...pixels(3), deltaMode: 1 }, 15, 50)).toBe(3);
    expect(wheel.take({ ...pixels(-1), deltaMode: 2 }, 15, 50)).toBe(-50);
    expect(wheel.take(pixels(10_000), 15, 50)).toBe(50);
  });
});

test("one SGR wheel report per line, with modifiers in the button", () => {
  expect(sgrWheelReports(-2, 10, 4, { altKey: false, ctrlKey: false })).toBe(
    "\u001b[<64;10;4M\u001b[<64;10;4M",
  );
  expect(sgrWheelReports(1, 1, 1, { altKey: true, ctrlKey: true })).toBe(
    "\u001b[<89;1;1M",
  );
  expect(sgrWheelReports(0, 1, 1, { altKey: false, ctrlKey: false })).toBe("");
});

describe("wheelToReports", () => {
  // 100 columns of 8 px and 50 rows of 15 px, from (10, 20).
  const target = {
    sgrMouse: true,
    mouseTracking: true,
    cols: 100,
    rows: 50,
    bounds: { left: 10, top: 20, width: 800, height: 750 },
  };
  const wheel = (deltaY: number, extra = {}) => ({
    ...pixels(deltaY),
    shiftKey: false,
    clientX: 10 + 8 * 4 + 1,
    clientY: 20 + 15 * 2 + 1,
    ...extra,
  });

  test("reports the cell under the pointer, a report per line", () => {
    expect(wheelToReports(new WheelLines(), wheel(-30), target)).toEqual({
      reports: "\u001b[<64;5;3M".repeat(2),
      consumed: true,
    });
  });

  test("leaves xterm the wheel without SGR mouse, without tracking, or with Shift", () => {
    const lines = new WheelLines();
    lines.take(pixels(-10), 15, 50);
    for (const [event, over] of [
      [wheel(-30), { sgrMouse: false }],
      [wheel(-30), { mouseTracking: false }],
      [wheel(-30, { shiftKey: true }), {}],
    ] as const)
      expect(wheelToReports(lines, event, { ...target, ...over })).toBe(
        undefined,
      );
    // The partial line from before is gone, not added to the next gesture.
    expect(wheelToReports(lines, wheel(-10), target)).toEqual({
      reports: "",
      consumed: true,
    });
  });

  test("a horizontal-only event keeps the browser's default", () => {
    expect(wheelToReports(new WheelLines(), wheel(0), target)).toEqual({
      reports: "",
      consumed: false,
    });
  });

  test("a hidden terminal with no size sends nothing", () => {
    expect(
      wheelToReports(new WheelLines(), wheel(-30), {
        ...target,
        bounds: { left: 0, top: 0, width: 0, height: 0 },
      }),
    ).toEqual({ reports: "", consumed: true });
  });
});

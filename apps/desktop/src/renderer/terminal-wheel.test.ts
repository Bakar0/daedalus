import { describe, expect, test } from "vitest";
import { sgrWheelReports, WheelLines } from "./terminal-wheel";

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

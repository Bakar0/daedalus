import { describe, expect, test } from "bun:test";
import { copiedSelection, leftButtonReport } from "./terminal-selection";

describe("leftButtonReport", () => {
  test("reads a left press and release", () => {
    expect(leftButtonReport("\u001b[<0;12;3M")).toEqual({
      kind: "press",
      cell: { col: 12, row: 3 },
    });
    expect(leftButtonReport("\u001b[<0;20;4m")).toEqual({
      kind: "release",
      cell: { col: 20, row: 4 },
    });
  });

  test("skips drags, wheels, other buttons and text", () => {
    expect(leftButtonReport("\u001b[<32;12;3M")).toBeUndefined();
    expect(leftButtonReport("\u001b[<64;12;3M")).toBeUndefined();
    expect(leftButtonReport("\u001b[<2;12;3M")).toBeUndefined();
    expect(leftButtonReport("a")).toBeUndefined();
  });
});

describe("copiedSelection", () => {
  const screen = [
    "  >_ OpenAI Codex",
    "  models with adjustable reasoning, press it to increase",
    "  reasoning effort or decrease it.",
  ];
  const lineAt = (row: number) => screen[row - 1];
  const cols = 60;

  test("a drag on one row selects from press to release", () => {
    expect(
      copiedSelection({
        copied: "adjustable reasoning",
        press: { col: 15, row: 2 },
        release: { col: 34, row: 2 },
        cols,
        lineAt,
      }),
    ).toEqual({ column: 14, row: 1, length: 20 });
  });

  test("a drag backwards and over two rows", () => {
    expect(
      copiedSelection({
        copied: "to increase\n  reasoning",
        press: { col: 11, row: 3 },
        release: { col: 46, row: 2 },
        cols,
        lineAt,
      }),
    ).toEqual({ column: 45, row: 1, length: 60 + 11 - 45 });
  });

  test("a double click selects the word under it", () => {
    expect(
      copiedSelection({
        copied: "effort",
        press: { col: 15, row: 3 },
        release: { col: 15, row: 3 },
        cols,
        lineAt,
      }),
    ).toEqual({ column: 12, row: 2, length: 6 });
  });

  test("text no longer on screen selects nothing", () => {
    expect(
      copiedSelection({
        copied: "scrolled away",
        press: { col: 3, row: 1 },
        release: { col: 15, row: 1 },
        cols,
        lineAt,
      }),
    ).toBeUndefined();
  });
});

import { describe, expect, test } from "vitest";
import { wholeLinkRows } from "./terminal-links";

const URL = "https://example.com/a/very/long/path?with=query";

/** Buffer rows as xterm numbers them, from 1. */
const screen =
  (...rows: string[]) =>
  (y: number) =>
    rows[y - 1];

const piece = (y: number, x1: number, x2: number) => ({
  start: { x: x1, y },
  end: { x: x2, y },
});

describe("the rows a hovered link covers", () => {
  // Claude Code breaks a long URL itself and indents the continuation.
  const rows = screen(
    "  See https://example.com/a/",
    "  very/long/path?",
    "  with=query",
    "  next line",
  );

  test("hovering the first row finds the rows below", () => {
    expect(wholeLinkRows(URL, piece(1, 7, 28), 40, rows)).toEqual([
      { y: 1, x1: 7, x2: 28 },
      { y: 2, x1: 3, x2: 17 },
      { y: 3, x1: 3, x2: 12 },
    ]);
  });

  test("hovering the middle row finds the rows on both sides", () => {
    expect(wholeLinkRows(URL, piece(2, 3, 17), 40, rows)).toEqual([
      { y: 1, x1: 7, x2: 28 },
      { y: 2, x1: 3, x2: 17 },
      { y: 3, x1: 3, x2: 12 },
    ]);
  });

  test("hovering the last row finds the rows above", () => {
    expect(wholeLinkRows(URL, piece(3, 3, 12), 40, rows)).toEqual([
      { y: 1, x1: 7, x2: 28 },
      { y: 2, x1: 3, x2: 17 },
      { y: 3, x1: 3, x2: 12 },
    ]);
  });

  test("a link on one row stays on that row", () => {
    const one = screen("before", `go ${URL} now`, "after");
    expect(wholeLinkRows(URL, piece(2, 4, 3 + URL.length), 80, one)).toEqual([
      { y: 2, x1: 4, x2: 3 + URL.length },
    ]);
  });

  test("a labelled link keeps the label's cells", () => {
    const labelled = screen("open the docs here", "https://example.com/");
    expect(wholeLinkRows(URL, piece(1, 10, 13), 40, labelled)).toEqual([
      { y: 1, x1: 10, x2: 13 },
    ]);
  });

  test("a neighbouring row that only shares a character is not the link", () => {
    const near = screen(
      "path/",
      "https://example.com/a/very/long/path?with=query",
    );
    expect(wholeLinkRows(URL, piece(2, 1, URL.length), 80, near)).toEqual([
      { y: 2, x1: 1, x2: URL.length },
    ]);
  });

  test("a row that soft-wraps keeps xterm's own range", () => {
    const wrapped = screen(
      "xx https://example.com/a/very",
      "/long/path?with=query",
    );
    expect(
      wholeLinkRows(
        URL,
        { start: { x: 4, y: 1 }, end: { x: 21, y: 2 } },
        29,
        wrapped,
      ),
    ).toEqual([
      { y: 1, x1: 4, x2: 29 },
      { y: 2, x1: 1, x2: 21 },
    ]);
  });
});

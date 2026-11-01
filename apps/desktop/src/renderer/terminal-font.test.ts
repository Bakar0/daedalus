import { describe, expect, test } from "vitest";
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  clampTerminalFontSize,
  parseTerminalFontSize,
} from "./terminal-font";

describe("terminal font size", () => {
  test("stays between the smallest and largest size", () => {
    expect(clampTerminalFontSize(TERMINAL_FONT_SIZE_MIN - 1)).toBe(
      TERMINAL_FONT_SIZE_MIN,
    );
    expect(clampTerminalFontSize(TERMINAL_FONT_SIZE_MAX + 1)).toBe(
      TERMINAL_FONT_SIZE_MAX,
    );
    expect(clampTerminalFontSize(14.4)).toBe(14);
    expect(clampTerminalFontSize(Number.NaN)).toBe(TERMINAL_FONT_SIZE);
  });

  test("reads a stored size, or the default for none or garbage", () => {
    expect(parseTerminalFontSize("18")).toBe(18);
    expect(parseTerminalFontSize("99")).toBe(TERMINAL_FONT_SIZE_MAX);
    expect(parseTerminalFontSize(null)).toBe(TERMINAL_FONT_SIZE);
    expect(parseTerminalFontSize("")).toBe(TERMINAL_FONT_SIZE);
    expect(parseTerminalFontSize("big")).toBe(TERMINAL_FONT_SIZE);
  });
});

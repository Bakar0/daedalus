import { expect, test } from "bun:test";
import { phoneTerminalInput } from "./terminal-input";

test("drops the mouse reports a tap produces", () => {
  expect(phoneTerminalInput("\u001b[<0;NaN;NaNM\u001b[<0;NaN;NaNm")).toBe("");
  expect(phoneTerminalInput("\u001b[<64;12;5M")).toBe("");
  expect(phoneTerminalInput("\u001b[32;NaN;NaNM")).toBe("");
  expect(phoneTerminalInput("\u001b[M !!")).toBe("");
});

test("keeps typing, keys and other escape sequences", () => {
  expect(phoneTerminalInput("ls -la\r")).toBe("ls -la\r");
  expect(phoneTerminalInput("\u001b[A\u001b[Z\u0003")).toBe(
    "\u001b[A\u001b[Z\u0003",
  );
  expect(phoneTerminalInput("a\u001b[<0;3;4Mb")).toBe("ab");
});

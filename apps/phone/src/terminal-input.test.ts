import { expect, test } from "bun:test";
import { BACKSPACE, phoneTerminalInput, typingDiff } from "./terminal-input";

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

test("typing appends, deleting backspaces, an edit does both", () => {
  expect(typingDiff("", "hello")).toBe("hello");
  expect(typingDiff("hello", "hello there")).toBe(" there");
  expect(typingDiff("hello", "hell")).toBe(BACKSPACE);
  expect(typingDiff("hello", "help")).toBe(`${BACKSPACE.repeat(2)}p`);
  expect(typingDiff("hello", "")).toBe(BACKSPACE.repeat(5));
});

test("an emoji is one character and a newline is a space", () => {
  expect(typingDiff("ok 👍", "ok ")).toBe(BACKSPACE);
  expect(typingDiff("", "a\nb")).toBe("a b");
});

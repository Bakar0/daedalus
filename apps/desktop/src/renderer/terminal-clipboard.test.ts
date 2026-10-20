import { describe, expect, test } from "vitest";
import {
  CLOUD_CLIPBOARD_WINDOW_MS,
  DRAG_DISTANCE_PX,
  TerminalClipboardGate,
} from "./terminal-clipboard";

const cloud = (now: number, hasSelection = false) => ({
  cloud: true,
  now,
  hasSelection,
});

/** A press at the origin, moved `distance` pixels, released at `at`. */
function gesture(gate: TerminalClipboardGate, distance: number, at: number) {
  gate.press(10, 10);
  gate.move(10 + distance, 10);
  gate.release(at);
}

describe("terminal clipboard writes", () => {
  test("a local session may always write the clipboard", () => {
    const gate = new TerminalClipboardGate();
    expect(gate.accepts({ cloud: false, now: 5, hasSelection: false })).toBe(
      true,
    );
    expect(gate.accepts({ cloud: false, now: 6, hasSelection: false })).toBe(
      true,
    );
  });

  test("a cloud session may not write without a gesture", () => {
    expect(new TerminalClipboardGate().accepts(cloud(100_000))).toBe(false);
  });

  test("a click to focus a cloud terminal allows no write (N-3)", () => {
    const gate = new TerminalClipboardGate();
    gesture(gate, 0, 100_000);
    expect(gate.accepts(cloud(100_100))).toBe(false);
    gesture(gate, DRAG_DISTANCE_PX - 1, 200_000);
    expect(gate.accepts(cloud(200_100))).toBe(false);
  });

  test("a drag allows one write, within the window", () => {
    const gate = new TerminalClipboardGate();
    gesture(gate, DRAG_DISTANCE_PX, 100_000);
    expect(gate.accepts(cloud(100_200))).toBe(true);
    // One write per gesture: a program writing again gets nothing.
    expect(gate.accepts(cloud(100_300))).toBe(false);

    gesture(gate, 40, 200_000);
    expect(gate.accepts(cloud(200_000 + CLOUD_CLIPBOARD_WINDOW_MS + 1))).toBe(
      false,
    );
    gesture(gate, 40, 300_000);
    expect(gate.accepts(cloud(299_999))).toBe(false);
  });

  test("a click that leaves a selection allows one write", () => {
    const gate = new TerminalClipboardGate();
    gesture(gate, 0, 100_000);
    expect(gate.accepts(cloud(100_100, true))).toBe(true);
    expect(gate.accepts(cloud(100_200, true))).toBe(false);
  });

  test("a selection alone, without a gesture, allows nothing", () => {
    expect(new TerminalClipboardGate().accepts(cloud(100_000, true))).toBe(
      false,
    );
  });

  test("a gesture in progress allows nothing until it ends", () => {
    const gate = new TerminalClipboardGate();
    gesture(gate, 40, 100_000);
    gate.press(0, 0);
    gate.move(50, 50);
    expect(gate.accepts(cloud(100_100))).toBe(false);
    gate.release(100_200);
    expect(gate.accepts(cloud(100_300))).toBe(true);
  });

  test("a release or move without a press in the terminal counts for nothing", () => {
    const gate = new TerminalClipboardGate();
    gate.move(0, 0);
    gate.move(100, 100);
    gate.release(100_000);
    expect(gate.accepts(cloud(100_100, true))).toBe(false);
  });
});

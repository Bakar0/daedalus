import { describe, expect, test } from "vitest";
import {
  acceptsClipboardWrite,
  CLOUD_CLIPBOARD_WINDOW_MS,
} from "./terminal-clipboard";

describe("terminal clipboard writes", () => {
  test("a local session may always write the clipboard", () => {
    expect(
      acceptsClipboardWrite({ cloud: false, lastPointerAt: undefined, now: 5 }),
    ).toBe(true);
  });

  test("a cloud session only just after a selection in its terminal", () => {
    const now = 100_000;
    expect(
      acceptsClipboardWrite({ cloud: true, lastPointerAt: undefined, now }),
    ).toBe(false);
    expect(
      acceptsClipboardWrite({ cloud: true, lastPointerAt: now - 200, now }),
    ).toBe(true);
    expect(
      acceptsClipboardWrite({
        cloud: true,
        lastPointerAt: now - CLOUD_CLIPBOARD_WINDOW_MS - 1,
        now,
      }),
    ).toBe(false);
  });
});

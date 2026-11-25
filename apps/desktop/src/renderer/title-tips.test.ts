import { expect, test } from "bun:test";
import { TIP_FOCUS_MS, TIP_HOVER_MS } from "./title-tips";

test("a tip waits within what design systems publish, 300 to 500 ms", () => {
  for (const wait of [TIP_HOVER_MS, TIP_FOCUS_MS]) {
    expect(wait).toBeGreaterThanOrEqual(300);
    expect(wait).toBeLessThanOrEqual(500);
  }
});

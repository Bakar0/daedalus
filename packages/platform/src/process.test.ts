import { describe, expect, test, vi } from "vitest";
import { findExecutable } from "./process";

describe("findExecutable", () => {
  test("uses an absolute fallback when a GUI process has no shell PATH", () => {
    const which = vi.fn((candidate: string) =>
      candidate === "/opt/homebrew/bin/tmux" ? candidate : null,
    );
    expect(
      findExecutable(
        "tmux",
        ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"],
        which,
      ),
    ).toBe("/opt/homebrew/bin/tmux");
    expect(which).toHaveBeenCalledWith("tmux");
    expect(which).toHaveBeenCalledWith("/opt/homebrew/bin/tmux");
  });
});

import { describe, expect, test, vi } from "vitest";
import { resolveAgentExecutable } from "./providers";

describe("resolveAgentExecutable", () => {
  test("prefers the trusted ChatGPT Codex binary for standard macOS Codex paths", () => {
    const finder = vi.fn((value: string) =>
      value === "/Applications/ChatGPT.app/Contents/Resources/codex"
        ? value
        : undefined,
    );

    expect(
      resolveAgentExecutable(
        "codex",
        "/opt/homebrew/bin/codex",
        finder,
        "darwin",
      ),
    ).toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
  });

  test("preserves custom agent executables", () => {
    const finder = vi.fn((value: string) => value);

    expect(
      resolveAgentExecutable("codex", "/custom/codex", finder, "darwin"),
    ).toBe("/custom/codex");
    expect(finder).toHaveBeenCalledOnce();
  });

  test("falls back to the configured Codex binary when ChatGPT is unavailable", () => {
    const finder = vi.fn((value: string) =>
      value === "/opt/homebrew/bin/codex" ? value : undefined,
    );

    expect(
      resolveAgentExecutable(
        "codex",
        "/opt/homebrew/bin/codex",
        finder,
        "darwin",
      ),
    ).toBe("/opt/homebrew/bin/codex");
  });
});

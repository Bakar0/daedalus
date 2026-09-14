import { describe, expect, test, vi } from "vitest";
import {
  isValidModelName,
  modelArgument,
  parseClaudeModelCatalog,
  resolveAgentExecutable,
} from "./providers";

describe("isValidModelName", () => {
  test("accepts Claude context suffixes without accepting arbitrary brackets", () => {
    expect(isValidModelName("claude-fable-5-1[1m]")).toBe(true);
    expect(isValidModelName("opus[1m]")).toBe(true);
    expect(isValidModelName("claude-fable-5-1[anything]")).toBe(false);
    expect(isValidModelName("claude-fable-5-1[]")).toBe(false);
  });
});

describe("modelArgument", () => {
  test("returns the last explicit model override", () => {
    expect(modelArgument(["--model", "opus"])).toBe("opus");
    expect(modelArgument(["-m", "first", "--model=second"])).toBe("second");
    expect(modelArgument([])).toBeUndefined();
  });
});

describe("parseClaudeModelCatalog", () => {
  test("uses Claude's account-aware resolved models and default", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "status" }),
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "request-1",
          response: {
            models: [
              {
                value: "default",
                resolvedModel: "claude-opus-5[1m]",
                displayName: "Default (recommended)",
                description: "Opus 5 with 1M context",
              },
              {
                value: "sonnet",
                resolvedModel: "claude-sonnet-5",
                displayName: "Sonnet",
                description: "Sonnet 5 · Efficient for routine tasks",
              },
            ],
          },
        },
      }),
    ].join("\n");

    expect(parseClaudeModelCatalog(stdout, "request-1")).toEqual({
      provider: "claude",
      defaultModel: "claude-opus-5[1m]",
      source: "provider",
      models: [
        {
          id: "sonnet",
          resolvedModel: "claude-sonnet-5",
          label: "Sonnet",
          description: "Sonnet 5 · Efficient for routine tasks",
        },
      ],
    });
  });

  test("resolves a configured alias through Claude's catalog", () => {
    const stdout = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "request-2",
        response: {
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus-5[1m]",
              displayName: "Default",
            },
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-5",
              displayName: "Sonnet",
            },
          ],
        },
      },
    });

    expect(
      parseClaudeModelCatalog(stdout, "request-2", "sonnet").defaultModel,
    ).toBe("claude-sonnet-5");
  });
});

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

import { describe, expect, test, vi } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "../config";
import {
  claudeDaedalusSettingsArgs,
  isValidModelName,
  modelArgument,
  parseClaudeModelCatalog,
  resolveAgentExecutable,
} from "./providers";

const settingsValue = (args: string[]): string =>
  args[args.indexOf("--settings") + 1]!;

describe("claudeDaedalusSettingsArgs", () => {
  test("injects the status line and the activity hooks", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      const args = await claudeDaedalusSettingsArgs(config, ["run"]);
      expect(args[0]).toBe("run");
      const settings = JSON.parse(settingsValue(args));
      expect(settings.statusLine.command).toContain("agent telemetry");
      expect(Object.keys(settings.hooks)).toContain("Notification");
      expect(settings.hooks.PreToolUse[0].hooks[0]).toMatchObject({
        args: ["agent", "event", "PreToolUse"],
        async: true,
        timeout: 5,
      });
      // Teardown gets a shorter leash than the rest.
      expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    });
  });

  test("merges into the user's own settings instead of skipping injection", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      const theirs = {
        statusLine: { type: "command", command: "mine" },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "their-hook" }] }],
        },
      };
      const args = await claudeDaedalusSettingsArgs(config, [
        "run",
        "--settings",
        JSON.stringify(theirs),
      ]);
      const settings = JSON.parse(settingsValue(args));
      // Their status line survives; ours is only a default.
      expect(settings.statusLine.command).toBe("mine");
      // Their hook is kept, and ordered ahead of ours.
      expect(settings.hooks.PreToolUse).toHaveLength(2);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("their-hook");
      expect(settings.hooks.PreToolUse[1].hooks[0].args).toEqual([
        "agent",
        "event",
        "PreToolUse",
      ]);
      // Exactly one --settings reaches Claude.
      expect(args.filter((value) => value === "--settings")).toHaveLength(1);
    });
  });

  test("relaunching does not accumulate duplicate Daedalus entries", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      const first = await claudeDaedalusSettingsArgs(config, ["run"]);
      const second = await claudeDaedalusSettingsArgs(config, first);
      expect(JSON.parse(settingsValue(second)).hooks.Stop).toHaveLength(1);
    });
  });

  test("leaves an unreadable --settings value exactly as the user wrote it", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      expect(
        await claudeDaedalusSettingsArgs(config, [
          "--settings",
          "missing.json",
        ]),
      ).toEqual(["--settings", "missing.json"]);
    });
  });
});

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

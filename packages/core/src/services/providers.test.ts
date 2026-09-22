import { describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "../config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { saveSkillOverride } from "../config";
import {
  claudeDaedalusSettingsArgs,
  ensureCodexHooks,
  isValidModelName,
  modelArgument,
  parseClaudeModelCatalog,
  permissionModeArgs,
  resolveAgentExecutable,
  resolveProvider,
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

describe("permissionModeArgs", () => {
  test("starts each provider in its own relaxed mode by default", () => {
    expect(permissionModeArgs("claude")).toEqual(["--permission-mode", "auto"]);
    // `approval_policy` has to stay `on-request`: under `never` no escalation
    // is raised and the reviewer would never be consulted at all.
    expect(permissionModeArgs("codex")).toEqual([
      "-c",
      'approvals_reviewer="auto_review"',
      "-c",
      'approval_policy="on-request"',
    ]);
  });

  test("inherit leaves the provider's own configuration to decide", () => {
    expect(permissionModeArgs("claude", "inherit")).toEqual([]);
    expect(permissionModeArgs("codex", "inherit")).toEqual([]);
  });

  test("a provider with no relaxed mode of its own gets nothing", () => {
    expect(permissionModeArgs("custom")).toEqual([]);
  });
});

describe("buildLaunch permission mode", () => {
  // CODEX_HOME is isolated because `ensureCodexHooks` writes a hook block to
  // `$CODEX_HOME/config.toml`, and the default is the developer's real one.
  const isolated = async (home: string) =>
    loadConfig({ DAEDALUS_HOME: home, CODEX_HOME: join(home, "codex") });

  test("a spawned Claude session starts in auto", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const { adapter } = resolveProvider(config, { provider: "claude" });
      const { args } = await adapter.buildLaunch({});
      expect(args).toContain("--permission-mode");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    });
  });

  test("a spawned Codex session starts with the auto reviewer", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const { adapter } = resolveProvider(config, { provider: "codex" });
      const { args } = await adapter.buildLaunch({});
      const at = args.indexOf('approvals_reviewer="auto_review"');
      expect(at).toBeGreaterThan(-1);
      expect(args[at - 1]).toBe("-c");
      const policy = args.indexOf('approval_policy="on-request"');
      expect(policy).toBeGreaterThan(-1);
      expect(args[policy - 1]).toBe("-c");
    });
  });

  test("inherit spawns neither provider with a mode argument", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      config.agents.claude!.permissionMode = "inherit";
      config.agents.codex!.permissionMode = "inherit";
      const claude = await resolveProvider(config, {
        provider: "claude",
      }).adapter.buildLaunch({});
      expect(claude.args).not.toContain("--permission-mode");
      const codex = await resolveProvider(config, {
        provider: "codex",
      }).adapter.buildLaunch({});
      expect(codex.args).not.toContain('approvals_reviewer="auto_review"');
    });
  });
});

describe("ensureCodexHooks and the user's skill settings", () => {
  /** A skill Codex scans, switched off by the user. */
  const withSwitchedOffSkill = async (home: string) => {
    const config = await loadConfig({
      DAEDALUS_HOME: home,
      CODEX_HOME: join(home, "codex"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      DAEDALUS_AGENTS_HOME: join(home, "agents"),
      DAEDALUS_CURSOR_HOME: join(home, "cursor"),
    });
    const directory = join(home, "agents", "skills", "loud");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: loud\ndescription: Loud\n---\n",
      "utf8",
    );
    await saveSkillOverride(config, "loud", "off");
    return config;
  };

  test("an old Codex still gets the skill settings, just no hooks", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await withSwitchedOffSkill(home);
      // The version probe used to decide both, so on a build that ignores
      // hooks, turning a skill off wrote the preference and then quietly did
      // nothing about it.
      const args = await ensureCodexHooks(config, "codex", async () => ({
        exitCode: 0,
        stdout: "codex-cli 0.144.9",
        stderr: "",
      }));
      expect(args).toEqual([]);
      const written = await readFile(
        join(home, "codex", "config.toml"),
        "utf8",
      );
      expect(written).toContain("[[skills.config]]");
      expect(written).toContain("enabled = false");
      expect(written).not.toContain("[[hooks.");
    });
  });

  test("a current Codex gets both", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await withSwitchedOffSkill(home);
      const args = await ensureCodexHooks(config, "codex", async () => ({
        exitCode: 0,
        stdout: "codex-cli 0.154.0",
        stderr: "",
      }));
      expect(args).toEqual(["-c", "features.hooks=true"]);
      const written = await readFile(
        join(home, "codex", "config.toml"),
        "utf8",
      );
      expect(written).toContain("[[skills.config]]");
      expect(written).toContain("[[hooks.");
    });
  });

  test("an old Codex with nothing switched off leaves the file alone", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({
        DAEDALUS_HOME: home,
        CODEX_HOME: join(home, "codex"),
      });
      const args = await ensureCodexHooks(config, "codex", async () => ({
        exitCode: 0,
        stdout: "codex-cli 0.144.9",
        stderr: "",
      }));
      expect(args).toEqual([]);
      expect(await Bun.file(join(home, "codex", "config.toml")).exists()).toBe(
        false,
      );
    });
  });

  test("a skill only Cursor loads gets no Codex entry", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({
        DAEDALUS_HOME: home,
        CODEX_HOME: join(home, "codex"),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        DAEDALUS_AGENTS_HOME: join(home, "agents"),
        DAEDALUS_CURSOR_HOME: join(home, "cursor"),
      });
      const directory = join(home, "cursor", "skills", "cursor-only");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "SKILL.md"),
        "---\nname: cursor-only\ndescription: Cursor\n---\n",
        "utf8",
      );
      await saveSkillOverride(config, "cursor-only", "off");
      // Codex never scans ~/.cursor/skills, so an entry naming that path would
      // sit in the config looking like a setting that was doing something.
      const args = await ensureCodexHooks(config, "codex", async () => ({
        exitCode: 0,
        stdout: "codex-cli 0.144.9",
        stderr: "",
      }));
      expect(args).toEqual([]);
      expect(await Bun.file(join(home, "codex", "config.toml")).exists()).toBe(
        false,
      );
    });
  });
});

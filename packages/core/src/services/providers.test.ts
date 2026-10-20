import { describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "../config";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { saveSkillOverride } from "../config";
import {
  catalogOffersModel,
  claudeDaedalusSettingsArgs,
  CODEX_DAEDALUS_TUI_ARGS,
  codexConfigPath,
  DAEDALUS_STATUS_INSTRUCTIONS,
  daedalusInstructionArgs,
  ensureCodexHooks,
  isValidModelName,
  modelArgument,
  parseClaudeModelCatalog,
  permissionModeArgs,
  providerExecutableFallbacks,
  removeClaudeSettingsFiles,
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

  test("passes a session's settings as a file, not inline JSON", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      const theirs = join(home, "their-settings.json");
      await writeFile(
        theirs,
        JSON.stringify({ statusLine: { type: "command", command: "mine" } }),
      );
      const args = await claudeDaedalusSettingsArgs(
        config,
        ["run", "--settings", theirs],
        "s1",
      );
      const path = settingsValue(args);
      // The inline hooks were about 4 KB of a launch tmux caps at 16 KB.
      expect(path).toBe(
        join(config.home, "claude-settings", "s1.daedalus-inbox.json"),
      );
      expect(args.filter((value) => value === "--settings")).toHaveLength(1);
      const settings = JSON.parse(await readFile(path, "utf8"));
      expect(settings.statusLine.command).toBe("mine");
      expect(Object.keys(settings.hooks)).toContain("Notification");
      // A relaunch from the written file keeps one copy of each hook.
      const again = await claudeDaedalusSettingsArgs(config, args, "s1");
      expect(
        JSON.parse(await readFile(settingsValue(again), "utf8")).hooks.Stop,
      ).toHaveLength(1);
      await removeClaudeSettingsFiles(config, "s1");
      expect(await Bun.file(path).exists()).toBe(false);
    });
  });

  test("starts Claude in the fullscreen renderer unless the user chose one", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const claudeHome = join(home, "claude");
      const config = await loadConfig({
        DAEDALUS_HOME: home,
        CLAUDE_CONFIG_DIR: claudeHome,
      });
      const renderer = async (args: string[]) =>
        JSON.parse(
          settingsValue(await claudeDaedalusSettingsArgs(config, args)),
        ).tui;
      expect(await renderer(["run"])).toBe("fullscreen");
      // A choice in --settings is kept.
      expect(
        await renderer([
          "run",
          "--settings",
          JSON.stringify({ tui: "classic" }),
        ]),
      ).toBe("classic");
      // So is one in the user's own settings, which --settings would override.
      await mkdir(claudeHome, { recursive: true });
      await writeFile(
        join(claudeHome, "settings.json"),
        JSON.stringify({ tui: "classic" }),
      );
      expect(await renderer(["run"])).toBeUndefined();
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

describe("catalogOffersModel", () => {
  test("matches a catalog id or the model an alias resolves to", () => {
    const catalog = {
      provider: "claude" as const,
      source: "provider" as const,
      models: [
        { id: "sonnet", label: "Sonnet", resolvedModel: "claude-sonnet-5" },
        { id: "gpt-5-codex", label: "GPT-5 Codex" },
      ],
    };
    expect(catalogOffersModel(catalog, "sonnet")).toBe(true);
    expect(catalogOffersModel(catalog, "claude-sonnet-5")).toBe(true);
    expect(catalogOffersModel(catalog, "gpt-5-codex")).toBe(true);
    expect(catalogOffersModel(catalog, "opus")).toBe(false);
    expect(catalogOffersModel(catalog, "Sonnet")).toBe(false);
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

describe("providerExecutableFallbacks", () => {
  test("finds Claude where its own install script puts it", () => {
    // #105: Claude installed with `curl -fsSL https://claude.ai/install.sh`
    // lives in ~/.local/bin, which the app's Launch Services PATH lacks.
    expect(providerExecutableFallbacks("claude", "/Users/someone", "")).toEqual(
      [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
        "/bin/claude",
        "/Users/someone/.local/bin/claude",
        "/Users/someone/.claude/local/claude",
      ],
    );
  });

  test("looks on the login shell's PATH last, once it is known", () => {
    expect(
      providerExecutableFallbacks(
        "codex",
        "/Users/someone",
        "/Users/someone/.nvm/versions/node/v22/bin:/usr/bin:relative:",
      ),
    ).toEqual([
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/usr/bin/codex",
      "/bin/codex",
      "/Users/someone/.local/bin/codex",
      "/Users/someone/.nvm/versions/node/v22/bin/codex",
    ]);
  });

  test("uses a configured path as it is", () => {
    expect(
      providerExecutableFallbacks("/custom/claude", "/Users/someone", "/x"),
    ).toEqual([]);
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

describe("daedalusInstructionArgs", () => {
  const isolated = async (home: string) =>
    loadConfig({ DAEDALUS_HOME: home, CODEX_HOME: join(home, "codex") });

  test("Claude is told through --append-system-prompt", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      expect(await daedalusInstructionArgs(config, "claude", ["run"])).toEqual([
        "run",
        "--append-system-prompt",
        DAEDALUS_STATUS_INSTRUCTIONS,
      ]);
      // A user's own appended prompt is kept, with ours after it.
      const joined = await daedalusInstructionArgs(config, "claude", [
        "--append-system-prompt",
        "Be terse.",
      ]);
      expect(joined).toEqual([
        "--append-system-prompt",
        `Be terse.\n\n${DAEDALUS_STATUS_INSTRUCTIONS}`,
      ]);
      // A prompt file cannot be joined, so it is left alone.
      const file = ["--append-system-prompt-file", "/tmp/p.md"];
      expect(await daedalusInstructionArgs(config, "claude", file)).toEqual(
        file,
      );
    });
  });

  test("Codex is told through developer_instructions unless the user set it", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const args = await daedalusInstructionArgs(config, "codex", []);
      expect(args[0]).toBe("-c");
      expect(args[1]).toBe(
        `developer_instructions=${JSON.stringify(DAEDALUS_STATUS_INSTRUCTIONS)}`,
      );
      await mkdir(join(home, "codex"), { recursive: true });
      await writeFile(
        codexConfigPath(config),
        'developer_instructions = "Mine."\n',
      );
      expect(await daedalusInstructionArgs(config, "codex", ["x"])).toEqual([
        "x",
      ]);
    });
  });

  test("a spawned session carries them, and a custom command does not", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const claude = resolveProvider(config, { provider: "claude" });
      const { args } = await claude.adapter.buildLaunch({});
      expect(args).toContain(DAEDALUS_STATUS_INSTRUCTIONS);
      expect(await daedalusInstructionArgs(config, "custom", ["x"])).toEqual([
        "x",
      ]);
    });
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

  test("passes each additional directory once, as an argument", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const { adapter } = resolveProvider(config, { provider: "claude" });
      const { args, env } = await adapter.buildLaunch({
        additionalDirectories: ["/repos/a", "/repos/b"],
      });
      expect(args.filter((value) => value === "--add-dir")).toHaveLength(2);
      // The same list in the environment doubled its share of the command
      // tmux has to accept, and nothing read it.
      expect(Object.values(env).join()).not.toContain("/repos/a");
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

  test("a Codex session can write the Daedalus home, and a Claude one is not sandboxed", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const codex = await resolveProvider(config, {
        provider: "codex",
      }).adapter.buildLaunch({});
      // Without it every `daedal` write from inside the sandbox fails with
      // "attempt to write a readonly database".
      const at = codex.args.lastIndexOf(config.home);
      expect(at).toBeGreaterThan(-1);
      expect(codex.args[at - 1]).toBe("--add-dir");
      const claude = await resolveProvider(config, {
        provider: "claude",
      }).adapter.buildLaunch({});
      expect(claude.args).not.toContain(config.home);
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

describe("buildLaunch resume", () => {
  const nativeId = "8ceaa092-b66b-4dc9-8b5d-a2e7cd40ae7b";
  const startedAt = "2026-10-20T09:00:00.000Z";
  const isolated = async (home: string) =>
    loadConfig({ DAEDALUS_HOME: home, CODEX_HOME: join(home, "codex") });

  /** A `codex` that logs every invocation and succeeds, or fails `unarchive`. */
  const codexRecorder = async (home: string, failUnarchive = false) => {
    const path = join(home, "codex-recorder");
    const log = join(home, "codex-invocations.log");
    await writeFile(
      path,
      `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$PWD" "$CODEX_HOME" >> ${JSON.stringify(log)}\n${
        failUnarchive
          ? `[ "$1" = "unarchive" ] && { echo "no such thread" >&2; exit 1; }\n`
          : ""
      }exit 0\n`,
    );
    await chmod(path, 0o755);
    return {
      path,
      invocations: async () =>
        (await readFile(log, "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean),
    };
  };

  const writeRollout = async (home: string) => {
    const directory = join(home, "codex", "sessions", "2026", "10", "20");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `rollout-${nativeId}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: nativeId } })}\n`,
    );
  };

  const resume = (home: string, overrides: { archived?: boolean } = {}) => ({
    nativeId,
    startedAt,
    archived: overrides.archived ?? false,
    workingDirectory: home,
    env: { CODEX_HOME: join(home, "account") },
  });

  test("Claude resumes its conversation instead of naming a new one", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const { adapter } = resolveProvider(config, { provider: "claude" });
      const launch = await adapter.buildLaunch({
        sessionId: "daedalus-session",
        sessionName: "Name",
        model: "opus",
        resume: resume(home),
      });
      expect(launch.args.slice(-2)).toEqual(["--resume", nativeId]);
      expect(launch.providerSessionId).toBe(nativeId);
      expect(launch.args).not.toContain("--session-id");
      expect(launch.args).not.toContain("--name");
      expect(launch.args).toContain("--settings");
      expect(launch.args).toContain(DAEDALUS_STATUS_INSTRUCTIONS);
      expect(modelArgument(launch.args)).toBe("opus");
      // Applied at spawn only: a user who tightened the session keeps it.
      expect(launch.args).not.toContain("--permission-mode");
    });
  });

  test("Claude refuses to resume a session with no conversation id", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const { adapter } = resolveProvider(config, { provider: "claude" });
      await expect(
        adapter.buildLaunch({
          resume: { ...resume(home), nativeId: undefined },
        }),
      ).rejects.toThrow("predates native resume support");
    });
  });

  test("Codex resumes a kept conversation with the same reach as a spawn", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const codex = await codexRecorder(home);
      config.agents.codex!.executable = codex.path;
      await writeRollout(home);
      const launch = await resolveProvider(config, {
        provider: "codex",
      }).adapter.buildLaunch({
        additionalDirectories: ["/repos/a"],
        resume: resume(home),
      });
      expect(launch.args.slice(-2)).toEqual(["resume", nativeId]);
      expect(launch.providerSessionId).toBe(nativeId);
      expect(launch.args).toContain("/repos/a");
      // The sandbox would otherwise refuse every `daedal` write.
      expect(launch.args[launch.args.indexOf(config.home) - 1]).toBe(
        "--add-dir",
      );
      expect(launch.args).toContain("--no-alt-screen");
      expect(launch.args).not.toContain('approvals_reviewer="auto_review"');
      // Never archived, so not unarchived either.
      expect(
        (await codex.invocations()).some((line) =>
          line.startsWith("unarchive"),
        ),
      ).toBe(false);
    });
  });

  test("Codex's resume argv in full", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const codex = await codexRecorder(home);
      config.agents.codex!.executable = codex.path;
      await writeRollout(home);
      const launch = await resolveProvider(config, {
        provider: "codex",
      }).adapter.buildLaunch({
        model: "gpt-5",
        additionalDirectories: ["/repos/a", "/repos/b"],
        resume: resume(home),
      });
      // The recorder prints no version, so this Codex gets no hook flags.
      expect(launch.args).toEqual([
        "--model",
        "gpt-5",
        "--add-dir",
        "/repos/a",
        "--add-dir",
        "/repos/b",
        ...CODEX_DAEDALUS_TUI_ARGS,
        "--add-dir",
        config.home,
        "-c",
        `developer_instructions=${JSON.stringify(DAEDALUS_STATUS_INSTRUCTIONS)}`,
        "resume",
        nativeId,
      ]);
    });
  });

  test("Codex unarchives an archived conversation on the session's account", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const codex = await codexRecorder(home);
      config.agents.codex!.executable = codex.path;
      await writeRollout(home);
      await resolveProvider(config, { provider: "codex" }).adapter.buildLaunch({
        resume: resume(home, { archived: true }),
      });
      expect(await codex.invocations()).toContain(
        `unarchive ${nativeId}|${await realpath(home)}|${join(home, "account")}`,
      );
    });
  });

  test("Codex refuses a resume it could not unarchive", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const codex = await codexRecorder(home, true);
      config.agents.codex!.executable = codex.path;
      await writeRollout(home);
      await expect(
        resolveProvider(config, { provider: "codex" }).adapter.buildLaunch({
          resume: resume(home, { archived: true }),
        }),
      ).rejects.toThrow("no such thread");
    });
  });

  test("Codex starts a new conversation when none was kept", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      const codex = await codexRecorder(home);
      config.agents.codex!.executable = codex.path;
      for (const nativeIdOverride of [nativeId, undefined]) {
        const launch = await resolveProvider(config, {
          provider: "codex",
        }).adapter.buildLaunch({
          resume: {
            ...resume(home, { archived: true }),
            nativeId: nativeIdOverride,
          },
        });
        expect(launch.args).not.toContain("resume");
        expect(launch.providerSessionId).toBeUndefined();
      }
      expect(
        (await codex.invocations()).some((line) =>
          line.startsWith("unarchive"),
        ),
      ).toBe(false);
    });
  });

  test("a custom command cannot be resumed", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await isolated(home);
      config.agents.shell = { executable: "/bin/sh", args: [] };
      await expect(
        resolveProvider(config, { command: "shell" }).adapter.buildLaunch({
          resume: resume(home),
        }),
      ).rejects.toThrow("native resume capability");
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

  test("a Codex with a shared app server runs the session without it", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({
        DAEDALUS_HOME: home,
        CODEX_HOME: join(home, "codex"),
      });
      // The shared server runs hooks with its own environment, so they could
      // not tell which Daedalus session they belonged to.
      const args = await ensureCodexHooks(config, "codex", async (_, argv) => ({
        exitCode: 0,
        stdout:
          argv[0] === "--help"
            ? "Options:\n      --no-daemon\n          Run without the shared background server\n"
            : "codex-cli 0.162.0",
        stderr: "",
      }));
      expect(args).toEqual(["-c", "features.hooks=true", "--no-daemon"]);
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

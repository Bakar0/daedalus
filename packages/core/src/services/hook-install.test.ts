import { describe, expect, test } from "vitest";
import {
  codexActivityTier,
  CODEX_HOOK_EVENTS,
  codexConfiguredHookEvents,
  codexHookTrustKeys,
  codexSupportsHooks,
  daedalusClaudeSettings,
  isDaedalusHookEntry,
  mergeClaudeSettings,
  mergeCodexConfigToml,
  renderCodexHookBlock,
} from "./hook-install";

describe("codexSupportsHooks", () => {
  test("accepts builds from 0.145 and rejects older ones", () => {
    // The exact string codex-cli 0.154.0-alpha.6.2 prints.
    expect(codexSupportsHooks("codex-cli 0.154.0-alpha.6.2")).toBe(true);
    expect(codexSupportsHooks("codex-cli 0.145.0")).toBe(true);
    expect(codexSupportsHooks("codex-cli 0.144.9")).toBe(false);
    expect(codexSupportsHooks("codex 1.0.0")).toBe(true);
  });

  test("refuses to read some other program's version as Codex's", () => {
    // Injecting hooks on the strength of `1.4.2` from bun would report a
    // capability that can never fire.
    expect(codexSupportsHooks("1.4.2")).toBe(false);
    expect(codexSupportsHooks("")).toBe(false);
    expect(codexSupportsHooks("bun 1.4.2")).toBe(false);
  });
});

/**
 * Another tool's hooks, in the shape dev-3.0 actually installs them. Daedalus
 * has to land beside these without disturbing them, because a shipped build
 * lands on machines that already have other coding tools configured.
 */
const THEIR_HOOKS = `[features]
hooks = true

# >>> other tool status hooks (generated — do not edit) >>>

[[hooks.SessionStart]]
matcher = "startup|resume"

[[hooks.SessionStart.hooks]]
type = "command"
command = "their-hook"
timeout = 5

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "their-hook"
timeout = 5
# <<< other tool status hooks <<<
`;

describe("renderCodexHookBlock", () => {
  const block = renderCodexHookBlock("/home/.daedalus/bin/daedal");

  test("covers every event and keeps request_user_input in the matcher", () => {
    for (const { event } of CODEX_HOOK_EVENTS)
      expect(block).toContain(`[[hooks.${event}]]`);
    // Without it there is no way to tell a question from a permission wait.
    expect(block).toContain("request_user_input");
  });

  test("every hook is async, offline tolerant, and has a timeout", () => {
    const commands = block
      .split("\n")
      .filter((line) => line.startsWith("command ="));
    expect(commands).toHaveLength(CODEX_HOOK_EVENTS.length);
    for (const command of commands) expect(command).toContain("|| true");
    expect(block.match(/async = true/g)).toHaveLength(CODEX_HOOK_EVENTS.length);
    // The handler field is 'timeout'; 'timeout_sec' belongs to other configs
    // and is silently ignored here.
    expect(block).not.toContain("timeout_sec");
    expect(block).toContain("timeout = 3");
    expect(block).toContain("timeout = 5");
  });

  test("quotes an executable path that would otherwise break the command", () => {
    expect(renderCodexHookBlock("/Applications/My App/daedal")).toContain(
      "'/Applications/My App/daedal'",
    );
  });
});

describe("mergeCodexConfigToml", () => {
  const block = renderCodexHookBlock("/home/.daedalus/bin/daedal");

  test("both tools' hooks survive, and ours are appended after theirs", () => {
    const merged = mergeCodexConfigToml(THEIR_HOOKS, block);
    const parsed = Bun.TOML.parse(merged) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    // The event they hooked now has two groups: theirs, then ours.
    expect(parsed.hooks.SessionStart!).toHaveLength(2);
    expect(parsed.hooks.SessionStart![0]!.hooks[0]!.command).toBe("their-hook");
    expect(parsed.hooks.SessionStart![1]!.hooks[0]!.command).toContain(
      "agent event SessionStart",
    );
    // Appending is what preserves their trust records, which Codex keys to the
    // group index.
    expect(parsed.hooks.Stop![0]!.hooks[0]!.command).toBe("their-hook");
    // An event only we hook still works.
    expect(parsed.hooks.PermissionRequest!).toHaveLength(1);
  });

  test("everything outside our fence survives byte for byte", () => {
    const merged = mergeCodexConfigToml(THEIR_HOOKS, block);
    expect(merged).toContain("# >>> other tool status hooks");
    expect(merged.slice(0, THEIR_HOOKS.trimEnd().length)).toBe(
      THEIR_HOOKS.trimEnd(),
    );
  });

  test("a relaunch replaces our block rather than accumulating copies", () => {
    const once = mergeCodexConfigToml(THEIR_HOOKS, block);
    const twice = mergeCodexConfigToml(once, block);
    const parsed = Bun.TOML.parse(twice) as {
      hooks: Record<string, unknown[]>;
    };
    expect(parsed.hooks.SessionStart!).toHaveLength(2);
    expect(twice.match(/daedalus activity hooks \(generated/g)).toHaveLength(1);
  });

  test("an unchanged config is returned untouched, so no approval is lost", () => {
    // Rewriting a hook definition invalidates its trust record, so a no-op
    // launch must be a genuine no-op.
    const once = mergeCodexConfigToml(THEIR_HOOKS, block);
    expect(mergeCodexConfigToml(once, block)).toBe(once);
  });

  test("an empty config gets just our block", () => {
    const merged = mergeCodexConfigToml("", block);
    expect(Bun.TOML.parse(merged)).toMatchObject({ hooks: {} });
    expect(merged.startsWith("# >>> daedalus")).toBe(true);
  });

  test("a changed executable path rewrites the block", () => {
    const once = mergeCodexConfigToml(THEIR_HOOKS, block);
    const moved = mergeCodexConfigToml(
      once,
      renderCodexHookBlock("/other/daedal"),
    );
    expect(moved).not.toBe(once);
    expect(moved).toContain("/other/daedal");
    expect(moved).not.toContain("/home/.daedalus/bin/daedal");
  });
});

describe("codexHookTrustKeys", () => {
  test("names our group, counted past whatever else is installed", () => {
    const merged = mergeCodexConfigToml(
      THEIR_HOOKS,
      renderCodexHookBlock("/bin/daedal"),
    );
    const keys = codexHookTrustKeys(merged, "/u/.codex/config.toml");
    // Theirs is group 0 on SessionStart, so ours is group 1.
    expect(keys).toContain("/u/.codex/config.toml:session_start:1:0");
    // Nobody else hooks PermissionRequest, so ours is group 0.
    expect(keys).toContain("/u/.codex/config.toml:permission_request:0:0");
    // They also hook Stop, so ours is group 1 there too.
    expect(keys).toContain("/u/.codex/config.toml:stop:1:0");
    // They hook neither of these, so ours is group 0.
    expect(keys).toContain("/u/.codex/config.toml:user_prompt_submit:0:0");
  });
});

describe("codexConfiguredHookEvents", () => {
  test("reports other tools' events and ignores our own block", () => {
    const merged = mergeCodexConfigToml(
      THEIR_HOOKS,
      renderCodexHookBlock("/bin/daedal"),
    );
    expect(codexConfiguredHookEvents(merged).sort()).toEqual([
      "SessionStart",
      "Stop",
    ]);
  });

  test("an unparseable config is treated as no hooks rather than throwing", () => {
    expect(codexConfiguredHookEvents("[[[not toml")).toEqual([]);
  });
});

describe("Claude settings merging", () => {
  const ours = daedalusClaudeSettings("/home/.daedalus/bin/daedal");

  test("Daedalus entries are recognisable by their command, not a marker key", () => {
    // An unknown key risks failing the provider's own settings schema.
    expect(isDaedalusHookEntry(ours.hooks!.Stop![0]!)).toBe(true);
    expect(
      isDaedalusHookEntry({
        hooks: [{ type: "command", command: "their-hook" }],
      }),
    ).toBe(false);
  });

  test("a relaunch strips the previous Daedalus entries instead of stacking them", () => {
    const once = mergeClaudeSettings({}, ours);
    const twice = mergeClaudeSettings(once, ours);
    expect(twice.hooks!.Stop).toHaveLength(1);
  });

  test("an event only the user hooks survives the merge untouched", () => {
    const merged = mergeClaudeSettings(
      {
        hooks: {
          PostModelSwitch: [{ hooks: [{ type: "command", command: "x" }] }],
        },
      },
      ours,
    );
    expect(merged.hooks!.PostModelSwitch).toHaveLength(1);
  });

  test("unrelated settings keys are carried through", () => {
    const merged = mergeClaudeSettings(
      { model: "opus", env: { A: "1" } },
      ours,
    );
    expect(merged.model).toBe("opus");
    expect(merged.env).toEqual({ A: "1" });
  });
});

describe("codexActivityTier", () => {
  const configPath = "/u/.codex/config.toml";
  const installed = mergeCodexConfigToml(
    THEIR_HOOKS,
    renderCodexHookBlock("/bin/daedal"),
  );

  test("an old build is on the rollout tier, and says so", () => {
    expect(codexActivityTier({ version: "codex-cli 0.144.0" })).toMatchObject({
      tier: "transcript",
      installed: false,
    });
    expect(codexActivityTier({})).toMatchObject({ tier: "transcript" });
  });

  test("installed but unapproved is still the rollout tier", () => {
    const tier = codexActivityTier({
      version: "codex-cli 0.154.0",
      configToml: installed,
      configPath,
    });
    expect(tier).toMatchObject({
      tier: "transcript",
      installed: true,
      trusted: false,
    });
    expect(tier.detail).toContain("Hooks need review");
    // The user should be told their other tool is unaffected.
    expect(tier.detail).toContain("both run");
  });

  test("approving every entry promotes the machine to the hook tier", () => {
    const approved =
      installed +
      codexHookTrustKeys(installed, configPath)
        .map((key) => `\n[hooks.state."${key}"]\ntrusted_hash = "sha256:abc"\n`)
        .join("");
    expect(
      codexActivityTier({
        version: "codex-cli 0.154.0",
        configToml: approved,
        configPath,
      }),
    ).toMatchObject({ tier: "hook", installed: true, trusted: true });
  });

  test("a partial approval does not claim the hook tier", () => {
    const partial =
      installed +
      `\n[hooks.state."${codexHookTrustKeys(installed, configPath)[0]}"]\ntrusted_hash = "sha256:abc"\n`;
    expect(
      codexActivityTier({
        version: "codex-cli 0.154.0",
        configToml: partial,
        configPath,
      }),
    ).toMatchObject({ tier: "transcript", trusted: false });
  });
});

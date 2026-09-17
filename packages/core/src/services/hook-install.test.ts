import { describe, expect, test } from "vitest";
import {
  codexActivityTier,
  CODEX_HOOK_EVENTS,
  codexConfiguredHookEvents,
  codexDaedalusHookArgs,
  codexSupportsHooks,
  daedalusClaudeSettings,
  isDaedalusHookEntry,
  mergeClaudeSettings,
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

describe("codexDaedalusHookArgs", () => {
  const args = codexDaedalusHookArgs("/home/.daedalus/bin/daedal");

  test("supplies every event as a -c override rather than a config write", () => {
    expect(args.filter((value) => value === "-c")).toHaveLength(8);
    expect(args.join(" ")).toContain("hooks.PermissionRequest=");
  });

  test("keeps request_user_input in the tool matcher", () => {
    // Without it there is no way to tell a question from a permission wait.
    expect(args.join(" ")).toContain("request_user_input");
  });

  test("every command is offline tolerant and every hook has a timeout", () => {
    const commands = args.filter((value) => value.startsWith("hooks."));
    expect(commands).toHaveLength(8);
    for (const command of commands) {
      expect(command).toContain("|| true");
      expect(command).toMatch(/timeout_sec=[35]/);
    }
    // Teardown gets the shorter leash.
    expect(args.join(" ")).toContain(
      'agent event SessionEnd || true",timeout_sec=3',
    );
  });

  test("leaves an event the user has already hooked entirely alone", () => {
    const merged = codexDaedalusHookArgs("/bin/daedal", ["Stop"]);
    expect(merged.join(" ")).not.toContain("hooks.Stop=");
    expect(merged.join(" ")).toContain("hooks.PreToolUse=");
  });

  test("quotes an executable path that would otherwise break the command", () => {
    const quoted = codexDaedalusHookArgs("/Applications/My App/daedal");
    expect(quoted.join(" ")).toContain("'/Applications/My App/daedal'");
  });
});

describe("codexConfiguredHookEvents", () => {
  test("reads the user's own events and ignores Codex's trust bookkeeping", () => {
    const toml = `
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "their-hook"

[hooks.state."/<session-flags>/config.toml:stop:0:0"]
trusted_hash = "sha256:abc"
`;
    expect(codexConfiguredHookEvents(toml)).toEqual(["Stop"]);
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
  test("an old build is on the rollout tier, and says so", () => {
    expect(codexActivityTier({ version: "codex-cli 0.144.0" })).toMatchObject({
      tier: "transcript",
    });
    expect(codexActivityTier({})).toMatchObject({ tier: "transcript" });
  });

  test("a machine where another tool owns every hook event keeps its hooks", () => {
    // dev-3.0 installs exactly this set globally, so it is the common case
    // rather than a hypothetical one.
    const toml = CODEX_HOOK_EVENTS.map(
      ({ event }) =>
        `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = "theirs"\n`,
    ).join("\n");
    const tier = codexActivityTier({
      version: "codex-cli 0.154.0",
      configToml: toml,
    });
    expect(tier.tier).toBe("transcript");
    expect(tier.detail).toContain("will not override your hooks");
  });

  test("a clean machine is on the hook tier, pending the trust prompt", () => {
    const tier = codexActivityTier({ version: "codex-cli 0.154.0" });
    expect(tier.tier).toBe("hook");
    expect(tier.detail).toContain("Hooks need review");
  });

  test("a partial overlap reports how much is Daedalus's", () => {
    const tier = codexActivityTier({
      version: "codex-cli 0.154.0",
      configToml: `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "theirs"\n`,
    });
    expect(tier.tier).toBe("hook");
    expect(tier.detail).toContain("7 of 8");
  });
});

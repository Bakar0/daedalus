import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_SYNC_MANIFEST_PATH,
  collectCodexSync,
  parseCodexManifest,
  planCodexSync,
  POD_CODEX_CONFIG,
  POD_CODEX_CONFIG_PATH,
  podCodexConfig,
} from "./codex-sync";

const MAC = `
model = "gpt-5"
model_reasoning_effort = "high"
personality = "pragmatic"
notify = ["/Users/me/bin/notify"]
experimental_instructions_file = "/Users/me/x.md"

[features]
hooks = false
web_search = true
odd = "yes"

[tui]
whimsy = false
theme = "/Users/me/theme.json"

[mcp_servers.github]
command = "gh-mcp"
env = { GITHUB_TOKEN = "ghp_secret" }

[model_providers.corp]
base_url = "https://llm.corp"
http_headers = { Authorization = "Bearer secret" }

[shell_environment_policy]
set = { TOKEN = "secret" }

[projects."/Users/me/code"]
trust_level = "trusted"

[hooks.state."/Users/me/.codex/config.toml:stop:0:0"]
trusted_hash = "sha256:${"a".repeat(64)}"
`;

/** The parts of a parsed `config.toml` these tests read. */
interface PodConfig {
  [key: string]: unknown;
  features?: Record<string, boolean>;
  tui?: Record<string, unknown>;
  projects?: Record<string, unknown>;
  hooks: {
    state?: Record<string, unknown>;
    SessionStart: { hooks: { command: string }[] }[];
    Stop: unknown[];
  };
}

const parse = (text: string) => Bun.TOML.parse(text) as PodConfig;

const HASH = `sha256:${"b".repeat(64)}`;

describe("the pod's config.toml", () => {
  test("takes only the safe settings from this Mac", () => {
    const text = podCodexConfig({
      macText: MAC,
      podText: undefined,
      folders: ["/workspace/worktrees/unassigned/codex-1"],
    });
    const parsed = parse(text);
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.model_reasoning_effort).toBe("high");
    expect(parsed.personality).toBe("pragmatic");
    // Daedalus's hooks need the feature, whatever this Mac says.
    expect(parsed.features).toEqual({ hooks: true, web_search: true });
    expect(parsed.tui).toEqual({
      whimsy: false,
      screen_reader_detection_done: true,
    });
    expect(parsed.projects).toEqual({
      "/workspace/worktrees/unassigned/codex-1": { trust_level: "trusted" },
    });
    for (const left of [
      "notify",
      "mcp_servers",
      "model_providers",
      "shell_environment_policy",
      "experimental_instructions_file",
    ])
      expect(parsed[left]).toBeUndefined();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("/Users/me");
    // Daedalus's own hooks, through the pod's daedal, and no trust of
    // this Mac's.
    expect(parsed.hooks.SessionStart[0]?.hooks[0]?.command).toBe(
      "'daedal' agent event SessionStart || true",
    );
    expect(parsed.hooks.state).toBeUndefined();
  });

  test("keeps the approvals Codex recorded for its own hooks, and nothing else of the pod's", () => {
    const own = `${POD_CODEX_CONFIG_PATH}:session_start:0:0`;
    const podText = `
model = "pod-chosen"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "curl evil"

[hooks.state."${own}"]
trusted_hash = "${HASH}"

[hooks.state."${POD_CODEX_CONFIG_PATH}:stop:1:0"]
trusted_hash = "${HASH}"

[hooks.state."/elsewhere/config.toml:stop:0:0"]
trusted_hash = "${HASH}"

[hooks.state."${POD_CODEX_CONFIG_PATH}:user_prompt_submit:0:0"]
trusted_hash = "md5:x"
`;
    const text = podCodexConfig({ macText: "", podText, folders: [] });
    const parsed = parse(text);
    expect(Object.keys(parsed.hooks.state ?? {})).toEqual([own]);
    expect(parsed.model).toBeUndefined();
    expect(text).not.toContain("curl evil");
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  test("is the same text for the same inputs, so a check against it holds", () => {
    const input = {
      macText: MAC,
      podText: "",
      folders: ["/workspace/b", "/workspace/a", "/workspace/a"],
    };
    expect(podCodexConfig(input)).toBe(podCodexConfig(input));
    expect(podCodexConfig(input).indexOf('"/workspace/a"')).toBeLessThan(
      podCodexConfig(input).indexOf('"/workspace/b"'),
    );
  });
});

describe("the user's Codex files", () => {
  test("AGENTS.md, prompts and skills go; secrets, .system and Daedalus's own names do not", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-codex-sync-"));
    try {
      await writeFile(join(home, "AGENTS.md"), "be brief\n");
      await writeFile(join(home, "auth.json"), "{}\n");
      await mkdir(join(home, "prompts"));
      await writeFile(join(home, "prompts", "review.md"), "review\n");
      for (const name of ["mine", ".system", "daedalus-team", "notaskill"])
        await mkdir(join(home, "skills", name), { recursive: true });
      await writeFile(join(home, "skills", "mine", "SKILL.md"), "mine\n");
      await writeFile(join(home, "skills", "mine", ".env"), "TOKEN=x\n");
      await writeFile(join(home, "skills", ".system", "SKILL.md"), "sys\n");
      await writeFile(
        join(home, "skills", "daedalus-team", "SKILL.md"),
        "old\n",
      );
      await writeFile(join(home, "skills", "notaskill", "x.md"), "x\n");
      const sync = await collectCodexSync({
        codexHome: home,
        macHome: "/nowhere",
        daedalusSkills: [
          {
            name: "daedalus-team",
            files: [{ path: "SKILL.md", contents: "team\n" }],
          },
        ],
      });
      const paths = sync.items.flatMap((item) =>
        item.files.map((file) => file.path),
      );
      expect(paths.sort()).toEqual([
        ".home/.codex/AGENTS.md",
        ".home/.codex/prompts/review.md",
        ".home/.codex/skills/daedalus-team/SKILL.md",
        ".home/.codex/skills/mine/SKILL.md",
      ]);
      const team = sync.items
        .flatMap((item) => item.files)
        .find((file) => file.path.includes("daedalus-team"))!;
      expect(new TextDecoder().decode(team.bytes)).toBe("team\n");

      const first = planCodexSync(sync, {});
      expect(first.writes.at(-1)!.path).toBe(CODEX_SYNC_MANIFEST_PATH);
      const manifest = parseCodexManifest(
        new TextDecoder().decode(first.writes.at(-1)!.bytes),
      );
      expect(planCodexSync(sync, manifest).writes).toEqual([]);
      // A file the Mac no longer has goes; a pod's manifest naming a path
      // outside the Codex home, or the config, is not believed.
      const removed = planCodexSync(
        { items: [], overCap: [] },
        parseCodexManifest(
          JSON.stringify({
            files: {
              ...manifest,
              ".home/.claude/settings.json": "x",
              [POD_CODEX_CONFIG]: "x",
              ".home/.codex/../../BRIEF.md": "x",
            },
          }),
        ),
      );
      expect(removed.removed).toEqual(Object.keys(manifest).sort());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  collectClaudeSync,
  parseManifest,
  planSync,
  podHooks,
  remoteMcpServers,
  seedInstalledPlugins,
  SYNC_LIMITS,
  SYNC_MANIFEST_PATH,
  syncedSettings,
  syncedState,
  type ClaudeSync,
  type ClaudeSyncInput,
} from "./claude-sync";
import { SkillService } from "../services/skills";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "../config";

let root: string;
let claudeHome: string;
let outside: string;

const put = async (path: string, text: string | Uint8Array) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

const input = (extra: Partial<ClaudeSyncInput> = {}): ClaudeSyncInput => ({
  claudeHome,
  macHome: "/Users/someone",
  daedalusSkills: [],
  ...extra,
});

/** A sync with only these parts, as the settings merges read it. */
const syncOf = (extra: Partial<ClaudeSync>): ClaudeSync => ({
  items: [],
  overCap: [],
  plugins: {},
  marketplaces: {},
  mcpServers: {},
  mcpLeftOut: [],
  hooksLeftOut: 0,
  ...extra,
});

const paths = async (extra: Partial<ClaudeSyncInput> = {}) =>
  (await collectClaudeSync(input(extra))).items.flatMap((item) =>
    item.files.map((file) => file.path),
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-sync-"));
  claudeHome = join(root, "claude");
  outside = join(root, "outside");
  await mkdir(claudeHome, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("what is copied", () => {
  test("skills, commands, agents, styles and CLAUDE.md, under the pod's Claude folder", async () => {
    await put(join(claudeHome, "CLAUDE.md"), "be brief");
    await put(
      join(claudeHome, "skills/review/SKILL.md"),
      "---\nname: review\n---\n",
    );
    await put(join(claudeHome, "skills/review/scripts/run.sh"), "echo hi");
    await put(join(claudeHome, "commands/commit-msg.md"), "write it");
    await put(join(claudeHome, "commands/git/push.md"), "push it");
    await put(join(claudeHome, "agents/reviewer.md"), "review");
    await put(join(claudeHome, "output-styles/Terse.md"), "terse");
    // Not a skill: no SKILL.md.
    await put(join(claudeHome, "skills/synced/abc/SKILL.md"), "nested");
    // Claude's own state, never copied.
    await put(join(claudeHome, "history.jsonl"), "{}");
    await put(join(claudeHome, "projects/x/session.jsonl"), "{}");
    expect((await paths()).sort()).toEqual([
      ".home/.claude/CLAUDE.md",
      ".home/.claude/agents/reviewer.md",
      ".home/.claude/commands/commit-msg.md",
      ".home/.claude/commands/git/push.md",
      ".home/.claude/output-styles/Terse.md",
      ".home/.claude/skills/review/SKILL.md",
      ".home/.claude/skills/review/scripts/run.sh",
    ]);
  });

  test("a script keeps its executable bit", async () => {
    await put(join(claudeHome, "skills/review/SKILL.md"), "skill");
    await put(join(claudeHome, "skills/review/run.sh"), "echo hi");
    await Bun.$`chmod 755 ${join(claudeHome, "skills/review/run.sh")}`;
    const sync = await collectClaudeSync(input());
    const plan = planSync(sync, parseManifest(undefined));
    expect(plan.executable).toEqual([".home/.claude/skills/review/run.sh"]);
  });

  test("a text file that names a Mac path is copied and named in the log", async () => {
    await put(
      join(claudeHome, "skills/local/SKILL.md"),
      "run /Users/someone/bin/tool",
    );
    const sync = await collectClaudeSync(input());
    expect(
      sync.items.find((item) => item.label === "skills/local")?.macPaths,
    ).toBe(true);
  });
});

describe("secrets", () => {
  test("credentials and env files are never copied, wherever they sit", async () => {
    await put(join(claudeHome, ".credentials.json"), '{"token":"secret"}');
    await put(join(claudeHome, "skills/s/SKILL.md"), "skill");
    await put(join(claudeHome, "skills/s/.env"), "KEY=secret");
    await put(join(claudeHome, "skills/s/.credentials.json"), "secret");
    await put(join(claudeHome, "skills/s/server.pem"), "secret");
    const sync = await collectClaudeSync(input());
    const all = sync.items.flatMap((item) =>
      item.files.map((file) => file.path),
    );
    expect(all).toEqual([".home/.claude/skills/s/SKILL.md"]);
    expect(
      sync.items.flatMap((item) => item.skipped.map((skip) => skip.reason)),
    ).toEqual(["may hold a secret", "may hold a secret", "may hold a secret"]);
    for (const item of sync.items)
      for (const file of item.files)
        expect(Buffer.from(file.bytes).toString()).not.toContain("secret");
  });

  test("only remote MCP servers with nothing beside an https URL are carried", () => {
    const { servers, leftOut } = remoteMcpServers(
      JSON.stringify({
        mcpServers: {
          docs: { type: "http", url: "https://mcp.example.com/mcp" },
          events: { type: "sse", url: "https://sse.example.com/" },
          headers: {
            type: "http",
            url: "https://api.example.com",
            headers: { Authorization: "Bearer secret" },
          },
          helper: {
            type: "http",
            url: "https://api.example.com",
            headersHelper: "/Users/someone/token.sh",
          },
          env: {
            type: "http",
            url: "https://api.example.com",
            env: { K: "v" },
          },
          oauth: {
            type: "http",
            url: "https://api.example.com",
            oauth: { clientId: "x" },
          },
          query: { type: "http", url: "https://api.example.com/?token=secret" },
          user: { type: "http", url: "https://me:secret@api.example.com/" },
          plain: { type: "http", url: "http://api.example.com/" },
          local: { command: "docker", args: ["run"] },
          stdio: { type: "stdio", command: "npx", env: { TOKEN: "secret" } },
        },
      }),
    );
    expect(servers).toEqual({
      docs: { type: "http", url: "https://mcp.example.com/mcp" },
      events: { type: "sse", url: "https://sse.example.com/" },
    });
    expect(
      Object.fromEntries(leftOut.map((one) => [one.name, one.reason])),
    ).toEqual({
      env: "has env, which may hold a secret",
      headers: "has headers, which may hold a secret",
      helper: "has headersHelper, which may hold a secret",
      local: "a local command",
      oauth: "has oauth, which may hold a secret",
      plain: "not an https URL",
      query: "a user name or query string in its URL, which may hold a secret",
      stdio: "a local command",
      user: "a user name or query string in its URL, which may hold a secret",
    });
    expect(JSON.stringify(servers)).not.toContain("secret");
  });

  test("the pod's settings get no env, permissions, status line or key helper", () => {
    const text = syncedSettings(
      JSON.stringify({ theme: "dark" }),
      syncOf({
        plugins: { "a@m": { scope: "user", installPath: "/workspace/x" } },
        outputStyle: "Terse",
      }),
      parseManifest(undefined),
    )!;
    expect(JSON.parse(text)).toEqual({
      theme: "dark",
      enabledPlugins: { "a@m": true },
      outputStyle: "Terse",
    });
  });

  test("hooks that name a Mac path are left out", () => {
    const { hooks, leftOut } = podHooks(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "/Users/someone/hook.sh" },
                { type: "command", command: "echo ok" },
                { type: "command", command: "~/bin/check" },
                { type: "command", command: "bash $HOME/x.sh" },
              ],
            },
          ],
          Stop: [
            {
              hooks: [{ type: "command", command: "/opt/homebrew/bin/notify" }],
            },
          ],
        },
      }),
    );
    expect(hooks).toEqual({
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo ok" }] },
      ],
    });
    expect(leftOut).toBe(4);
  });
});

describe("links", () => {
  test("a link out of ~/.claude is not followed", async () => {
    await put(join(outside, "secret.txt"), "secret");
    await put(join(outside, "skill/SKILL.md"), "elsewhere");
    await mkdir(join(claudeHome, "skills/mine"), { recursive: true });
    await put(join(claudeHome, "skills/mine/SKILL.md"), "mine");
    await symlink(
      join(outside, "secret.txt"),
      join(claudeHome, "skills/mine/notes.txt"),
    );
    await symlink(join(outside, "skill"), join(claudeHome, "skills/linked"));
    await mkdir(join(claudeHome, "commands"), { recursive: true });
    await symlink(
      join(outside, "secret.txt"),
      join(claudeHome, "commands/x.md"),
    );
    await symlink(outside, join(claudeHome, "skills/mine/up"));
    const sync = await collectClaudeSync(input());
    expect(
      sync.items.flatMap((item) => item.files.map((file) => file.path)),
    ).toEqual([".home/.claude/skills/mine/SKILL.md"]);
    expect(
      sync.items
        .flatMap((item) => item.skipped)
        .map((skip) => skip.path)
        .sort(),
    ).toEqual([
      "commands/x.md",
      "skills/linked",
      "skills/mine/notes.txt",
      "skills/mine/up",
    ]);
    for (const item of sync.items)
      for (const file of item.files)
        expect(Buffer.from(file.bytes).toString()).not.toContain("secret");
  });

  test("a link inside ~/.claude is copied as the file it names", async () => {
    await put(join(claudeHome, "skills/a/SKILL.md"), "a");
    await put(join(claudeHome, "skills/a/CLAUDE.md"), "notes");
    await symlink("CLAUDE.md", join(claudeHome, "skills/a/AGENTS.md"));
    await symlink(join(claudeHome, "skills/a"), join(claudeHome, "skills/b"));
    expect((await paths()).sort()).toEqual([
      ".home/.claude/skills/a/AGENTS.md",
      ".home/.claude/skills/a/CLAUDE.md",
      ".home/.claude/skills/a/SKILL.md",
      ".home/.claude/skills/b/AGENTS.md",
      ".home/.claude/skills/b/CLAUDE.md",
      ".home/.claude/skills/b/SKILL.md",
    ]);
  });

  test("a plugin whose folder sits behind a link out of ~/.claude is not copied", async () => {
    await put(join(outside, "1.0.0/commands/x.md"), "secret");
    await mkdir(join(claudeHome, "plugins/cache/market"), { recursive: true });
    await symlink(outside, join(claudeHome, "plugins/cache/market/tool"));
    const path = join(claudeHome, "plugins/cache/market/tool/1.0.0");
    await put(
      join(claudeHome, "plugins/installed_plugins.json"),
      JSON.stringify({
        plugins: { "tool@market": [{ scope: "user", installPath: path }] },
      }),
    );
    await put(
      join(claudeHome, "plugins/known_marketplaces.json"),
      JSON.stringify({
        market: {
          source: { source: "github", repo: "e/m" },
          installLocation: "x",
        },
      }),
    );
    const sync = await collectClaudeSync(
      input({
        settingsText: JSON.stringify({
          enabledPlugins: { "tool@market": true },
        }),
      }),
    );
    expect(sync.items.flatMap((item) => item.files)).toEqual([]);
    expect(sync.plugins).toEqual({});
    expect(sync.items.flatMap((item) => item.skipped)).toContainEqual({
      path: "plugins/cache/market/tool/1.0.0",
      reason: "a link out of ~/.claude",
    });
  });

  test("a link loop ends", async () => {
    await put(join(claudeHome, "skills/a/SKILL.md"), "a");
    await symlink(
      join(claudeHome, "skills/a"),
      join(claudeHome, "skills/a/again"),
    );
    expect(await paths()).toEqual([".home/.claude/skills/a/SKILL.md"]);
  });
});

describe("plugins", () => {
  const install = async () => {
    const path = join(claudeHome, "plugins/cache/market/tool/1.0.0");
    await put(join(path, ".claude-plugin/plugin.json"), '{"name":"tool"}');
    await put(join(path, "skills/t/SKILL.md"), "t");
    await put(join(path, "node_modules/x/index.js"), "x");
    await put(join(path, ".git/HEAD"), "ref");
    const off = join(claudeHome, "plugins/cache/market/off/1.0.0");
    await put(join(off, "README.md"), "off");
    await put(
      join(claudeHome, "plugins/installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "tool@market": [
            { scope: "user", installPath: path, version: "1.0.0" },
          ],
          "off@market": [{ scope: "user", installPath: off, version: "1.0.0" }],
          "away@market": [{ scope: "user", installPath: outside }],
          "secret@keyed": [{ scope: "user", installPath: path }],
          "lost@nowhere": [{ scope: "user", installPath: path }],
        },
      }),
    );
    await put(join(claudeHome, "plugins/data/tool/state.json"), "{}");
    await put(
      join(
        claudeHome,
        "plugins/marketplaces/market/.claude-plugin/marketplace.json",
      ),
      '{"name":"market"}',
    );
    await put(
      join(claudeHome, "plugins/marketplaces/market/plugins/tool/README.md"),
      "the marketplace's clone stays on the Mac",
    );
    await put(
      join(claudeHome, "plugins/known_marketplaces.json"),
      JSON.stringify({
        market: {
          source: { source: "github", repo: "example/market" },
          installLocation: join(claudeHome, "plugins/marketplaces/market"),
          lastUpdated: "2026-10-01T00:00:00.000Z",
        },
        keyed: {
          source: {
            source: "git",
            url: "https://me:token@git.example.com/m.git",
          },
          installLocation: join(claudeHome, "plugins/marketplaces/keyed"),
        },
      }),
    );
    return JSON.stringify({
      enabledPlugins: {
        "tool@market": true,
        "off@market": false,
        "away@market": true,
        "secret@keyed": true,
        "lost@nowhere": true,
      },
    });
  };

  test("enabled plugins are copied without node_modules or .git, their install paths moved to the pod", async () => {
    const settingsText = await install();
    const sync = await collectClaudeSync(input({ settingsText }));
    expect(
      sync.items.flatMap((item) => item.files.map((file) => file.path)).sort(),
    ).toEqual([
      ".home/.claude/plugins/cache/market/tool/1.0.0/.claude-plugin/plugin.json",
      ".home/.claude/plugins/cache/market/tool/1.0.0/skills/t/SKILL.md",
      ".home/.claude/plugins/marketplaces/market/.claude-plugin/marketplace.json",
    ]);
    expect(sync.marketplaces).toEqual({
      market: {
        source: { source: "github", repo: "example/market" },
        installLocation: "/workspace/.home/.claude/plugins/marketplaces/market",
        lastUpdated: "2026-10-01T00:00:00.000Z",
      },
    });
    expect(sync.plugins).toEqual({
      "tool@market": {
        scope: "user",
        installPath: "/workspace/.home/.claude/plugins/cache/market/tool/1.0.0",
        version: "1.0.0",
      },
    });
    expect(
      sync.items.flatMap((item) => item.skipped.map((skip) => skip.reason)),
    ).toEqual([
      "installed outside ~/.claude/plugins/cache",
      "its marketplace is not known, or its address may hold a secret",
      "its marketplace is not known, or its address may hold a secret",
    ]);
    const pod = JSON.parse(seedInstalledPlugins(undefined, sync.plugins, [])!);
    expect(pod.plugins["tool@market"][0].installPath).toBe(
      "/workspace/.home/.claude/plugins/cache/market/tool/1.0.0",
    );
  });

  test("a cap leaves out a whole plugin, never part of one", async () => {
    const settingsText = await install();
    await put(
      join(claudeHome, "plugins/cache/market/tool/1.0.0/big.bin"),
      new Uint8Array(SYNC_LIMITS.fileBytes + 1),
    );
    await put(join(claudeHome, "skills/s/SKILL.md"), "s");
    const sync = await collectClaudeSync(input({ settingsText }));
    expect(
      sync.items.flatMap((item) => item.files.map((file) => file.path)),
    ).toEqual([".home/.claude/skills/s/SKILL.md"]);
    expect(sync.plugins).toEqual({});
    expect(sync.overCap).toEqual([
      "plugin tool@market (plugins/cache/market/tool/1.0.0/big.bin is over 1 MiB)",
    ]);
  });

  test("past the total cap, later items are left out whole", async () => {
    const chunk = new Uint8Array(SYNC_LIMITS.fileBytes - 1);
    for (let index = 0; index < 20; index++) {
      const name = `s${String(index).padStart(2, "0")}`;
      await put(join(claudeHome, `skills/${name}/SKILL.md`), name);
      await put(join(claudeHome, `skills/${name}/data.bin`), chunk);
    }
    const sync = await collectClaudeSync(input());
    const kept = sync.items.filter((item) => item.files.length);
    for (const item of kept) expect(item.files.length).toBe(2);
    // Each is just over 1 MiB with its SKILL.md, so 15 fit in 16 MiB.
    expect(kept.length).toBe(15);
    expect(sync.overCap.length).toBe(5);
  });
});

describe("only what changed", () => {
  test("a second launch writes nothing, and a file removed on the Mac is removed in the pod", async () => {
    await put(join(claudeHome, "skills/a/SKILL.md"), "a");
    await put(join(claudeHome, "commands/c.md"), "c");
    const first = planSync(
      await collectClaudeSync(input()),
      parseManifest(undefined),
    );
    expect(first.writes.map((file) => file.path)).toEqual([
      ".home/.claude/commands/c.md",
      ".home/.claude/skills/a/SKILL.md",
      SYNC_MANIFEST_PATH,
    ]);
    const manifest = parseManifest(
      Buffer.from(first.writes.at(-1)!.bytes).toString(),
    );
    const second = planSync(await collectClaudeSync(input()), manifest);
    expect(second.writes).toEqual([]);
    expect(second.unchanged).toBe(2);

    await rm(join(claudeHome, "commands/c.md"));
    await put(join(claudeHome, "skills/a/SKILL.md"), "a, changed");
    const third = planSync(await collectClaudeSync(input()), manifest);
    expect(third.writes.map((file) => file.path)).toEqual([
      ".home/.claude/skills/a/SKILL.md",
      SYNC_MANIFEST_PATH,
    ]);
    expect(third.removed).toEqual([".home/.claude/commands/c.md"]);
  });

  test("a manifest from the pod cannot name paths outside the synced folder", () => {
    const manifest = parseManifest(
      JSON.stringify({
        files: {
          ".home/.claude/skills/a/SKILL.md": "x",
          ".home/.claude/../../etc/passwd": "x",
          "src/main.ts": "x",
          ".home/.claude//skills": "x",
          [SYNC_MANIFEST_PATH]: "x",
        },
        plugins: ["a@m", 3],
      }),
    );
    expect(Object.keys(manifest.files)).toEqual([
      ".home/.claude/skills/a/SKILL.md",
    ]);
    expect(manifest.plugins).toEqual(["a@m"]);
  });

  test("plugins and MCP servers the Mac stopped carrying leave the pod; the pod's own stay", () => {
    const previous = {
      ...parseManifest(undefined),
      plugins: ["old@m"],
      mcpServers: ["old"],
    };
    const settings = syncedSettings(
      JSON.stringify({
        theme: "light",
        enabledPlugins: { "old@m": true, "pods@m": true },
      }),
      syncOf({
        plugins: { "new@m": { scope: "user", installPath: "/workspace/x" } },
      }),
      previous,
    )!;
    expect(JSON.parse(settings).enabledPlugins).toEqual({
      "pods@m": true,
      "new@m": true,
    });
    const state = syncedState(
      JSON.stringify({
        hasCompletedOnboarding: true,
        mcpServers: {
          old: { type: "http", url: "https://o" },
          mine: { command: "x" },
        },
      }),
      syncOf({ mcpServers: { docs: { type: "http", url: "https://d/" } } }),
      previous,
    )!;
    expect(JSON.parse(state).mcpServers).toEqual({
      mine: { command: "x" },
      docs: { type: "http", url: "https://d/" },
    });
  });
});

describe("Daedalus skills in a pod", () => {
  test("only the skills whose commands a pod may run, calling the pod's daedal", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      const skills = new SkillService(config).cloudSkills("daedal");
      // Names carry the channel suffix, as on this Mac.
      const base = (name: string) =>
        ["daedalus-refinement", "daedalus-team", "unslop"].find((id) =>
          name.startsWith(id),
        );
      expect(skills.map((skill) => base(skill.name)).sort()).toEqual([
        "daedalus-refinement",
        "daedalus-team",
        "unslop",
      ]);
      const team = skills.find((skill) =>
        skill.name.startsWith("daedalus-team"),
      )!;
      const text = team.files.find(
        (file) => file.path === "SKILL.md",
      )!.contents;
      expect(text).toContain('Use `"daedal"` for every command');
      expect(text).not.toContain(home);
      expect(text).not.toContain("{{daedal}}");
    });
  });
});

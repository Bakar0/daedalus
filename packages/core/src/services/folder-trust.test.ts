import {
  lstat,
  mkdir,
  readlink,
  realpath,
  rm,
  rmdir,
  symlink,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "../config";
import {
  claudeStatePath,
  forgetClaudeFolders,
  forgetCodexFolders,
  forgetSessionFolders,
  trustClaudeFolder,
  trustCodexFolder,
  waitForExits,
} from "./folder-trust";

type State = {
  projects?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

const readState = async (path: string) =>
  (await Bun.file(path).json()) as State;

/**
 * A stand-in for a running Claude session: saves `.claude.json` `count`
 * times the way Claude does, re-reading it under the `.claude.json.lock`
 * directory and bumping a counter on its own project.
 */
const CLAUDE_LIKE_WRITER = `
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
const [path, key, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
  for (;;) {
    try { mkdirSync(path + ".lock"); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; Bun.sleepSync(1); }
  }
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.projects ??= {};
    state.projects[key] = { saves: (state.projects[key]?.saves ?? 0) + 1 };
    writeFileSync(path + ".writer", JSON.stringify(state));
    renameSync(path + ".writer", path);
  } finally {
    rmdirSync(path + ".lock");
  }
}
`;

const USER_CODEX_CONFIG = `model = "gpt-5"

[projects."/Users/me/code"]
trust_level = "trusted"

[mcp_servers.docs]
command = "docs"
`;

describe("folder trust", () => {
  test("adds a Codex trust table and keeps the rest of the file", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const path = join(home, "config.toml");
      await Bun.write(path, USER_CODEX_CONFIG);
      await trustCodexFolder(path, "/w/worktrees/a");
      await trustCodexFolder(path, "/w/worktrees/a");
      const text = await Bun.file(path).text();
      expect(text.startsWith(USER_CODEX_CONFIG)).toBe(true);
      expect(text.match(/\[projects\."\/w\/worktrees\/a"\]/g)).toHaveLength(1);
      const parsed = Bun.TOML.parse(text) as {
        model: string;
        projects: Record<string, { trust_level: string }>;
      };
      expect(parsed.model).toBe("gpt-5");
      expect(parsed.projects["/w/worktrees/a"]?.trust_level).toBe("trusted");
    });
  });

  test("leaves a folder the user marked untrusted alone", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const path = join(home, "config.toml");
      const own = `[projects."/w/a"]\ntrust_level = "untrusted"\n`;
      await Bun.write(path, own);
      await trustCodexFolder(path, "/w/a");
      expect(await Bun.file(path).text()).toBe(own);
    });
  });

  test("creates a Codex config that does not exist yet", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const path = join(home, "fresh", "config.toml");
      await trustCodexFolder(path, "/w/a");
      expect(await Bun.file(path).text()).toBe(
        `[projects."/w/a"]\ntrust_level = "trusted"\n`,
      );
    });
  });

  test("forgets Codex tables at or inside a folder and nothing else", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const path = join(home, "config.toml");
      await Bun.write(path, USER_CODEX_CONFIG);
      await trustCodexFolder(path, "/w/worktrees/a");
      await trustCodexFolder(path, "/w/worktrees/ab");
      await trustCodexFolder(path, "/w");
      await forgetCodexFolders(path, ["/w/worktrees/a"]);
      const parsed = Bun.TOML.parse(await Bun.file(path).text()) as {
        projects: Record<string, unknown>;
        mcp_servers: Record<string, unknown>;
      };
      expect(Object.keys(parsed.projects).sort()).toEqual([
        "/Users/me/code",
        "/w",
        "/w/worktrees/ab",
      ]);
      expect(parsed.mcp_servers.docs).toBeTruthy();
      await forgetCodexFolders(path, ["/w"]);
      expect(await Bun.file(path).text()).toBe(USER_CODEX_CONFIG);
    });
  });

  test("sets Claude's flags on the folder and keeps every other key", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const path = join(home, ".claude.json");
      await Bun.write(
        path,
        JSON.stringify({
          numStartups: 4,
          projects: {
            "/w/a": { allowedTools: ["Bash"] },
            "/other": { hasTrustDialogAccepted: true },
          },
        }),
      );
      await trustClaudeFolder(path, "/w/a");
      await trustClaudeFolder(path, "/w/b");
      const state = (await Bun.file(path).json()) as {
        numStartups: number;
        projects: Record<string, Record<string, unknown>>;
      };
      expect(state.numStartups).toBe(4);
      expect(state.projects["/w/a"]).toEqual({
        allowedTools: ["Bash"],
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
      });
      expect(state.projects["/w/b"]?.hasTrustDialogAccepted).toBe(true);
      await forgetClaudeFolders(path, ["/w"]);
      expect(
        Object.keys(((await Bun.file(path).json()) as typeof state).projects),
      ).toEqual(["/other"]);
    });
  });

  test("waits for Claude's lock, and takes over one its holder left behind", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const path = join(home, ".claude.json");
      await Bun.write(path, JSON.stringify({ projects: {} }));
      await mkdir(`${path}.lock`);
      let released = false;
      setTimeout(() => {
        released = true;
        void rmdir(`${path}.lock`);
      }, 150);
      await trustClaudeFolder(path, "/w/a");
      expect(released).toBe(true);
      expect((await readState(path)).projects?.["/w/a"]).toBeDefined();

      // Twenty seconds old: its holder stopped refreshing it long ago.
      await mkdir(`${path}.lock`);
      const old = new Date(Date.now() - 20_000);
      await utimes(`${path}.lock`, old, old);
      await trustClaudeFolder(path, "/w/b");
      expect((await readState(path)).projects?.["/w/b"]).toBeDefined();
      expect(await lstat(`${path}.lock`).catch(() => null)).toBeNull();
    });
  });

  test("writes through a .claude.json kept as a link", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const real = join(home, "dotfiles", "claude.json");
      const link = join(home, ".claude.json");
      await Bun.write(real, JSON.stringify({ theme: "dark" }));
      await symlink(real, link);
      await trustClaudeFolder(link, "/w/a");
      expect(await readlink(link)).toBe(real);
      expect((await readState(real)).projects?.["/w/a"]).toBeDefined();
      expect((await readState(real)).theme).toBe("dark");
    });
  });

  test("forgetting while a session keeps saving loses neither side's writes", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({
        DAEDALUS_HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "claude"),
      });
      const path = claudeStatePath(config);
      const root = join(home, "workspaces", "gone");
      await Bun.write(path, JSON.stringify({ numStartups: 1, projects: {} }));
      const script = join(home, "writer.ts");
      await Bun.write(script, CLAUDE_LIKE_WRITER);
      const saves = 300;
      const writer = Bun.spawn(
        [process.execPath, script, path, "/elsewhere/live", String(saves)],
        { stderr: "pipe" },
      );
      let rounds = 0;
      while (writer.exitCode === null) {
        await trustClaudeFolder(path, join(root, `s${rounds}`));
        await forgetClaudeFolders(path, [root]);
        rounds += 1;
      }
      expect(await writer.exited).toBe(0);
      expect(rounds).toBeGreaterThan(0);
      await trustClaudeFolder(path, join(root, "last"));
      await forgetSessionFolders(config, root);
      const state = await readState(path);
      expect(state.numStartups).toBe(1);
      expect(state.projects).toEqual({ "/elsewhere/live": { saves } });
    });
  });

  test("forgets a folder that is already gone, by the path Claude recorded", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({
        DAEDALUS_HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "claude"),
      });
      const path = claudeStatePath(config);
      // The temporary folder is under /var, which Claude records as
      // /private/var.
      const folder = join(home, "workspaces", "w", "worktrees", "s");
      await mkdir(folder, { recursive: true });
      await trustClaudeFolder(path, await realpath(folder));
      await rm(folder, { recursive: true });
      await forgetSessionFolders(config, folder);
      expect((await readState(path)).projects).toEqual({});
    });
  });

  test("waits for a stopped session's Claude to finish exiting", async () => {
    // Claude deletes its sessions/<pid>.json first and saves `.claude.json`
    // about a second later, so only the process itself says it is done.
    let scans = 0;
    const list = async () => {
      scans += 1;
      return new Map([
        [101, "/w/other"],
        ...(scans < 3 ? ([[202, "/w/gone/worktrees/a"]] as const) : []),
      ]);
    };
    await waitForExits(["/w/gone"], { list });
    expect(scans).toBe(3);
    // One that never exits is waited for no longer than the limit, and a
    // system that cannot say is not waited for at all.
    const started = Date.now();
    await waitForExits(["/w/other"], { list, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_000);
    await waitForExits(["/w/other"], { list: async () => undefined });
  });
});

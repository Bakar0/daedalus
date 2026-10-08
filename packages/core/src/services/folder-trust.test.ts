import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  forgetClaudeFolders,
  forgetCodexFolders,
  trustClaudeFolder,
  trustCodexFolder,
} from "./folder-trust";

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
});

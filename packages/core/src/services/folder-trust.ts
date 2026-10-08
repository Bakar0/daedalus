import { homedir } from "node:os";
import { realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { ensureDirectory } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import { accountConfig } from "./account-homes";
import { codexConfigPath } from "./providers";

/**
 * Trust for the folders Daedalus creates, recorded in each provider's own
 * configuration before the provider starts, so it never stops on a trust
 * prompt there.
 *
 * Both providers key the decision on the exact folder. Codex ignores a
 * trusted parent entirely. Claude does honor a trusted parent for its folder
 * trust, but asks separately, and again per folder, before it loads a
 * `CLAUDE.md` import from outside the session folder, which the workspace's
 * `@AGENTS.md` always is. So one entry per session folder is what both need,
 * and it is the same entry the provider writes itself when the user answers
 * the prompt.
 *
 * Every write is best effort. A configuration Daedalus cannot read or write
 * is the user's to own: the provider then asks, and startup hands that
 * question to the user.
 */

/**
 * Claude's global state file. It sits beside `~/.claude`, not inside it,
 * unless `CLAUDE_CONFIG_DIR` moved the folder, which takes the file with it.
 */
export function claudeStatePath(config: DaedalusConfig): string {
  return resolve(config.claudeHome) === resolve(homedir(), ".claude")
    ? join(homedir(), ".claude.json")
    : join(config.claudeHome, ".claude.json");
}

/**
 * The flags Claude sets on a project once the user accepted its startup
 * prompts: folder trust, and loading `CLAUDE.md` imports from outside it.
 */
const CLAUDE_TRUST_FLAGS = {
  hasTrustDialogAccepted: true,
  hasClaudeMdExternalIncludesApproved: true,
  hasClaudeMdExternalIncludesWarningShown: true,
} as const;

/** Writes the provider's trust record for one session folder. */
export async function trustSessionFolder(
  config: DaedalusConfig,
  provider: string,
  folder: string,
): Promise<void> {
  if (provider !== "codex" && provider !== "claude") return;
  try {
    // Both providers record the canonical path, `/private/tmp` rather than
    // `/tmp`, so a key written under the link would never be looked up.
    const path = await realpath(folder);
    if (provider === "codex")
      await trustCodexFolder(codexConfigPath(config), path);
    else await trustClaudeFolder(claudeStatePath(config), path);
  } catch {
    // See the module note: the provider asks instead.
  }
}

/**
 * Drops the trust records for `folder` and every folder inside it, from the
 * default account and every profile. Called when Daedalus deletes the folder,
 * so the providers' files do not keep one entry per session for ever.
 */
export async function forgetSessionFolders(
  config: DaedalusConfig,
  folder: string,
): Promise<void> {
  // The folder may already be gone, and both spellings may have been stored.
  const roots = [
    ...new Set([
      resolve(folder),
      await realpath(folder).catch(() => resolve(folder)),
    ]),
  ];
  const configs = [
    config,
    ...config.accounts.map((account) =>
      accountConfig(config, account.provider, account.id),
    ),
  ];
  const codexFiles = new Set(configs.map((entry) => codexConfigPath(entry)));
  const claudeFiles = new Set(configs.map((entry) => claudeStatePath(entry)));
  for (const file of codexFiles)
    await forgetCodexFolders(file, roots).catch(() => undefined);
  for (const file of claudeFiles)
    await forgetClaudeFolders(file, roots).catch(() => undefined);
}

const isAtOrInside = (roots: readonly string[], path: string): boolean =>
  roots.some((root) => path === root || path.startsWith(`${root}${sep}`));

/**
 * Codex writes `config.toml` too, and Claude rewrites `.claude.json` all the
 * time, so a reader must never see half a file.
 */
async function replaceFile(path: string, text: string): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

const readText = async (path: string): Promise<string | undefined> => {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
};

type CodexProjects = Record<string, { trust_level?: unknown } | undefined>;

const codexProjects = (text: string): CodexProjects => {
  const parsed = Bun.TOML.parse(text) as { projects?: unknown };
  return parsed.projects && typeof parsed.projects === "object"
    ? (parsed.projects as CodexProjects)
    : {};
};

/**
 * Appends `[projects."<folder>"]` with `trust_level = "trusted"`, the table
 * Codex writes itself for "Trust and continue". A folder that already has a
 * table is left alone, whatever it says: an `untrusted` there is the user's
 * answer, and adding a second table for the same key would make the file
 * invalid.
 */
export async function trustCodexFolder(
  configPath: string,
  folder: string,
): Promise<void> {
  const existing = (await readText(configPath)) ?? "";
  if (codexProjects(existing)[folder]) return;
  const separator =
    existing === "" || existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
  const merged = `${existing}${separator}[projects.${JSON.stringify(folder)}]\ntrust_level = "trusted"\n`;
  // A file that holds `projects` in some other shape, an inline table say,
  // cannot take a new table header. Checking the result catches that and
  // anything else this simple append did not foresee.
  if (codexProjects(merged)[folder]?.trust_level !== "trusted") return;
  await replaceFile(configPath, merged);
}

const CODEX_PROJECT_HEADER =
  /^\s*\[\s*projects\s*\.\s*("(?:[^"\\]|\\.)*")\s*\]\s*(?:#.*)?$/;

/**
 * Removes each `[projects."<path>"]` table at or inside `roots`, up to the
 * next table header. Only the quoted form Codex writes is recognised; any
 * other spelling of a key stays, which costs one stale entry and nothing else.
 */
export async function forgetCodexFolders(
  configPath: string,
  roots: readonly string[],
): Promise<void> {
  const existing = await readText(configPath);
  if (!existing) return;
  const lines = existing.split("\n");
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      const match = CODEX_PROJECT_HEADER.exec(line);
      let key: string | undefined;
      try {
        key = match ? (JSON.parse(match[1]!) as string) : undefined;
      } catch {
        key = undefined;
      }
      dropping = key !== undefined && isAtOrInside(roots, key);
    }
    if (!dropping) kept.push(line);
  }
  const merged = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  if (merged === existing) return;
  // Never write a file Codex could no longer read.
  Bun.TOML.parse(merged);
  await replaceFile(configPath, merged);
}

type ClaudeState = { projects?: Record<string, Record<string, unknown>> };

/**
 * Sets Claude's trust flags on the folder's project entry, creating it if
 * needed. Every other key in the file, and in the entry, is kept as it was.
 */
export async function trustClaudeFolder(
  statePath: string,
  folder: string,
): Promise<void> {
  const text = await readText(statePath);
  const state = (text ? JSON.parse(text) : {}) as ClaudeState;
  if (!state || typeof state !== "object" || Array.isArray(state)) return;
  const projects = state.projects ?? {};
  const entry = projects[folder] ?? {};
  if (
    Object.entries(CLAUDE_TRUST_FLAGS).every(
      ([key, value]) => entry[key] === value,
    )
  )
    return;
  state.projects = {
    ...projects,
    [folder]: { ...entry, ...CLAUDE_TRUST_FLAGS },
  };
  await replaceFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export async function forgetClaudeFolders(
  statePath: string,
  roots: readonly string[],
): Promise<void> {
  const text = await readText(statePath);
  if (!text) return;
  const state = JSON.parse(text) as ClaudeState;
  const projects = state?.projects;
  if (!projects || typeof projects !== "object") return;
  const stale = Object.keys(projects).filter((path) =>
    isAtOrInside(roots, path),
  );
  if (stale.length === 0) return;
  for (const path of stale) delete projects[path];
  await replaceFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

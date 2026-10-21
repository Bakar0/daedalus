import { homedir } from "node:os";
import { mkdir, realpath, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  ensureDirectory,
  processWorkingDirectories,
  writeFileAtomic,
} from "@daedalus/platform";
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
  // Both spellings may have been stored, and the folder may already be gone.
  const roots = [...new Set([resolve(folder), await canonicalPath(folder)])];
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
  // Only an entry that is there can be put back by a Claude on its way out,
  // and asking the system which processes work where costs a few tenths of
  // a second.
  const recorded = await Promise.all(
    [...claudeFiles].map((file) => holdsFolders(file, roots)),
  );
  if (recorded.some(Boolean)) await waitForExits(roots);
  for (const file of claudeFiles)
    await forgetClaudeFolders(file, roots).catch(() => undefined);
}

/** Whether a `.claude.json` has a project at or inside `roots`. */
async function holdsFolders(
  statePath: string,
  roots: readonly string[],
): Promise<boolean> {
  try {
    const state = (await Bun.file(statePath).json()) as {
      projects?: Record<string, unknown>;
    };
    return Object.keys(state.projects ?? {}).some((path) =>
      isAtOrInside(roots, path),
    );
  } catch {
    return false;
  }
}

/**
 * The path the providers record for `folder`: `/private/var/...` for a
 * `/var/...` one. A folder that is gone has no real path of its own, so the
 * deepest one above it that still exists stands in for it.
 */
async function canonicalPath(folder: string): Promise<string> {
  const path = resolve(folder);
  const real = await realpath(path).catch(() => undefined);
  if (real) return real;
  const parent = dirname(path);
  return parent === path
    ? path
    : join(await canonicalPath(parent), basename(path));
}

const EXIT_WAIT_MS = 10_000;
const EXIT_POLL_MS = 200;

/**
 * Waits, for a while, until no process works at or inside `roots`.
 *
 * Stopping a session closes its terminal, and Claude then saves the
 * session's last figures to its project in `.claude.json` on its way out,
 * about a second later, which would put back an entry dropped in the
 * meantime. Its `sessions/<pid>.json` is no help: Claude deletes that first.
 * So this asks the system which processes still work in those folders. It
 * goes by folder, not by name, because Claude's process is `claude` from
 * Homebrew, `node` from npm and its version number from the native
 * installer. One still running after the wait is left to run, and so is
 * everything when the system cannot say.
 */
export async function waitForExits(
  roots: readonly string[],
  options: {
    timeoutMs?: number;
    list?: () => Promise<Map<number, string> | undefined>;
  } = {},
): Promise<void> {
  const list = options.list ?? (() => processWorkingDirectories());
  const deadline = Date.now() + (options.timeoutMs ?? EXIT_WAIT_MS);
  for (;;) {
    const folders = await list();
    if (!folders) return;
    const running = [...folders].some(
      ([pid, cwd]) => pid !== process.pid && isAtOrInside(roots, cwd),
    );
    if (!running || Date.now() >= deadline) return;
    await Bun.sleep(EXIT_POLL_MS);
  }
}

const isAtOrInside = (roots: readonly string[], path: string): boolean =>
  roots.some((root) => path === root || path.startsWith(`${root}${sep}`));

/**
 * Codex writes `config.toml` too, and Claude rewrites `.claude.json` all the
 * time, so a reader must never see half a file.
 */
async function replaceFile(path: string, text: string): Promise<void> {
  await writeFileAtomic(path, text, { mode: 0o600, ensureDir: true });
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

/**
 * Claude's own lock on `.claude.json`: a `.claude.json.lock` directory, made
 * with `mkdir` by proper-lockfile, whose mtime the holder refreshes every 5
 * seconds and which anyone may take over once it is 10 seconds old. Claude
 * re-reads the file under that lock before every save, so a write made while
 * holding it is never undone by a session that read the file earlier.
 */
const CLAUDE_LOCK_STALE_MS = 10_000;
const CLAUDE_LOCK_WAIT_MS = 5_000;
const CLAUDE_LOCK_RETRY_MS = 25;

async function withClaudeLock<T>(
  statePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const lock = `${statePath}.lock`;
  const deadline = Date.now() + CLAUDE_LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await stat(lock).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > CLAUDE_LOCK_STALE_MS) {
        // A holder that stopped refreshing its lock has died; taking it over
        // is what proper-lockfile does too.
        await rmdir(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(`${lock} is held by another process`);
      await Bun.sleep(CLAUDE_LOCK_RETRY_MS);
    }
  }
  try {
    return await run();
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

type ClaudeProjects = Record<string, Record<string, unknown>>;

/**
 * Reads, changes and atomically replaces Claude's `.claude.json` under its
 * own lock. `change` returns false to leave the file as it was. A missing
 * file starts empty; one that is not a JSON object is left alone. A file kept
 * as a link, with the user's dotfiles say, is locked and written where it
 * points, as Claude does, so the link stays a link.
 */
async function updateClaudeState(
  statePath: string,
  change: (projects: ClaudeProjects, state: Record<string, unknown>) => boolean,
): Promise<void> {
  await ensureDirectory(dirname(statePath));
  const target = await realpath(statePath).catch(() => statePath);
  await withClaudeLock(target, async () => {
    const text = await readText(target);
    const parsed = (text ? JSON.parse(text) : {}) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const state = parsed as Record<string, unknown>;
    const projects =
      state.projects && typeof state.projects === "object"
        ? (state.projects as ClaudeProjects)
        : {};
    if (!change(projects, state)) return;
    await replaceFile(target, `${JSON.stringify(state, null, 2)}\n`);
  });
}

/**
 * Sets Claude's trust flags on the folder's project entry, creating it if
 * needed. Every other key in the file, and in the entry, is kept as it was.
 */
export async function trustClaudeFolder(
  statePath: string,
  folder: string,
): Promise<void> {
  await updateClaudeState(statePath, (projects, state) => {
    const entry = projects[folder] ?? {};
    if (
      Object.entries(CLAUDE_TRUST_FLAGS).every(
        ([key, value]) => entry[key] === value,
      )
    )
      return false;
    state.projects = {
      ...projects,
      [folder]: { ...entry, ...CLAUDE_TRUST_FLAGS },
    };
    return true;
  });
}

export async function forgetClaudeFolders(
  statePath: string,
  roots: readonly string[],
): Promise<void> {
  if (!(await Bun.file(statePath).exists())) return;
  await updateClaudeState(statePath, (projects) => {
    const stale = Object.keys(projects).filter((path) =>
      isAtOrInside(roots, path),
    );
    for (const path of stale) delete projects[path];
    return stale.length > 0;
  });
}

import { join } from "node:path";
import { CLOUD_DAEDAL } from "../services/cloud-launch";
import { renderCodexHookBlock } from "../services/hook-install";
import {
  applyCaps,
  collectTree,
  entries,
  fingerprint,
  newItem,
  POD_HOME,
  type DaedalusPodSkill,
  type SyncFile,
  type SyncItem,
} from "./claude-sync";

/**
 * What a cloud Codex takes of this Mac's Codex setup
 * (artifacts/cloud-sessions/codex-spike.md, section 5), and the pod's
 * `config.toml`, which the Mac writes whole before each Codex launch.
 *
 * Nothing that holds or may hold a secret goes: no `auth.json`, no MCP
 * servers, no model providers, no shell environment policy. Nothing that
 * names this Mac goes either: no `notify`, no `projects`, no hooks.
 */

/** The pod's Codex home, relative to the workspace root. */
export const POD_CODEX = ".home/.codex";
export const POD_CODEX_CONFIG = `${POD_CODEX}/config.toml`;
/** Where Codex in the pod reads its configuration, as it names it. */
export const POD_CODEX_CONFIG_PATH = `${POD_HOME}/.codex/config.toml`;
/** Where Codex in the pod keeps its sign-in; never read, only checked for. */
export const POD_CODEX_AUTH = `${POD_CODEX}/auth.json`;
/** What the Mac copied last time, so a launch writes only what changed. */
export const CODEX_SYNC_MANIFEST_PATH = `${POD_CODEX}/.daedalus-sync.json`;
/** The fence of Daedalus's hooks in the pod's `config.toml`. */
export const POD_CODEX_CHANNEL = "cloud";

/** Plain strings from the top level of the Mac's `config.toml`. */
const SYNCED_STRINGS = [
  "model",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "personality",
  "service_tier",
] as const;
const BARE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_VALUE = 200;
const TRUSTED_HASH = /^sha256:[0-9a-f]{64}$/;

type Toml = Record<string, unknown>;

const isTable = (value: unknown): value is Toml =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseToml(text: string | undefined): Toml {
  if (!text?.trim()) return {};
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    return isTable(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A JSON string is a valid TOML basic string, escapes included. */
const tomlString = (value: string): string => JSON.stringify(value);

const scalar = (value: unknown): string | undefined => {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  // A value that looks like a path names this Mac.
  if (
    typeof value === "string" &&
    value.length <= MAX_VALUE &&
    !value.includes("/")
  )
    return tomlString(value);
  return undefined;
};

/** The settings of the Mac's `config.toml` that a cloud Codex takes. */
export function syncedCodexSettings(macText: string | undefined): {
  strings: Record<string, string>;
  features: Record<string, boolean>;
  tui: Record<string, string>;
} {
  const mac = parseToml(macText);
  const strings: Record<string, string> = {};
  for (const key of SYNCED_STRINGS) {
    const value = mac[key];
    if (typeof value === "string" && value.length <= MAX_VALUE)
      strings[key] = tomlString(value);
  }
  const features: Record<string, boolean> = {};
  if (isTable(mac.features))
    for (const [key, value] of Object.entries(mac.features))
      if (BARE_KEY.test(key) && typeof value === "boolean")
        features[key] = value;
  const tui: Record<string, string> = {};
  if (isTable(mac.tui))
    for (const [key, value] of Object.entries(mac.tui)) {
      const text = BARE_KEY.test(key) ? scalar(value) : undefined;
      if (text !== undefined) tui[key] = text;
    }
  return { strings, features, tui };
}

/**
 * The approvals Codex recorded in the pod for Daedalus's own hooks, which
 * the next config keeps so Codex does not ask again. Only keys for this
 * file's hooks, and only well-formed hashes: the hooks themselves are always
 * the Mac's, so a pod-written record can only approve those.
 */
function keptHookTrust(podText: string | undefined): [string, string][] {
  const state = (() => {
    const hooks = parseToml(podText).hooks;
    return isTable(hooks) && isTable(hooks.state) ? hooks.state : {};
  })();
  const key = new RegExp(
    `^${POD_CODEX_CONFIG_PATH.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}:[a-z_]{1,40}:0:0$`,
  );
  return Object.entries(state)
    .filter(
      ([name, value]) =>
        key.test(name) &&
        isTable(value) &&
        typeof value.trusted_hash === "string" &&
        TRUSTED_HASH.test(value.trusted_hash),
    )
    .map(([name, value]): [string, string] => [
      name,
      (value as Toml).trusted_hash as string,
    ])
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The pod's whole `config.toml` for a launch: the synced settings, every
 * session folder trusted (Codex asks once per git root otherwise), the
 * Daedalus hook block, and the approvals Codex recorded for those hooks.
 * `screen_reader_detection_done` is set because Codex writes it on its first
 * start, and a file Codex changed is no longer the one the Mac wrote.
 */
export function podCodexConfig(input: {
  macText: string | undefined;
  podText: string | undefined;
  /** Absolute pod paths of the workspace's session folders. */
  folders: readonly string[];
}): string {
  const settings = syncedCodexSettings(input.macText);
  const lines = [
    "# Written by Daedalus before each Codex launch in this cloud workspace.",
    "# Changes here are replaced at the next launch.",
  ];
  for (const [key, value] of Object.entries(settings.strings))
    lines.push(`${key} = ${value}`);
  const features = { ...settings.features, hooks: true };
  lines.push("", "[features]");
  for (const [key, value] of Object.entries(features))
    lines.push(`${key} = ${value}`);
  const tui = { ...settings.tui, screen_reader_detection_done: "true" };
  lines.push("", "[tui]");
  for (const [key, value] of Object.entries(tui))
    lines.push(`${key} = ${value}`);
  for (const folder of [...new Set(input.folders)].sort())
    lines.push(
      "",
      `[projects.${tomlString(folder)}]`,
      'trust_level = "trusted"',
    );
  lines.push(
    "",
    renderCodexHookBlock(CLOUD_DAEDAL, POD_CODEX_CHANNEL, [], true),
  );
  const trust = keptHookTrust(input.podText);
  if (trust.length) lines.push("", "[hooks.state]");
  for (const [key, hash] of trust)
    lines.push(
      "",
      `[hooks.state.${tomlString(key)}]`,
      `trusted_hash = ${tomlString(hash)}`,
    );
  return `${lines.join("\n")}\n`;
}

export interface CodexSync {
  items: SyncItem[];
  overCap: string[];
}

/**
 * The Mac's `AGENTS.md`, `prompts/*`, its skills (without `.system`, which
 * Codex makes itself) and Daedalus's pod skills, under the pod's Codex home.
 */
export async function collectCodexSync(input: {
  codexHome: string;
  macHome: string;
  daedalusSkills: DaedalusPodSkill[];
}): Promise<CodexSync> {
  const items: SyncItem[] = [];
  for (const skill of input.daedalusSkills) {
    const item = newItem(`daedalus ${skill.name}`);
    for (const file of skill.files)
      item.files.push({
        path: `${POD_CODEX}/skills/${skill.name}/${file.path}`,
        bytes: new TextEncoder().encode(file.contents),
        executable: false,
      });
    items.push(item);
  }
  const one = async (rel: string, label = rel) => {
    const item = newItem(label);
    await collectTree(
      input.codexHome,
      join(input.codexHome, rel),
      `${POD_CODEX}/${rel}`,
      item,
      input.macHome,
    );
    return item;
  };
  const agents = await one("AGENTS.md");
  if (agents.files.length || agents.skipped.length) items.push(agents);
  for (const name of await entries(join(input.codexHome, "prompts"))) {
    const item = await one(`prompts/${name}`);
    if (item.files.length || item.skipped.length) items.push(item);
  }
  const daedalus = new Set(input.daedalusSkills.map((skill) => skill.name));
  for (const name of await entries(join(input.codexHome, "skills"))) {
    if (daedalus.has(name)) continue;
    const item = await one(`skills/${name}`);
    const isSkill = item.files.some(
      (file) => file.path === `${POD_CODEX}/skills/${name}/SKILL.md`,
    );
    if (isSkill || item.skipped.length)
      items.push(isSkill ? item : { ...item, files: [] });
  }
  const capped = applyCaps(items);
  return { items: capped.kept, overCap: capped.overCap };
}

/** Paths a manifest from the pod may name; anything else is ignored. */
const isSyncedPath = (path: string): boolean =>
  path.startsWith(`${POD_CODEX}/`) &&
  !path.split("/").some((part) => part === ".." || part === "") &&
  path !== CODEX_SYNC_MANIFEST_PATH &&
  path !== POD_CODEX_CONFIG &&
  path !== POD_CODEX_AUTH;

/** The pod's manifest, believed only as far as its shape and paths go. */
export function parseCodexManifest(
  text: string | undefined,
): Record<string, string> {
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = {};
  }
  const files: Record<string, string> = {};
  const listed = isTable(raw) && isTable(raw.files) ? raw.files : {};
  for (const [path, value] of Object.entries(listed))
    if (typeof value === "string" && isSyncedPath(path)) files[path] = value;
  return files;
}

/** What to write and remove in the pod, given what was copied last time. */
export function planCodexSync(
  sync: CodexSync,
  previous: Record<string, string>,
): { writes: SyncFile[]; executable: string[]; removed: string[] } {
  const files: Record<string, string> = {};
  const writes: SyncFile[] = [];
  const executable: string[] = [];
  for (const item of sync.items)
    for (const file of item.files) {
      if (file.path in files || !isSyncedPath(file.path)) continue;
      const print = fingerprint(file);
      files[file.path] = print;
      if (previous[file.path] === print) continue;
      writes.push(file);
      if (file.executable) executable.push(file.path);
    }
  const removed = Object.keys(previous)
    .filter((path) => !(path in files))
    .sort();
  if (
    writes.length ||
    removed.length ||
    JSON.stringify(previous) !== JSON.stringify(files)
  )
    writes.push({
      path: CODEX_SYNC_MANIFEST_PATH,
      bytes: new TextEncoder().encode(
        `${JSON.stringify({ version: 1, files }, null, 2)}\n`,
      ),
      executable: false,
    });
  return { writes, executable, removed };
}

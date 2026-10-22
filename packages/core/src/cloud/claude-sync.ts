import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/**
 * The user's Claude setup, copied from this Mac into a cloud Claude's pod at
 * each launch: their skills, commands, agents, output styles and CLAUDE.md,
 * the Daedalus skills that work from a pod, their enabled plugins, and the
 * remote MCP servers whose configuration holds no secret.
 *
 * Files go one way, Mac to pod. The pod's own files are read only for the
 * manifest of what was copied last time and the settings files merged into;
 * nothing from the pod is ever written on this Mac.
 *
 * Each place things come from is one `SyncSource`; another one is a function
 * that returns `SyncItem`s.
 */

/** The pod's `HOME`, and where its Claude folder sits in the workspace. */
export const POD_HOME = "/workspace/.home";
const POD_CLAUDE = ".home/.claude";

/** What the Mac copied last time, so a launch writes only what changed. */
export const SYNC_MANIFEST_PATH = `${POD_CLAUDE}/.daedalus-sync.json`;
export const POD_INSTALLED_PLUGINS = `${POD_CLAUDE}/plugins/installed_plugins.json`;
export const POD_KNOWN_MARKETPLACES = `${POD_CLAUDE}/plugins/known_marketplaces.json`;

export const SYNC_LIMITS = {
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  files: 3000,
} as const;

/** Never copied, wherever they sit: they hold, or may hold, a secret. */
const SECRET_NAMES = /^(\.credentials\.json|\.env(\..*)?|.*\.pem|.*\.key)$/i;
/** Left out of every folder: rebuilt or bookkeeping, never needed. */
const SKIPPED_NAMES = new Set([".git", "node_modules", ".in_use", ".DS_Store"]);

/** Claude's own output styles, which need no file. */
const BUILT_IN_STYLES = new Set(["default", "Explanatory", "Learning"]);

export interface SyncFile {
  /** Relative to the workspace root, under `.home/.claude`. */
  path: string;
  bytes: Uint8Array;
  executable: boolean;
}

/**
 * One thing copied whole or not at all: a skill folder, a plugin, a command
 * file. A cap that would cut one leaves it out entirely.
 */
export interface SyncItem {
  /** How the log names it, such as `skills/review` or `plugin github@x`. */
  label: string;
  files: SyncFile[];
  /** Parts left out by the rules, each with why. */
  skipped: SyncSkip[];
  /** Whether a text file in it names a path on this Mac. */
  macPaths: boolean;
  /** A file in it over `SYNC_LIMITS.fileBytes`, which leaves it all out. */
  oversized?: string;
}

export interface SyncSkip {
  path: string;
  reason: string;
}

export interface McpLeftOut {
  name: string;
  reason: string;
}

/** A plugin as `installed_plugins.json` records it. */
interface PluginInstall {
  scope: string;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
}

/** A marketplace as `known_marketplaces.json` records it. */
interface MarketplaceRecord {
  source: Json;
  installLocation: string;
  lastUpdated?: string;
}

/** A built-in Daedalus skill, rendered for the pod. */
export interface DaedalusPodSkill {
  name: string;
  files: { path: string; contents: string }[];
  style?: { fileName: string; styleName: string; contents: string };
}

export interface ClaudeSyncInput {
  /** The launch account's Claude folder on this Mac. */
  claudeHome: string;
  /** This Mac's home, to spot paths in copied files that only work here. */
  macHome: string;
  /** That account's `.claude.json` text, for its MCP servers. */
  stateText?: string;
  /** That account's `settings.json` text. */
  settingsText?: string;
  daedalusSkills: DaedalusPodSkill[];
  /** The style Daedalus selects for its own Claude sessions, if any. */
  daedalusStyle?: string;
}

export interface ClaudeSync {
  items: SyncItem[];
  /** Whole items left out by a cap. */
  overCap: string[];
  /** Plugins whose files are in `items`, keyed as in `enabledPlugins`. */
  plugins: Record<string, PluginInstall>;
  /** Their marketplaces, which Claude needs to load them. */
  marketplaces: Record<string, MarketplaceRecord>;
  mcpServers: Record<string, { type: string; url: string }>;
  mcpLeftOut: McpLeftOut[];
  /** `hooks` from the user's settings, without any that name a Mac path. */
  hooks?: Record<string, unknown>;
  hooksLeftOut: number;
  outputStyle?: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseObject(text: string | undefined): Json {
  if (!text?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
};

/** A text file that names this Mac's home. Binary files are not read as text. */
function namesMacPath(bytes: Uint8Array, macHome: string): boolean {
  if (bytes.includes(0)) return false;
  return Buffer.from(bytes).toString("utf8").includes(macHome);
}

/**
 * The files under `source`, for the pod under `target`. A link is followed
 * only when its real target is inside `root` (the Mac's Claude folder); a
 * link out of it is skipped, as is anything that may hold a secret.
 */
async function collectTree(
  root: string,
  source: string,
  target: string,
  item: SyncItem,
  macHome: string,
  seen = new Set<string>(),
): Promise<void> {
  let info;
  try {
    info = await lstat(source);
  } catch {
    return;
  }
  const label = relative(root, source) || ".";
  // The real path of every entry, not only of links: a linked folder above
  // a path leads out of ~/.claude as surely as a link at it.
  let real: string;
  try {
    real = await realpath(source);
    if (info.isSymbolicLink()) info = await stat(real);
  } catch {
    item.skipped.push({ path: label, reason: "a broken link" });
    return;
  }
  if (!isInside(await realpath(root), real)) {
    item.skipped.push({ path: label, reason: "a link out of ~/.claude" });
    return;
  }
  if (info.isDirectory()) {
    if (seen.has(real)) return;
    seen.add(real);
    const names = (await readdir(real).catch(() => [] as string[])).sort();
    for (const name of names) {
      if (SKIPPED_NAMES.has(name)) continue;
      await collectTree(
        root,
        join(source, name),
        `${target}/${name}`,
        item,
        macHome,
        seen,
      );
    }
    return;
  }
  if (!info.isFile()) return;
  if (SECRET_NAMES.test(source.slice(source.lastIndexOf(sep) + 1))) {
    item.skipped.push({ path: label, reason: "may hold a secret" });
    return;
  }
  if (info.size > SYNC_LIMITS.fileBytes) {
    // One file over the limit leaves its whole item out (see `applyCaps`).
    item.oversized ??= label;
    return;
  }
  const bytes = new Uint8Array(await readFile(real));
  if (namesMacPath(bytes, macHome)) item.macPaths = true;
  item.files.push({
    path: target,
    bytes,
    executable: (info.mode & 0o111) !== 0,
  });
}

const newItem = (label: string): SyncItem => ({
  label,
  files: [],
  skipped: [],
  macPaths: false,
});

async function entries(directory: string): Promise<string[]> {
  return (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => !SKIPPED_NAMES.has(name) && !name.startsWith("."))
    .sort();
}

/** A source of things to copy; adding one is adding a function here. */
type SyncSource = (input: ClaudeSyncInput) => Promise<SyncItem[]>;

/** `CLAUDE.md`, and each entry of `commands`, `agents` and `output-styles`. */
const userFiles: SyncSource = async (input) => {
  const items: SyncItem[] = [];
  const one = async (rel: string) => {
    const item = newItem(rel);
    await collectTree(
      input.claudeHome,
      join(input.claudeHome, rel),
      `${POD_CLAUDE}/${rel}`,
      item,
      input.macHome,
    );
    if (item.files.length || item.skipped.length) items.push(item);
  };
  await one("CLAUDE.md");
  for (const folder of ["commands", "agents", "output-styles"])
    for (const name of await entries(join(input.claudeHome, folder)))
      await one(`${folder}/${name}`);
  return items;
};

/** Each folder of `skills` that is a skill, that is, holds a `SKILL.md`. */
const userSkills: SyncSource = async (input) => {
  const items: SyncItem[] = [];
  for (const name of await entries(join(input.claudeHome, "skills"))) {
    const item = newItem(`skills/${name}`);
    await collectTree(
      input.claudeHome,
      join(input.claudeHome, "skills", name),
      `${POD_CLAUDE}/skills/${name}`,
      item,
      input.macHome,
    );
    const isSkill = item.files.some(
      (file) => file.path === `${POD_CLAUDE}/skills/${name}/SKILL.md`,
    );
    // The links Daedalus makes to its own skills point out of ~/.claude;
    // `daedalusSkills` brings the ones that work from a pod.
    if (isSkill || item.skipped.length)
      items.push(isSkill ? item : { ...item, files: [] });
  }
  return items;
};

const daedalusSkills: SyncSource = async (input) =>
  input.daedalusSkills.flatMap((skill) => {
    const item = newItem(`daedalus ${skill.name}`);
    for (const file of skill.files)
      item.files.push({
        path: `${POD_CLAUDE}/skills/${skill.name}/${file.path}`,
        bytes: new TextEncoder().encode(file.contents),
        executable: false,
      });
    const style = skill.style
      ? [
          {
            ...newItem(`daedalus style ${skill.style.styleName}`),
            files: [
              {
                path: `${POD_CLAUDE}/output-styles/${skill.style.fileName}`,
                bytes: new TextEncoder().encode(skill.style.contents),
                executable: false,
              },
            ],
          },
        ]
      : [];
    return [item, ...style];
  });

/**
 * The plugins the user's settings turn on that are installed for the user,
 * from where Claude installed them. Their data folders stay behind.
 */
interface FoundPlugin {
  key: string;
  install: PluginInstall;
  item: SyncItem;
  marketplace?: { name: string; record: MarketplaceRecord };
}

/**
 * A marketplace's record for the pod: where it came from, and its
 * `marketplace.json` in the pod's plugins folder. Undefined when its source
 * is not a plain address (a token in a URL, say).
 */
function podMarketplace(
  name: string,
  record: unknown,
): MarketplaceRecord | undefined {
  if (!isObject(record) || !isObject(record.source)) return undefined;
  const url = record.source.url;
  if (url !== undefined) {
    try {
      const parsed = new URL(String(url));
      if (parsed.username || parsed.password || parsed.search) return undefined;
    } catch {
      return undefined;
    }
  }
  return {
    source: record.source,
    installLocation: `${POD_HOME}/.claude/plugins/marketplaces/${name}`,
    ...(typeof record.lastUpdated === "string"
      ? { lastUpdated: record.lastUpdated }
      : {}),
  };
}

const MARKETPLACE_NAME = /^[A-Za-z0-9._-]+$/;

async function enabledPlugins(input: ClaudeSyncInput): Promise<FoundPlugin[]> {
  const enabled = parseObject(input.settingsText).enabledPlugins;
  if (!isObject(enabled)) return [];
  const installed = parseObject(
    await readFile(
      join(input.claudeHome, "plugins", "installed_plugins.json"),
      "utf8",
    ).catch(() => undefined),
  ).plugins;
  if (!isObject(installed)) return [];
  const known = parseObject(
    await readFile(
      join(input.claudeHome, "plugins", "known_marketplaces.json"),
      "utf8",
    ).catch(() => undefined),
  );
  const cache = resolve(input.claudeHome, "plugins", "cache");
  const found: FoundPlugin[] = [];
  for (const [key, on] of Object.entries(enabled).sort()) {
    if (on !== true) continue;
    const list = installed[key];
    const install = Array.isArray(list)
      ? list.find(
          (one): one is PluginInstall =>
            isObject(one) &&
            one.scope === "user" &&
            typeof one.installPath === "string",
        )
      : undefined;
    const item = newItem(`plugin ${key}`);
    if (!install) {
      item.skipped.push({ path: key, reason: "not installed for the user" });
      found.push({ key, install: { scope: "user", installPath: "" }, item });
      continue;
    }
    const marketName = key.slice(key.lastIndexOf("@") + 1);
    const marketRecord = MARKETPLACE_NAME.test(marketName)
      ? podMarketplace(marketName, known[marketName])
      : undefined;
    if (!marketRecord) {
      item.skipped.push({
        path: key,
        reason:
          "its marketplace is not known, or its address may hold a secret",
      });
      found.push({ key, install, item });
      continue;
    }
    const path = resolve(install.installPath);
    if (!isInside(cache, path) || path === cache) {
      item.skipped.push({
        path: key,
        reason: "installed outside ~/.claude/plugins/cache",
      });
      found.push({ key, install, item });
      continue;
    }
    await collectTree(
      input.claudeHome,
      path,
      `${POD_CLAUDE}/plugins/cache/${relative(cache, path).split(sep).join("/")}`,
      item,
      input.macHome,
    );
    // Claude reads the plugin's entry in its marketplace's file; it goes
    // with the plugin, so neither is copied without the other.
    await collectTree(
      input.claudeHome,
      join(
        input.claudeHome,
        "plugins",
        "marketplaces",
        marketName,
        ".claude-plugin",
        "marketplace.json",
      ),
      `${POD_CLAUDE}/plugins/marketplaces/${marketName}/.claude-plugin/marketplace.json`,
      item,
      input.macHome,
    );
    found.push({
      key,
      marketplace: { name: marketName, record: marketRecord },
      install: {
        scope: "user",
        installPath: `${POD_HOME}/.claude/plugins/cache/${relative(cache, path).split(sep).join("/")}`,
        ...(typeof install.version === "string"
          ? { version: install.version }
          : {}),
        ...(typeof install.installedAt === "string"
          ? { installedAt: install.installedAt }
          : {}),
        ...(typeof install.lastUpdated === "string"
          ? { lastUpdated: install.lastUpdated }
          : {}),
        ...(typeof install.gitCommitSha === "string"
          ? { gitCommitSha: install.gitCommitSha }
          : {}),
      },
      item,
    });
  }
  return found;
}

/**
 * The user's MCP servers a pod can reach and may hold: remote ones, by an
 * https URL alone. A server with headers, environment, OAuth settings or
 * anything else beside its URL may carry a secret, and a local command does
 * not exist in the pod; both are left out and named.
 */
export function remoteMcpServers(stateText: string | undefined): {
  servers: Record<string, { type: string; url: string }>;
  leftOut: McpLeftOut[];
} {
  const configured = parseObject(stateText).mcpServers;
  const servers: Record<string, { type: string; url: string }> = {};
  const leftOut: McpLeftOut[] = [];
  if (!isObject(configured)) return { servers, leftOut };
  for (const [name, config] of Object.entries(configured).sort()) {
    const out = (reason: string) => leftOut.push({ name, reason });
    if (!isObject(config)) {
      out("not a server configuration");
      continue;
    }
    const type = config.type;
    if (type !== "http" && type !== "sse") {
      out("a local command");
      continue;
    }
    const extra = Object.keys(config).filter(
      (key) => key !== "type" && key !== "url",
    );
    if (extra.length) {
      out(`has ${extra.sort().join(", ")}, which may hold a secret`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(String(config.url));
    } catch {
      out("no valid URL");
      continue;
    }
    if (url.protocol !== "https:") {
      out("not an https URL");
      continue;
    }
    if (url.username || url.password || url.search) {
      out("a user name or query string in its URL, which may hold a secret");
      continue;
    }
    servers[name] = { type, url: url.toString() };
  }
  return { servers, leftOut };
}

/** A hook command that names a path that exists only on a Mac. */
const MAC_PATH =
  /(^|[\s"'=:;(])(~|\$HOME|\$\{HOME\}|\/Users\/|\/Applications\/|\/Library\/|\/opt\/homebrew\/|\/private\/|\/Volumes\/)/;

/** The user's hooks without any whose command names a Mac path. */
export function podHooks(settingsText: string | undefined): {
  hooks?: Record<string, unknown>;
  leftOut: number;
} {
  const hooks = parseObject(settingsText).hooks;
  if (!isObject(hooks)) return { leftOut: 0 };
  let leftOut = 0;
  const kept: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const keptGroups = groups.flatMap((group: unknown) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [];
      const keptHooks = group.hooks.filter((hook: unknown) => {
        const ok =
          isObject(hook) &&
          (hook.type !== "command" ||
            (typeof hook.command === "string" && !MAC_PATH.test(hook.command)));
        if (!ok) leftOut += 1;
        return ok;
      });
      return keptHooks.length ? [{ ...group, hooks: keptHooks }] : [];
    });
    if (keptGroups.length) kept[event] = keptGroups;
  }
  return { ...(Object.keys(kept).length ? { hooks: kept } : {}), leftOut };
}

/**
 * Leaves out whole items past the caps, in order, so what is copied is
 * every file of an item or none of it.
 */
function applyCaps(items: SyncItem[]): { kept: SyncItem[]; overCap: string[] } {
  const kept: SyncItem[] = [];
  const overCap: string[] = [];
  let bytes = 0;
  let files = 0;
  for (const item of items) {
    if (item.oversized) {
      overCap.push(
        `${item.label} (${item.oversized} is over ${SYNC_LIMITS.fileBytes / 1024 / 1024} MiB)`,
      );
      continue;
    }
    const size = item.files.reduce((sum, file) => sum + file.bytes.length, 0);
    if (
      bytes + size > SYNC_LIMITS.totalBytes ||
      files + item.files.length > SYNC_LIMITS.files
    ) {
      overCap.push(
        `${item.label} (over the ${SYNC_LIMITS.totalBytes / 1024 / 1024} MiB or ${SYNC_LIMITS.files} file limit)`,
      );
      continue;
    }
    bytes += size;
    files += item.files.length;
    kept.push(item);
  }
  return { kept, overCap };
}

/** Everything a launch copies from this Mac, before it looks at the pod. */
export async function collectClaudeSync(
  input: ClaudeSyncInput,
): Promise<ClaudeSync> {
  // Daedalus skills first: they are small, and a session's team or task
  // prompt names them.
  const sources: SyncSource[] = [daedalusSkills, userFiles, userSkills];
  const items: SyncItem[] = [];
  for (const source of sources) items.push(...(await source(input)));
  const plugins = await enabledPlugins(input);
  const capped = applyCaps([...items, ...plugins.map((one) => one.item)]);
  const keptLabels = new Set(capped.kept.map((item) => item.label));
  const copiedPlugins: Record<string, PluginInstall> = {};
  const marketplaces: Record<string, MarketplaceRecord> = {};
  for (const plugin of plugins)
    if (
      plugin.marketplace &&
      plugin.item.files.length &&
      keptLabels.has(plugin.item.label)
    )
      marketplaces[plugin.marketplace.name] = plugin.marketplace.record;
  for (const plugin of plugins)
    if (
      plugin.install.installPath &&
      plugin.item.files.length &&
      keptLabels.has(plugin.item.label)
    )
      copiedPlugins[plugin.key] = plugin.install;
  const mcp = remoteMcpServers(input.stateText);
  const hooks = podHooks(input.settingsText);
  return {
    // Items with nothing to copy stay too: they carry what they skipped.
    items: capped.kept,
    overCap: capped.overCap,
    plugins: copiedPlugins,
    marketplaces,
    mcpServers: mcp.servers,
    mcpLeftOut: mcp.leftOut,
    ...(hooks.hooks ? { hooks: hooks.hooks } : {}),
    hooksLeftOut: hooks.leftOut,
    ...podStyle(input, capped.kept),
  };
}

/**
 * The output style the pod's Claude selects: the one this Mac's Daedalus
 * sessions use, else the user's own, and only when the pod has it.
 */
function podStyle(
  input: ClaudeSyncInput,
  kept: SyncItem[],
): { outputStyle?: string } {
  const user = parseObject(input.settingsText).outputStyle;
  const wanted =
    input.daedalusStyle ?? (typeof user === "string" ? user : undefined);
  if (!wanted) return {};
  if (BUILT_IN_STYLES.has(wanted)) return { outputStyle: wanted };
  const styles = kept.flatMap((item) =>
    item.files
      .filter((file) => file.path.startsWith(`${POD_CLAUDE}/output-styles/`))
      .map((file) => styleName(file)),
  );
  return styles.includes(wanted) ? { outputStyle: wanted } : {};
}

/** A style's name: its frontmatter `name`, else its file name. */
function styleName(file: SyncFile): string {
  const text = Buffer.from(file.bytes).toString("utf8");
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const name = head && /^name\s*:\s*(.+?)\s*$/m.exec(head)?.[1];
  if (name) return name.replace(/^["']|["']$/g, "");
  const base = file.path.slice(file.path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/, "");
}

/* -------------------------------------------------------------------------- */
/* The pod                                                                    */
/* -------------------------------------------------------------------------- */

/** One file's entry in the manifest: its hash and whether it runs. */
const fingerprint = (file: SyncFile): string =>
  `${createHash("sha256").update(file.bytes).digest("hex")}${file.executable ? ":x" : ""}`;

export interface SyncManifest {
  version: 1;
  files: Record<string, string>;
  /** The plugins and MCP servers the Mac turned on in the pod. */
  plugins: string[];
  marketplaces: string[];
  mcpServers: string[];
  /** Whether the Mac set the pod's `hooks`. */
  hooks: boolean;
}

/** Paths a manifest from the pod may name; anything else is ignored. */
const isSyncedPath = (path: string): boolean =>
  path.startsWith(`${POD_CLAUDE}/`) &&
  !path.split("/").some((part) => part === ".." || part === "") &&
  path !== SYNC_MANIFEST_PATH;

/** The pod's manifest, believed only as far as its shape and paths go. */
export function parseManifest(text: string | undefined): SyncManifest {
  const raw = parseObject(text);
  const files: Record<string, string> = {};
  if (isObject(raw.files))
    for (const [path, value] of Object.entries(raw.files))
      if (typeof value === "string" && isSyncedPath(path)) files[path] = value;
  const names = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((one): one is string => typeof one === "string")
      : [];
  return {
    version: 1,
    files,
    plugins: names(raw.plugins),
    marketplaces: names(raw.marketplaces),
    mcpServers: names(raw.mcpServers),
    hooks: raw.hooks === true,
  };
}

export interface SyncPlan {
  /** Files to write, the new manifest last. */
  writes: SyncFile[];
  /** Files to mark executable after the writes. */
  executable: string[];
  /** Files the Mac copied before and no longer has. */
  removed: string[];
  unchanged: number;
  manifest: SyncManifest;
}

/** What to change in the pod, given what the Mac copied last time. */
export function planSync(sync: ClaudeSync, previous: SyncManifest): SyncPlan {
  const files: Record<string, string> = {};
  const writes: SyncFile[] = [];
  const executable: string[] = [];
  let unchanged = 0;
  for (const item of sync.items)
    for (const file of item.files) {
      // Plugins of one marketplace each carry its file.
      if (file.path in files) continue;
      const print = fingerprint(file);
      files[file.path] = print;
      if (previous.files[file.path] === print) {
        unchanged += 1;
        continue;
      }
      writes.push(file);
      if (file.executable) executable.push(file.path);
    }
  const removed = Object.keys(previous.files)
    .filter((path) => !(path in files))
    .sort();
  const manifest: SyncManifest = {
    version: 1,
    files,
    plugins: Object.keys(sync.plugins).sort(),
    marketplaces: Object.keys(sync.marketplaces).sort(),
    mcpServers: Object.keys(sync.mcpServers).sort(),
    hooks: Boolean(sync.hooks),
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const changed =
    writes.length ||
    removed.length ||
    JSON.stringify(previous) !== JSON.stringify(manifest);
  if (changed)
    writes.push({
      path: SYNC_MANIFEST_PATH,
      bytes: new TextEncoder().encode(manifestText),
      executable: false,
    });
  return { writes, executable, removed, unchanged, manifest };
}

/**
 * The pod's `installed_plugins.json` with the copied plugins in place: the
 * ones the Mac copied before and no longer does are dropped, the pod's
 * others kept. Undefined when nothing changes.
 */
export function seedInstalledPlugins(
  podText: string | undefined,
  plugins: Record<string, PluginInstall>,
  previous: string[],
): string | undefined {
  const pod = parseObject(podText);
  const next = mergeOwned(
    isObject(pod.plugins) ? pod.plugins : {},
    Object.fromEntries(
      Object.entries(plugins).map(([key, install]) => [key, [install]]),
    ),
    previous,
  );
  if (!Object.keys(next).length && !podText) return undefined;
  const result = { ...pod, version: pod.version ?? 2, plugins: next };
  return JSON.stringify(result) === JSON.stringify(pod)
    ? undefined
    : `${JSON.stringify(result, null, 2)}\n`;
}

/** The pod's `known_marketplaces.json`, as `seedInstalledPlugins` does. */
export function seedKnownMarketplaces(
  podText: string | undefined,
  marketplaces: Record<string, MarketplaceRecord>,
  previous: string[],
): string | undefined {
  const pod = parseObject(podText);
  const next = mergeOwned(pod, marketplaces, previous);
  if (!Object.keys(next).length && !podText) return undefined;
  return JSON.stringify(next) === JSON.stringify(pod)
    ? undefined
    : `${JSON.stringify(next, null, 2)}\n`;
}

/** The pod's entries with the Mac's in place, minus the Mac's old ones. */
function mergeOwned(pod: Json, mac: Json, previous: string[]): Json {
  const next: Json = {};
  for (const [key, value] of Object.entries(pod))
    if (!previous.includes(key) || key in mac) next[key] = value;
  return Object.assign(next, mac);
}

/**
 * The pod's `~/.claude/settings.json` with the Mac's plugins turned on, its
 * output style and its hooks. Only those keys: never `env`, `permissions`,
 * `apiKeyHelper` or a status line. Undefined when nothing changes.
 */
export function syncedSettings(
  podText: string | undefined,
  sync: ClaudeSync,
  previous: SyncManifest,
): string | undefined {
  const pod = parseObject(podText);
  const next: Json = { ...pod };
  const enabled = mergeOwned(
    isObject(pod.enabledPlugins) ? pod.enabledPlugins : {},
    Object.fromEntries(Object.keys(sync.plugins).map((key) => [key, true])),
    previous.plugins,
  );
  if (Object.keys(enabled).length) next.enabledPlugins = enabled;
  else delete next.enabledPlugins;
  if (sync.outputStyle) next.outputStyle = sync.outputStyle;
  if (sync.hooks) next.hooks = sync.hooks;
  else if (previous.hooks) delete next.hooks;
  return JSON.stringify(next) === JSON.stringify(pod)
    ? undefined
    : `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * The pod's `.claude.json` with the Mac's remote MCP servers in place.
 * Undefined when nothing changes.
 */
export function syncedState(
  podText: string | undefined,
  sync: ClaudeSync,
  previous: SyncManifest,
): string | undefined {
  const pod = parseObject(podText);
  const servers = mergeOwned(
    isObject(pod.mcpServers) ? pod.mcpServers : {},
    sync.mcpServers,
    previous.mcpServers,
  );
  const next: Json = { ...pod };
  if (Object.keys(servers).length) next.mcpServers = servers;
  else delete next.mcpServers;
  return JSON.stringify(next) === JSON.stringify(pod)
    ? undefined
    : `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * What was left out, one line per reason when many share it: the links
 * Daedalus makes to its own skills would otherwise fill the line.
 */
function skippedLines(sync: ClaudeSync): string[] {
  const byReason = new Map<string, string[]>();
  for (const item of sync.items)
    for (const skip of item.skipped)
      byReason.set(skip.reason, [
        ...(byReason.get(skip.reason) ?? []),
        skip.path,
      ]);
  return [...byReason].map(
    ([reason, paths]) => `${reason}: ${paths.join(", ")}`,
  );
}

/** What one launch's sync did, for its log line. */
export function syncReport(
  sync: ClaudeSync,
  plan: SyncPlan,
): Record<string, unknown> {
  return {
    written: plan.writes.filter((file) => file.path !== SYNC_MANIFEST_PATH)
      .length,
    unchanged: plan.unchanged,
    removed: plan.removed.length,
    items: sync.items
      .filter((item) => item.files.length)
      .map((item) => item.label),
    skipped: skippedLines(sync),
    overCap: sync.overCap,
    macPaths: sync.items
      .filter((item) => item.macPaths)
      .map((item) => item.label),
    plugins: Object.keys(sync.plugins),
    mcpServers: Object.keys(sync.mcpServers),
    mcpLeftOut: sync.mcpLeftOut.map((one) => `${one.name}: ${one.reason}`),
    hooksLeftOut: sync.hooksLeftOut,
  };
}

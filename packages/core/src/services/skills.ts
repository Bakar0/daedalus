/**
 * The skill system.
 *
 * Two jobs live here and they are deliberately kept apart.
 *
 * The first is the set of capabilities Daedalus ships: `daedalus-control`, and
 * the `unslop` writing rules. Daedalus owns those files, installs them, and
 * turns them on and off. Nothing is installed without the user asking, and
 * everything installed is listed with the path it was written to, because a
 * control plane that writes into a user's provider configuration without
 * showing its work is indistinguishable from one that has gone wrong.
 *
 * The second is everything else on the machine: skills the user wrote, skills
 * from plugins, skills a provider bundles. Daedalus does not own those. It
 * finds them, reports them, and toggles them through each provider's own
 * switch rather than by moving anybody's files.
 *
 * Scope is global. One canonical copy per skill under `DAEDALUS_HOME`, and a
 * link in each provider's personal directory. There is no per-workspace state,
 * which is what keeps the state small enough to live in `config.json`.
 */
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalPath,
  ensureDirectory,
  findExecutable,
  isPathInside,
  pathExists,
  runCommand,
  standardExecutableFallbacks,
} from "@daedalus/platform";
import {
  channelName,
  saveClaudeOutputStyleWritten,
  saveClaudeOverridesWritten,
  saveManagedSkillSetting,
  saveSkillOverride,
  type DaedalusConfig,
  type ManagedSkillMode,
  type ManagedSkillSetting,
  type SkillVisibility,
} from "../config";
import { DaedalusError } from "../errors";

import daedalusControlSkillTemplate from "../../../../skills/daedalus-control/SKILL.md" with { type: "text" };
import daedalusControlCliReference from "../../../../skills/daedalus-control/references/cli.md" with { type: "text" };
import daedalusControlOpenAiMetadata from "../../../../skills/daedalus-control/agents/openai.yaml" with { type: "text" };
import unslopSkillTemplate from "../../../../skills/unslop/SKILL.md" with { type: "text" };
import unslopStyleTemplate from "../../../../styles/Unslop.md" with { type: "text" };

export type SkillProvider = "claude" | "codex" | "cursor";
export type SkillOrigin = "daedalus" | "user" | "plugin";
/** Which directory a skill was found in, which is how the list groups. */
export type SkillSource =
  "claude-personal" | "agents-personal" | "cursor-personal" | "claude-plugin";
export type SkillInvocation = "auto" | "user-only" | "model-only";
export type SkillArtifactKind =
  | "skill"
  | "style"
  | "instructions"
  /** The style being the one Claude actually uses, not merely installed. */
  | "selection";
export type SkillProblem =
  "unreadable-frontmatter" | "name-mismatch" | "broken-link";

const GIT_EXECUTABLE_FALLBACKS = standardExecutableFallbacks("git");
const SKILL_NAME = /^[a-z0-9]+(?:[-a-z0-9]+)*$/;
/**
 * How much of a `SKILL.md` the viewer will show. A skill is meant to be a page
 * an agent reads, so anything past this is a sign of something else, and the
 * renderer should not have to hold it.
 */
const MAX_SKILL_CONTENT = 256 * 1024;

/* -------------------------------------------------------------------------- */
/* The capabilities Daedalus ships                                            */
/* -------------------------------------------------------------------------- */

interface ManagedFile {
  /** Relative to the skill package directory. */
  path: string;
  contents: string;
}

export interface ManagedSkillDefinition {
  id: string;
  title: string;
  summary: string;
  /**
   * Whether the capability has a second, stronger state that installs a style
   * and an instructions block on top of the skill.
   */
  supportsAlways: boolean;
  defaultEnabled: boolean;
  defaultMode: ManagedSkillMode;
  skillFiles: ManagedFile[];
  /** The Claude Code output style, for a capability that is a writing style. */
  style?: { fileName: string; styleName: string; contents: string };
}

export const MANAGED_SKILLS: readonly ManagedSkillDefinition[] = [
  {
    id: "daedalus-control",
    title: "Daedalus control",
    summary:
      "Lets an agent drive Daedalus through the daedal CLI: workspaces, tasks, repositories, worktrees, and sessions.",
    supportsAlways: false,
    defaultEnabled: true,
    defaultMode: "on-demand",
    skillFiles: [
      { path: "SKILL.md", contents: daedalusControlSkillTemplate },
      { path: "references/cli.md", contents: daedalusControlCliReference },
      { path: "agents/openai.yaml", contents: daedalusControlOpenAiMetadata },
    ],
  },
  {
    id: "unslop",
    title: "Unslop",
    summary:
      "Cuts AI tells from writing. On demand it adds the /unslop command. Always also installs a Claude output style and a Codex instructions block, so the rules apply to every response.",
    supportsAlways: true,
    defaultEnabled: false,
    defaultMode: "on-demand",
    skillFiles: [{ path: "SKILL.md", contents: unslopSkillTemplate }],
    style: {
      fileName: "Unslop.md",
      styleName: "Unslop",
      contents: unslopStyleTemplate,
    },
  },
] as const;

const managedDefinition = (id: string): ManagedSkillDefinition | undefined =>
  MANAGED_SKILLS.find((definition) => definition.id === id);

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/** The one real copy of a skill. Everything else points at this. */
export const managedSkillPath = (config: DaedalusConfig, id: string): string =>
  join(config.home, "skills", id);

export const managedStylePath = (
  config: DaedalusConfig,
  fileName: string,
): string => join(config.home, "styles", fileName);

/**
 * Where a skill is linked so the providers find it.
 *
 * Two links cover all three providers. Claude Code reads `~/.claude/skills`,
 * and both Codex and Cursor read `~/.agents/skills`, so Cursor needs no link
 * of its own. `~/.cursor/skills` is still scanned when listing, because the
 * user may have put something there by hand.
 */
export const skillLinkPaths = (
  config: DaedalusConfig,
  id: string,
): Array<{ path: string; providers: SkillProvider[] }> => [
  { path: join(config.claudeHome, "skills", id), providers: ["claude"] },
  {
    path: join(config.agentsHome, "skills", id),
    providers: ["codex", "cursor"],
  },
];

/**
 * The name a managed artifact is installed under.
 *
 * The canonical copy lives inside `DAEDALUS_HOME`, which already carries the
 * channel, but the provider directories do not: `~/.claude/skills` is one
 * directory shared by every build on the machine. Without a suffix the stable
 * app and a dev build would each relink the same path to their own home, and
 * the last one launched would win. The Codex hook block is fenced by channel
 * for exactly this reason; these links need the same treatment.
 */
export const channelArtifactName = (
  config: DaedalusConfig,
  name: string,
): string => {
  const channel = channelName(config.home);
  return channel === "stable" ? name : `${name}-${channel}`;
};

/** Rewrites the `name:` line of a frontmatter block, leaving the rest alone. */
export function withFrontmatterName(contents: string, name: string): string {
  const normalized = contents.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return contents;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return contents;
  const head = normalized.slice(0, end);
  const rest = normalized.slice(end);
  return /^name\s*:/m.test(head)
    ? `${head.replace(/^name\s*:.*$/m, `name: ${name}`)}${rest}`
    : contents;
}

export const styleLinkPath = (
  config: DaedalusConfig,
  fileName: string,
): string => join(config.claudeHome, "output-styles", fileName);

export const codexInstructionsPath = (config: DaedalusConfig): string =>
  join(config.codexHome, "AGENTS.md");

/** The user's own Claude settings, which is what makes a switch global. */
export const claudeSettingsPath = (config: DaedalusConfig): string =>
  join(config.claudeHome, "settings.json");

/**
 * The fence around the block Daedalus owns inside the user's own `AGENTS.md`.
 *
 * Named after the channel for the same reason the Codex hook block is: a
 * machine can have the stable and a dev build installed, they share one
 * `~/.codex`, and a single shared fence would be rewritten by whichever one
 * ran last.
 */
export const instructionsMarkers = (channel: string, id: string) => ({
  begin: `<!-- >>> daedalus ${id} · ${channel} (generated — do not edit) >>> -->`,
  end: `<!-- <<< daedalus ${id} · ${channel} <<< -->`,
});

/* -------------------------------------------------------------------------- */
/* Frontmatter                                                                */
/* -------------------------------------------------------------------------- */

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
}

const unquote = (value: string): string =>
  (value.startsWith('"') && value.endsWith('"')) ||
  (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value;

/**
 * Reads the handful of frontmatter keys this app acts on.
 *
 * Deliberately not a YAML parser. The Agent Skills format puts one flat
 * `key: value` block at the top of the file, the app reads four of those keys,
 * and pulling in a parser to reach them would buy nothing. A file whose
 * frontmatter this cannot find returns `undefined`, which the caller reports
 * as a problem rather than swallowing, because a skill that silently vanishes
 * from a list is worse than one listed as unreadable.
 */
export function parseSkillFrontmatter(
  text: string,
): SkillFrontmatter | undefined {
  const normalized = text.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return undefined;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const block = normalized.slice(normalized.indexOf("\n") + 1, end);
  const frontmatter: SkillFrontmatter = {};
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = unquote(match[2]!.trim());
    if (key === "name") frontmatter.name = value;
    else if (key === "description") frontmatter.description = value;
    else if (key === "disable-model-invocation")
      frontmatter.disableModelInvocation = value === "true";
    else if (key === "user-invocable")
      frontmatter.userInvocable = value !== "false";
  }
  return frontmatter;
}

const invocationOf = (frontmatter: SkillFrontmatter): SkillInvocation =>
  frontmatter.disableModelInvocation
    ? "user-only"
    : frontmatter.userInvocable === false
      ? "model-only"
      : "auto";

/** The style body without its frontmatter, for embedding in an AGENTS.md. */
export function styleBody(contents: string): string {
  const normalized = contents.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return normalized.trim();
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return normalized.trim();
  return normalized
    .slice(end + "\n---".length)
    .replace(/^[^\n]*\n/, "")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Link and block primitives, owned-only                                      */
/* -------------------------------------------------------------------------- */

/**
 * Points `linkPath` at `target`, and leaves anything that is not ours alone.
 *
 * A real file or directory the user put at a discovery path is never replaced.
 * That rule is the whole reason this is safe to run on every app start.
 */
export async function ensureSkillLink(
  linkPath: string,
  target: string,
): Promise<boolean> {
  await ensureDirectory(dirname(linkPath));
  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) return false;
    const existing = resolve(dirname(linkPath), await readlink(linkPath));
    if (existing === target) return true;
    // Ours, pointing somewhere stale: a renamed home, or an older layout.
    if (basename(existing) === basename(target)) {
      await unlink(linkPath);
      await symlink(target, linkPath, "dir");
      return true;
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(target, linkPath, "dir");
  return true;
}

/** Removes `linkPath` only when it is a symlink pointing at `target`. */
export async function removeSkillLink(
  linkPath: string,
  target: string,
): Promise<void> {
  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) return;
    const existing = resolve(dirname(linkPath), await readlink(linkPath));
    if (existing === target) await unlink(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** True when the path is a symlink to `target`. */
export async function linkPointsAt(
  linkPath: string,
  target: string,
): Promise<boolean> {
  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) return false;
    return resolve(dirname(linkPath), await readlink(linkPath)) === target;
  } catch {
    return false;
  }
}

/** True when something that is not our link already occupies the path. */
async function occupiedByOther(
  linkPath: string,
  target: string,
): Promise<boolean> {
  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) return true;
    return resolve(dirname(linkPath), await readlink(linkPath)) !== target;
  } catch {
    return false;
  }
}

/**
 * Writes a file atomically, so a crash mid-write cannot leave a provider
 * reading half a skill.
 */
async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Splices a marked block into a file, replacing any previous one in place. */
export function mergeMarkedBlock(
  existing: string,
  block: string,
  markers: { begin: string; end: string },
): string {
  const begin = existing.indexOf(markers.begin);
  const end = existing.indexOf(markers.end);
  if (begin !== -1 && end > begin)
    return `${existing.slice(0, begin)}${block}${existing.slice(end + markers.end.length)}`;
  const body = existing.replace(/\s+$/, "");
  return body ? `${body}\n\n${block}\n` : `${block}\n`;
}

/** Cuts a marked block out of a file, leaving everything else byte for byte. */
export function removeMarkedBlock(
  existing: string,
  markers: { begin: string; end: string },
): string {
  const begin = existing.indexOf(markers.begin);
  const end = existing.indexOf(markers.end);
  if (begin === -1 || end <= begin) return existing;
  const before = existing.slice(0, begin).replace(/\n+$/, "");
  const after = existing.slice(end + markers.end.length).replace(/^\n+/, "");
  if (!before) return after;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}

/* -------------------------------------------------------------------------- */
/* Reported shapes                                                            */
/* -------------------------------------------------------------------------- */

export interface ManagedArtifactStatus {
  kind: SkillArtifactKind;
  path: string;
  /** Installed and owned by Daedalus. */
  present: boolean;
  /** Something that is not ours sits here, so Daedalus left it alone. */
  blocked: boolean;
}

export interface ManagedSkillStatus {
  id: string;
  title: string;
  summary: string;
  supportsAlways: boolean;
  enabled: boolean;
  mode: ManagedSkillMode;
  /** Absent for a built-in capability. */
  source?: { kind: "path" | "git"; ref: string; subpath?: string };
  artifacts: ManagedArtifactStatus[];
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** The `SKILL.md` itself, which is the path a provider is told about. */
  skillPath: string;
  providers: SkillProvider[];
  origin: SkillOrigin;
  source: SkillSource;
  /** The directory the skill was found in, which is the group it belongs to. */
  sourcePath: string;
  /** The plugin's name, when this source is one plugin rather than a provider. */
  sourceName?: string;
  invocation: SkillInvocation;
  visibility: SkillVisibility;
  /** Set when this is a link to a skill Daedalus manages. */
  managedId?: string;
  problem?: SkillProblem;
}

export interface SkillListing {
  managed: ManagedSkillStatus[];
  discovered: DiscoveredSkill[];
}

export interface SkillContent {
  path: string;
  content: string;
  /** True when the file was longer than the app is willing to hand over. */
  truncated: boolean;
}

export interface SkillDoctorFinding {
  level: "ok" | "warn";
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

interface ScanRoot {
  path: string;
  providers: SkillProvider[];
  origin: SkillOrigin;
  source: SkillSource;
  /**
   * What to call this particular directory, when the kind alone does not say
   * it. Every plugin is its own source, so "Claude plugin" would name several
   * different places the same thing.
   */
  sourceName?: string;
}

function scanRoots(config: DaedalusConfig): ScanRoot[] {
  return [
    {
      path: join(config.claudeHome, "skills"),
      providers: ["claude"],
      origin: "user",
      source: "claude-personal",
    },
    {
      path: join(config.agentsHome, "skills"),
      providers: ["codex", "cursor"],
      origin: "user",
      source: "agents-personal",
    },
    {
      path: join(config.cursorHome, "skills"),
      providers: ["cursor"],
      origin: "user",
      source: "cursor-personal",
    },
  ];
}

async function directoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

/**
 * Plugin skills, found at `<plugins>/<plugin>/skills/<name>` and one level
 * deeper for a marketplace layout. Two fixed depths rather than a recursive
 * walk, because an unbounded walk of a user's home is a cost with no ceiling.
 */
async function pluginRoots(config: DaedalusConfig): Promise<ScanRoot[]> {
  const base = join(config.claudeHome, "plugins");
  const roots: ScanRoot[] = [];
  for (const first of await directoryNames(base)) {
    const firstPath = join(base, first);
    if (await pathExists(join(firstPath, "skills")))
      roots.push({
        path: join(firstPath, "skills"),
        providers: ["claude"],
        origin: "plugin",
        source: "claude-plugin",
        sourceName: first,
      });
    for (const second of await directoryNames(firstPath)) {
      if (second === "skills") continue;
      const secondPath = join(firstPath, second, "skills");
      if (await pathExists(secondPath))
        // A marketplace layout nests the plugin under its marketplace. The
        // plugin is what the user installed, so the plugin is the name.
        roots.push({
          path: secondPath,
          providers: ["claude"],
          origin: "plugin",
          source: "claude-plugin",
          sourceName: second,
        });
    }
  }
  return roots;
}

async function readDiscoveredSkill(
  config: DaedalusConfig,
  root: ScanRoot,
  name: string,
): Promise<DiscoveredSkill | undefined> {
  const directory = join(root.path, name);
  const skillPath = join(directory, "SKILL.md");
  const managedRoot = join(config.home, "skills");
  let managedId: string | undefined;
  let broken = false;
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) {
      const target = resolve(dirname(directory), await readlink(directory));
      if (isPathInside(managedRoot, target)) managedId = basename(target);
      if (!(await pathExists(target))) broken = true;
    }
  } catch {
    return undefined;
  }
  if (broken)
    return {
      name,
      description: "",
      skillPath,
      providers: root.providers,
      origin: managedId ? "daedalus" : root.origin,
      source: root.source,
      sourcePath: root.path,
      ...(root.sourceName ? { sourceName: root.sourceName } : {}),
      invocation: "auto",
      visibility: config.skillOverrides[name] ?? "on",
      ...(managedId ? { managedId } : {}),
      problem: "broken-link",
    };
  let text: string;
  try {
    text = await readFile(skillPath, "utf8");
  } catch {
    return undefined;
  }
  const frontmatter = parseSkillFrontmatter(text);
  const origin: SkillOrigin = managedId ? "daedalus" : root.origin;
  const visibility = config.skillOverrides[name] ?? "on";
  if (!frontmatter)
    return {
      name,
      description: "",
      skillPath,
      providers: root.providers,
      origin,
      source: root.source,
      sourcePath: root.path,
      ...(root.sourceName ? { sourceName: root.sourceName } : {}),
      invocation: "auto",
      visibility,
      ...(managedId ? { managedId } : {}),
      problem: "unreadable-frontmatter",
    };
  const declared = frontmatter.name;
  const problem: SkillProblem | undefined =
    declared && declared !== name ? "name-mismatch" : undefined;
  return {
    name,
    description: frontmatter.description ?? "",
    skillPath,
    providers: root.providers,
    origin,
    source: root.source,
    sourcePath: root.path,
    ...(root.sourceName ? { sourceName: root.sourceName } : {}),
    invocation: invocationOf(frontmatter),
    visibility,
    ...(managedId ? { managedId } : {}),
    ...(problem ? { problem } : {}),
  };
}

/**
 * Every skill the providers can see, from the personal and plugin locations.
 *
 * Project-scoped directories are left out on purpose: the system is global, so
 * reporting a skill that only exists inside one checkout would be answering a
 * question nobody asked here.
 *
 * A name found under more than one root is reported once per root rather than
 * merged, because that is what the providers themselves do with a collision.
 */
export async function discoverSkills(
  config: DaedalusConfig,
): Promise<DiscoveredSkill[]> {
  const roots = [...scanRoots(config), ...(await pluginRoots(config))];
  const found: DiscoveredSkill[] = [];
  for (const root of roots)
    for (const name of await directoryNames(root.path)) {
      const skill = await readDiscoveredSkill(config, root, name);
      if (skill) found.push(skill);
    }
  return found.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.skillPath.localeCompare(right.skillPath),
  );
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

export class SkillService {
  constructor(private readonly config: DaedalusConfig) {}

  /** A capability's state, falling back to its own default. */
  settingFor(id: string): ManagedSkillSetting {
    const stored = this.config.managedSkills[id];
    if (stored) return stored;
    const definition = managedDefinition(id);
    return {
      enabled: definition?.defaultEnabled ?? false,
      mode: definition?.defaultMode ?? "on-demand",
    };
  }

  /** Built-ins, plus anything the user installed. */
  private definitions(): ManagedSkillDefinition[] {
    const installed = Object.entries(this.config.managedSkills)
      .filter(([, setting]) => setting.source)
      .filter(([id]) => !managedDefinition(id))
      .map(([id]) => ({
        id,
        title: id,
        summary: "Installed by you.",
        supportsAlways: false,
        defaultEnabled: true,
        defaultMode: "on-demand" as ManagedSkillMode,
        skillFiles: [],
      }));
    return [...MANAGED_SKILLS, ...installed];
  }

  /**
   * A capability's names and file contents for *this* channel.
   *
   * Every install and removal site goes through this, so the name a link is
   * created under can never drift from the name it is removed under.
   */
  private resolve(definition: ManagedSkillDefinition): {
    id: string;
    linkName: string;
    skillFiles: ManagedFile[];
    style?: { fileName: string; styleName: string; contents: string };
  } {
    const linkName = channelArtifactName(this.config, definition.id);
    const skillFiles =
      linkName === definition.id
        ? definition.skillFiles
        : definition.skillFiles.map((file) =>
            file.path === "SKILL.md"
              ? {
                  ...file,
                  contents: withFrontmatterName(file.contents, linkName),
                }
              : file,
          );
    if (!definition.style) return { id: definition.id, linkName, skillFiles };
    const styleName = channelArtifactName(
      this.config,
      definition.style.styleName,
    );
    return {
      id: definition.id,
      linkName,
      skillFiles,
      style: {
        fileName: `${styleName}.md`,
        styleName,
        contents:
          styleName === definition.style.styleName
            ? definition.style.contents
            : withFrontmatterName(definition.style.contents, styleName),
      },
    };
  }

  private styleWanted(definition: ManagedSkillDefinition): boolean {
    const setting = this.settingFor(definition.id);
    return Boolean(
      definition.style &&
      setting.enabled &&
      definition.supportsAlways &&
      (setting.mode ?? definition.defaultMode) === "always",
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Sync                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Brings the filesystem in line with the stored state.
   *
   * Idempotent, and safe to run on every app start. It only ever creates its
   * own links and only ever removes its own links, so a user's real file at a
   * discovery path survives both directions.
   */
  async sync(): Promise<void> {
    for (const definition of this.definitions()) {
      const setting = this.settingFor(definition.id);
      if (setting.enabled) await this.installArtifacts(definition);
      else await this.removeArtifacts(definition);
    }
    await this.cleanRemovedInstalls();
    await this.syncClaudeSettings();
  }

  private async installArtifacts(
    definition: ManagedSkillDefinition,
  ): Promise<void> {
    const resolved = this.resolve(definition);
    const target = managedSkillPath(this.config, definition.id);
    // A built-in rewrites its canonical copy every time, so a Daedalus upgrade
    // ships new skill text without the user reinstalling anything. An
    // installed skill has no bundled text and keeps whatever was copied in.
    for (const file of resolved.skillFiles)
      await writeFileAtomic(join(target, file.path), file.contents);
    if (!(await pathExists(target))) return;
    for (const { path } of skillLinkPaths(this.config, resolved.linkName))
      await ensureSkillLink(path, target);
    if (!resolved.style) return;
    const stylePath = managedStylePath(this.config, resolved.style.fileName);
    const styleLink = styleLinkPath(this.config, resolved.style.fileName);
    if (this.styleWanted(definition)) {
      await writeFileAtomic(stylePath, resolved.style.contents);
      await ensureSkillLink(styleLink, stylePath);
      await this.writeInstructionsBlock(definition);
    } else {
      await removeSkillLink(styleLink, stylePath);
      await this.clearInstructionsBlock(definition);
    }
  }

  private async removeArtifacts(
    definition: ManagedSkillDefinition,
  ): Promise<void> {
    const resolved = this.resolve(definition);
    const target = managedSkillPath(this.config, definition.id);
    for (const { path } of skillLinkPaths(this.config, resolved.linkName))
      await removeSkillLink(path, target);
    if (!resolved.style) return;
    await removeSkillLink(
      styleLinkPath(this.config, resolved.style.fileName),
      managedStylePath(this.config, resolved.style.fileName),
    );
    await this.clearInstructionsBlock(definition);
  }

  /**
   * The rules as a block inside the user's own `~/.codex/AGENTS.md`.
   *
   * Codex and Cursor have no output style, so an always-read instruction file
   * is the closest thing either one offers. The block is fenced by markers and
   * only ever replaced or cut between them, so the rest of a file the user
   * wrote survives byte for byte.
   */
  private async writeInstructionsBlock(
    definition: ManagedSkillDefinition,
  ): Promise<void> {
    const resolved = this.resolve(definition);
    if (!resolved.style) return;
    const path = codexInstructionsPath(this.config);
    const markers = instructionsMarkers(
      channelName(this.config.home),
      definition.id,
    );
    const block = [
      markers.begin,
      `<!-- Turn this off with: daedal skill disable ${definition.id} -->`,
      "",
      styleBody(resolved.style.contents),
      "",
      markers.end,
    ].join("\n");
    const existing = (await pathExists(path))
      ? await readFile(path, "utf8")
      : "";
    const merged = mergeMarkedBlock(existing, block, markers);
    if (merged !== existing) await writeFileAtomic(path, merged);
  }

  private async clearInstructionsBlock(
    definition: ManagedSkillDefinition,
  ): Promise<void> {
    const path = codexInstructionsPath(this.config);
    if (!(await pathExists(path))) return;
    const markers = instructionsMarkers(
      channelName(this.config.home),
      definition.id,
    );
    const existing = await readFile(path, "utf8");
    const cleared = removeMarkedBlock(existing, markers);
    if (cleared !== existing) await writeFileAtomic(path, cleared);
  }

  /**
   * Drops links for a skill that was installed and then removed from the
   * config, which is the only way a dangling link outlives its owner.
   */
  private async cleanRemovedInstalls(): Promise<void> {
    const known = new Set(this.definitions().map((one) => one.id));
    const root = join(this.config.home, "skills");
    for (const id of await directoryNames(root)) {
      if (known.has(id)) continue;
      for (const { path } of skillLinkPaths(
        this.config,
        channelArtifactName(this.config, id),
      ))
        await removeSkillLink(path, join(root, id));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                 */
  /* ---------------------------------------------------------------------- */

  async managedStatus(): Promise<ManagedSkillStatus[]> {
    const statuses: ManagedSkillStatus[] = [];
    for (const definition of this.definitions()) {
      const setting = this.settingFor(definition.id);
      const resolved = this.resolve(definition);
      const target = managedSkillPath(this.config, definition.id);
      const artifacts: ManagedArtifactStatus[] = [];
      for (const { path } of skillLinkPaths(this.config, resolved.linkName))
        artifacts.push({
          kind: "skill",
          path,
          present: await linkPointsAt(path, target),
          blocked: await occupiedByOther(path, target),
        });
      if (resolved.style) {
        const stylePath = managedStylePath(
          this.config,
          resolved.style.fileName,
        );
        const link = styleLinkPath(this.config, resolved.style.fileName);
        artifacts.push({
          kind: "style",
          path: link,
          present: await linkPointsAt(link, stylePath),
          blocked: await occupiedByOther(link, stylePath),
        });
        const instructions = codexInstructionsPath(this.config);
        const markers = instructionsMarkers(
          channelName(this.config.home),
          definition.id,
        );
        const contents = (await pathExists(instructions))
          ? await readFile(instructions, "utf8")
          : "";
        artifacts.push({
          kind: "instructions",
          path: instructions,
          present: contents.includes(markers.begin),
          blocked: false,
        });
        // Installing a style only makes it available. Claude runs one at a
        // time, so if the user has their own selected, Daedalus leaves it and
        // the rules are not actually applying. Without this row that failure
        // looks exactly like success.
        if (this.styleWanted(definition)) {
          const selected = await this.selectedClaudeStyle();
          artifacts.push({
            kind: "selection",
            path: claudeSettingsPath(this.config),
            present: selected === resolved.style.styleName,
            blocked:
              selected !== undefined && selected !== resolved.style.styleName,
          });
        }
      }
      statuses.push({
        id: definition.id,
        title: definition.title,
        summary: definition.summary,
        supportsAlways: definition.supportsAlways,
        enabled: setting.enabled,
        mode: setting.mode ?? definition.defaultMode,
        ...(setting.source ? { source: setting.source } : {}),
        artifacts,
      });
    }
    return statuses;
  }

  async list(): Promise<SkillListing> {
    const [managed, discovered] = await Promise.all([
      this.managedStatus(),
      discoverSkills(this.config),
    ]);
    return { managed, discovered };
  }

  async get(name: string): Promise<{
    managed?: ManagedSkillStatus;
    discovered: DiscoveredSkill[];
  }> {
    const { managed, discovered } = await this.list();
    const mine = managed.find((one) => one.id === name);
    const theirs = discovered.filter((one) => one.name === name);
    if (!mine && theirs.length === 0)
      throw new DaedalusError("NOT_FOUND", `No skill named '${name}'`);
    return { ...(mine ? { managed: mine } : {}), discovered: theirs };
  }

  /**
   * The text of one discovered `SKILL.md`.
   *
   * The path has to be one discovery just reported, not any path the caller
   * cares to name. The renderer is an adapter and this arrives over RPC, so
   * without that check the panel would be a general-purpose file reader with a
   * skill-shaped label on it.
   */
  async readSkill(skillPath: string): Promise<SkillContent> {
    const discovered = await discoverSkills(this.config);
    if (!discovered.some((skill) => skill.skillPath === skillPath))
      throw new DaedalusError(
        "NOT_FOUND",
        `No skill is installed at ${skillPath}`,
      );
    const raw = await readFile(skillPath, "utf8").catch(() => undefined);
    if (raw === undefined)
      throw new DaedalusError("NOT_FOUND", `Could not read ${skillPath}`);
    const truncated = raw.length > MAX_SKILL_CONTENT;
    return {
      path: skillPath,
      content: truncated ? raw.slice(0, MAX_SKILL_CONTENT) : raw,
      truncated,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Writing                                                                 */
  /* ---------------------------------------------------------------------- */

  async setEnabled(
    id: string,
    enabled: boolean,
    mode?: ManagedSkillMode,
  ): Promise<ManagedSkillStatus> {
    const definition = this.definitions().find((one) => one.id === id);
    if (!definition)
      throw new DaedalusError(
        "NOT_FOUND",
        `No Daedalus-managed skill named '${id}'`,
      );
    if (mode === "always" && !definition.supportsAlways)
      throw new DaedalusError(
        "VALIDATION",
        `Skill '${id}' has no 'always' mode`,
      );
    const previous = this.settingFor(id);
    await saveManagedSkillSetting(this.config, id, {
      ...previous,
      enabled,
      mode: mode ?? previous.mode ?? definition.defaultMode,
    });
    await this.sync();
    const status = (await this.managedStatus()).find((one) => one.id === id);
    if (!status)
      throw new DaedalusError(
        "INTERNAL",
        `Skill '${id}' vanished while saving`,
      );
    return status;
  }

  async setVisibility(
    name: string,
    visibility: SkillVisibility,
  ): Promise<{ name: string; visibility: SkillVisibility }> {
    const discovered = await discoverSkills(this.config);
    if (!discovered.some((one) => one.name === name))
      throw new DaedalusError("NOT_FOUND", `No skill named '${name}'`);
    await saveSkillOverride(this.config, name, visibility);
    await this.syncClaudeSettings();
    return { name, visibility };
  }

  /**
   * Writes Daedalus's two contributions into the user's own Claude settings.
   *
   * This is the one place Daedalus edits `~/.claude/settings.json`, and it is
   * what makes both the skill switches and the writing style mean every Claude
   * session rather than only the ones Daedalus starts. The launch argument
   * still carries the same two, so a Daedalus session is covered even when
   * this write cannot happen.
   *
   * The care here is the care the Codex block already takes, minus the one
   * thing JSON cannot do. There is no comment to fence a block with, so what
   * Daedalus owns is what it wrote down having written. A value the user set
   * themselves is never removed or replaced, and every other setting in the
   * file is carried across untouched.
   */
  async syncClaudeSettings(): Promise<void> {
    const path = claudeSettingsPath(this.config);
    const ours = this.config.skillOverrides;
    const written = this.config.claudeOverridesWritten;
    const wantedStyle = this.claudeSkillSettings().outputStyle;
    const writtenStyle = this.config.claudeOutputStyleWritten;
    const exists = await pathExists(path);
    // Nothing of ours to say and nothing of ours to take back. Creating a
    // settings file the user never had, to hold no settings, would be a change
    // to their setup in exchange for nothing.
    if (
      !exists &&
      Object.keys(ours).length === 0 &&
      wantedStyle === undefined
    ) {
      if (written.length) await saveClaudeOverridesWritten(this.config, []);
      if (writtenStyle !== undefined)
        await saveClaudeOutputStyleWritten(this.config, undefined);
      return;
    }
    const raw = exists ? await readFile(path, "utf8") : "";
    let existing: Record<string, unknown>;
    try {
      existing = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      // A settings file Daedalus cannot parse is the user's to repair. Editing
      // it would mean replacing something it could not read.
      return;
    }
    const overrides: Record<string, unknown> = {
      ...((existing.skillOverrides as Record<string, unknown>) ?? {}),
    };
    for (const name of written)
      if (!(name in ours) && overrides[name] === "off") delete overrides[name];
    for (const [name, visibility] of Object.entries(ours))
      overrides[name] = visibility;
    const next = { ...existing };
    if (Object.keys(overrides).length) next.skillOverrides = overrides;
    else delete next.skillOverrides;

    // One style is active at a time, so selecting ours means taking whatever
    // was selected before. A style the user chose is theirs: Daedalus sets its
    // own only into an empty slot or over its own previous choice, and gives
    // the slot back the same way.
    const currentStyle = existing.outputStyle;
    let selectedStyle: string | undefined;
    if (wantedStyle !== undefined) {
      if (currentStyle === undefined || currentStyle === writtenStyle) {
        next.outputStyle = wantedStyle;
        selectedStyle = wantedStyle;
      } else if (currentStyle === wantedStyle) selectedStyle = wantedStyle;
    } else if (writtenStyle !== undefined && currentStyle === writtenStyle)
      delete next.outputStyle;

    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (serialized !== raw) {
      await ensureDirectory(dirname(path));
      const backup = `${path}.daedalus-backup`;
      if (raw && !(await pathExists(backup)))
        await writeFile(backup, raw, { encoding: "utf8", mode: 0o600 });
      await writeFileAtomic(path, serialized);
    }
    const names = Object.keys(ours);
    if (
      names.length !== written.length ||
      names.some((name) => !written.includes(name))
    )
      await saveClaudeOverridesWritten(this.config, names);
    if (selectedStyle !== writtenStyle)
      await saveClaudeOutputStyleWritten(this.config, selectedStyle);
  }

  /** The style Claude is actually set to use, from the user's own settings. */
  private async selectedClaudeStyle(): Promise<string | undefined> {
    const path = claudeSettingsPath(this.config);
    if (!(await pathExists(path))) return undefined;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        outputStyle?: unknown;
      };
      return typeof parsed.outputStyle === "string"
        ? parsed.outputStyle
        : undefined;
    } catch {
      return undefined;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Installing                                                              */
  /* ---------------------------------------------------------------------- */

  private assertInstallableName(name: string): void {
    if (!SKILL_NAME.test(name))
      throw new DaedalusError(
        "VALIDATION",
        `Skill name '${name}' must be lowercase letters, digits, and hyphens`,
      );
    if (managedDefinition(name))
      throw new DaedalusError(
        "CONFLICT",
        `'${name}' is a skill Daedalus ships; enable it instead of installing over it`,
      );
  }

  /** Copies a skill package into the canonical store and links it. */
  async installFromPath(
    source: string,
    name?: string,
  ): Promise<ManagedSkillStatus> {
    const from = resolve(source);
    const skillFile = join(from, "SKILL.md");
    if (!(await pathExists(skillFile)))
      throw new DaedalusError(
        "NOT_FOUND",
        `No SKILL.md in ${from}. Point --path at the skill's own directory.`,
      );
    const frontmatter = parseSkillFrontmatter(
      await readFile(skillFile, "utf8"),
    );
    const resolved = name ?? frontmatter?.name ?? basename(from);
    this.assertInstallableName(resolved);
    const target = managedSkillPath(this.config, resolved);
    await rm(target, { recursive: true, force: true });
    await ensureDirectory(dirname(target));
    await copyTree(from, target);
    await saveManagedSkillSetting(this.config, resolved, {
      enabled: true,
      mode: "on-demand",
      source: { kind: "path", ref: from },
    });
    await this.sync();
    const status = (await this.managedStatus()).find(
      (one) => one.id === resolved,
    );
    if (!status)
      throw new DaedalusError(
        "INTERNAL",
        `Install of '${resolved}' did not land`,
      );
    return status;
  }

  /**
   * Clones a repository shallowly into a temporary directory and installs one
   * subdirectory from it.
   *
   * The clone is shallow and thrown away, because the repository is a delivery
   * route rather than something to keep in sync. Re-running the command is how
   * an update happens, which is also what makes the stored source useful.
   */
  async installFromGit(
    url: string,
    subpath: string,
    name?: string,
  ): Promise<ManagedSkillStatus> {
    const git = findExecutable("git", GIT_EXECUTABLE_FALLBACKS);
    if (!git) throw new DaedalusError("DEPENDENCY", "git is not installed");
    const scratch = join(tmpdir(), `daedalus-skill-${crypto.randomUUID()}`);
    try {
      await mkdir(scratch, { recursive: true });
      const clone = await runCommand(git, [
        "clone",
        "--depth",
        "1",
        url,
        scratch,
      ]);
      if (clone.exitCode !== 0)
        throw new DaedalusError("INTERNAL", `Could not clone ${url}`, {
          stderr: clone.stderr.trim(),
        });
      const from = join(scratch, subpath);
      if (!isPathInside(scratch, resolve(from)))
        throw new DaedalusError(
          "VALIDATION",
          "--path must stay inside the repository",
        );
      const status = await this.installFromPath(from, name);
      await saveManagedSkillSetting(this.config, status.id, {
        ...this.settingFor(status.id),
        source: { kind: "git", ref: url, subpath },
      });
      return status;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Removes an installed skill, its links, and its state. */
  async removeInstalled(name: string): Promise<{ removed: string }> {
    const setting = this.config.managedSkills[name];
    if (!setting?.source)
      throw new DaedalusError(
        managedDefinition(name) ? "CONFLICT" : "NOT_FOUND",
        managedDefinition(name)
          ? `'${name}' is a skill Daedalus ships; disable it instead of removing it`
          : `No installed skill named '${name}'`,
      );
    const target = managedSkillPath(this.config, name);
    for (const { path } of skillLinkPaths(
      this.config,
      channelArtifactName(this.config, name),
    ))
      await removeSkillLink(path, target);
    await rm(target, { recursive: true, force: true });
    const managedSkills = { ...this.config.managedSkills };
    delete managedSkills[name];
    this.config.managedSkills = managedSkills;
    await persistManagedSkills(this.config);
    return { removed: name };
  }

  /* ---------------------------------------------------------------------- */
  /* Doctor                                                                  */
  /* ---------------------------------------------------------------------- */

  async doctor(): Promise<SkillDoctorFinding[]> {
    const findings: SkillDoctorFinding[] = [];
    const { managed, discovered } = await this.list();
    for (const skill of managed) {
      if (!skill.enabled) continue;
      for (const artifact of skill.artifacts) {
        if (artifact.blocked)
          findings.push({
            level: "warn",
            message: `${skill.id}: something that is not Daedalus's sits at ${artifact.path}, so it was left alone`,
          });
        else if (!artifact.present)
          findings.push({
            level: "warn",
            message: `${skill.id}: ${artifact.kind} is missing at ${artifact.path}. Run 'daedal skill sync'.`,
          });
      }
    }
    for (const skill of discovered)
      if (skill.problem)
        findings.push({
          level: "warn",
          message: `${skill.name}: ${skill.problem.replace(/-/g, " ")} at ${skill.skillPath}`,
        });
    // A collision is two *different* skills answering to one name, not one
    // skill linked into two provider directories, which is what every managed
    // skill looks like from here. Identity is the file each link resolves to.
    const identities = new Map<string, Set<string>>();
    for (const skill of discovered) {
      const identity = skill.managedId
        ? `managed:${skill.managedId}`
        : await canonicalPath(skill.skillPath).catch(() => skill.skillPath);
      const seen = identities.get(skill.name) ?? new Set<string>();
      seen.add(identity);
      identities.set(skill.name, seen);
    }
    for (const [name, seen] of identities)
      if (seen.size > 1)
        findings.push({
          level: "warn",
          message: `${name}: ${seen.size} different skills answer to this name. Providers list a collision twice rather than merging it.`,
        });
    if (Object.keys(this.config.skillOverrides).length)
      findings.push({
        level: "ok",
        message:
          "Codex applies skill overrides only after it restarts, and they are global.",
      });
    if (!findings.some((finding) => finding.level === "warn"))
      findings.push({
        level: "ok",
        message: "Every managed skill is in place.",
      });
    return findings;
  }

  /* ---------------------------------------------------------------------- */
  /* What the providers are told at launch                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * The settings Daedalus contributes to a Claude launch.
   *
   * `outputStyle` is what actually turns the writing rules on. Installing the
   * style file only makes it available; a style applies when it is selected,
   * and selecting it here rather than in the user's own settings file keeps
   * the change to sessions Daedalus starts.
   */
  claudeSkillSettings(): {
    outputStyle?: string;
    skillOverrides?: Record<string, SkillVisibility>;
  } {
    const definition = MANAGED_SKILLS.find(
      (one) => one.style && this.styleWanted(one),
    );
    const style = definition ? this.resolve(definition).style : undefined;
    const overrides = this.config.skillOverrides;
    return {
      ...(style ? { outputStyle: style.styleName } : {}),
      ...(Object.keys(overrides).length
        ? { skillOverrides: { ...overrides } }
        : {}),
    };
  }

  /**
   * The `[[skills.config]]` entries for skills the user turned off.
   *
   * Only skills Codex itself scans. A skill under `~/.cursor/skills` is read
   * by Cursor and by nothing else, so an entry for it in `~/.codex/config.toml`
   * would name a path Codex never loads and would look, in the file, like a
   * setting that was doing something.
   */
  async codexSkillEntries(): Promise<Array<{ path: string; enabled: false }>> {
    const off = Object.entries(this.config.skillOverrides)
      .filter(([, visibility]) => visibility === "off")
      .map(([name]) => name);
    if (!off.length) return [];
    const discovered = await discoverSkills(this.config);
    return discovered
      .filter(
        (skill) =>
          off.includes(skill.name) && skill.providers.includes("codex"),
      )
      .map((skill) => ({ path: skill.skillPath, enabled: false as const }));
  }
}

/** Rewrites the whole managed-skill map, including deletions. */
async function persistManagedSkills(config: DaedalusConfig): Promise<void> {
  const configPath = join(config.home, "config.json");
  const file = Bun.file(configPath);
  const stored = (await file.exists())
    ? ((await file.json()) as Record<string, unknown>)
    : {};
  await writeFileAtomic(
    configPath,
    `${JSON.stringify({ ...stored, managedSkills: config.managedSkills }, null, 2)}\n`,
  );
}

/** A plain recursive copy. Symlinks inside a skill package are not followed. */
async function copyTree(from: string, to: string): Promise<void> {
  await ensureDirectory(to);
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, destination);
    else if (entry.isFile())
      await writeFile(destination, await readFile(source));
  }
}

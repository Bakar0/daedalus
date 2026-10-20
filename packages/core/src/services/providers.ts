import { ensureInbox, INBOX_HOOK_MARKER, inboxHook } from "./session-inbox";
import {
  ensureDirectory,
  findExecutable,
  knownLoginShellPath,
  loginShellPath,
  standardExecutableFallbacks,
} from "@daedalus/platform";
import { runCommand } from "@daedalus/platform";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  channelName,
  type AgentDefinition,
  type AgentPermissionMode,
  type DaedalusConfig,
} from "../config";
import { DaedalusError } from "../errors";
import { claudeSettingsPath, SkillService } from "./skills";
import {
  codexSupportsHooks,
  daedalusClaudeSettings,
  type ClaudeSettings,
  mergeClaudeSettings,
  mergeCodexConfigToml,
  parseClaudeSettingsArgument,
  renderCodexHookBlock,
} from "./hook-install";

export interface LaunchInput {
  prompt?: string;
  taskId?: string;
  sessionId?: string;
  sessionName?: string;
  additionalDirectories?: string[];
  model?: string;
  /** A team lead or member: Claude accepts messages from other sessions. */
  acceptPeerMessages?: boolean;
}

export interface ProviderLaunch {
  executable: string;
  args: string[];
  env: Record<string, string>;
  providerSessionId?: string;
}

export interface ProviderModelCatalog {
  provider: "codex" | "claude";
  defaultModel?: string;
  models: Array<{
    id: string;
    label: string;
    resolvedModel?: string;
    description?: string;
  }>;
  source: "provider" | "aliases";
}

export const CODEX_DAEDALUS_TUI_ARGS = [
  "--no-alt-screen",
  "-c",
  "tui.disable_mouse_capture=true",
  // Codex's startup update offer runs the update and then quits, which ends
  // the session and leaves its terminal blank. Updating is the user's to do
  // outside a session.
  "-c",
  "check_for_update_on_startup=false",
] as const;

/**
 * The sink every hook and the status line call.
 *
 * Deliberately the shim inside *this* home rather than whatever `daedal` is on
 * `PATH`. The channels exist so a dev build and the stable build are two
 * applications, and a hook injected by one that ran the other's CLI would be
 * the same confusion arriving through a different door. If the shim is not
 * installed the hook simply fails, silently, which is what an observational
 * hook is supposed to do.
 */
export function daedalExecutable(config: DaedalusConfig): string {
  return join(config.home, "bin", "daedal");
}

const settingsArgumentValue = (args: string[]): string | undefined => {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const argument = args[index]!;
    if (argument.startsWith("--settings="))
      return argument.slice("--settings=".length);
    if (argument === "--settings") return args[index + 1];
  }
  return undefined;
};

const withoutSettingsArgument = (args: string[]): string[] => {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument.startsWith("--settings=")) continue;
    if (argument === "--settings") {
      index += 1;
      continue;
    }
    kept.push(argument);
  }
  return kept;
};

/**
 * Claude's launch arguments with the Daedalus status line and activity hooks
 * folded in.
 *
 * This replaces the previous all-or-nothing rule, which injected nothing at
 * all when the user supplied their own `--settings` — costing them the status
 * line to protect a setting Daedalus was never going to overwrite. The user's
 * settings are parsed, Daedalus's own stale hook entries are stripped, and the
 * two are merged with every conflict resolved in the user's favour.
 *
 * The one case that still degrades is a `--settings` value that is neither
 * readable JSON nor a readable file: it is left exactly as the user wrote it
 * and activity falls back to `unknown`.
 */
export async function claudeDaedalusSettingsArgs(
  config: DaedalusConfig,
  existingArgs: string[],
  sessionId?: string,
  options: { acceptPeerMessages?: boolean } = {},
): Promise<string[]> {
  // Every Claude session gets an inbox, so routines granted later reach it
  // without typing. A pipe that cannot be made leaves the session without
  // one; delivery then falls back to typing.
  const inbox = sessionId
    ? await ensureInbox(config, sessionId)
        .then(() => inboxHook(config, sessionId))
        .catch(() => undefined)
    : undefined;
  // The skill system contributes two keys here: `outputStyle`, which is what
  // actually turns an installed writing style on, and `skillOverrides` for
  // skills the user switched off. Both ride the settings argument Daedalus
  // already passes, so neither one edits the user's own settings file.
  const daedalus: ClaudeSettings = {
    ...daedalusClaudeSettings(daedalExecutable(config), sessionId, {
      ...options,
      ...(inbox ? { inboxHook: inbox } : {}),
    }),
    ...new SkillService(config).claudeSkillSettings(),
  };
  const existingValue = settingsArgumentValue(existingArgs);
  const parsed =
    existingValue === undefined
      ? undefined
      : await parseClaudeSettingsArgument(existingValue);
  if (existingValue !== undefined && !parsed) return [...existingArgs];
  const merged = parsed ? mergeClaudeSettings(parsed, daedalus) : daedalus;
  // Settings passed here override the user's own file, so the renderer is
  // only a default: a user who chose one in either place keeps it.
  const settings =
    "tui" in merged || (await userSetsClaudeRenderer(config))
      ? merged
      : { ...merged, tui: CLAUDE_DEFAULT_RENDERER };
  return [
    ...withoutSettingsArgument(existingArgs),
    "--settings",
    sessionId
      ? await writeClaudeSettingsFile(config, sessionId, settings, {
          inbox: Boolean(inbox),
        })
      : JSON.stringify(settings),
  ];
}

/**
 * The renderer a Claude session starts with when the user has not picked one.
 * Fullscreen draws in the alternate screen without flicker and scrolls its own
 * transcript; the Daedalus terminal's tmux passes it the mouse wheel.
 */
export const CLAUDE_DEFAULT_RENDERER = "fullscreen";

/** Whether the user's own Claude settings choose a renderer. */
async function userSetsClaudeRenderer(
  config: DaedalusConfig,
): Promise<boolean> {
  const settings = await parseClaudeSettingsArgument(
    claudeSettingsPath(config),
  );
  return settings !== undefined && "tui" in settings;
}

/**
 * Where a session's Claude settings are written. The name carries the inbox
 * marker when the inbox hook is inside, so `usesInbox` still finds it in the
 * launch arguments without reading the file.
 */
export const sessionClaudeSettingsPath = (
  config: DaedalusConfig,
  sessionId: string,
  options: { inbox: boolean },
): string =>
  join(
    config.home,
    "claude-settings",
    options.inbox
      ? `${sessionId}.${INBOX_HOOK_MARKER}.json`
      : `${sessionId}.json`,
  );

/**
 * Writes the settings to a file and returns its path, which Claude's
 * `--settings` takes in place of the JSON. Passed inline, the hooks are about
 * 4 KB of the launch command, and tmux refuses a command over 16 KB.
 */
async function writeClaudeSettingsFile(
  config: DaedalusConfig,
  sessionId: string,
  settings: ClaudeSettings,
  options: { inbox: boolean },
): Promise<string> {
  const path = sessionClaudeSettingsPath(config, sessionId, options);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Written beside and renamed, so a session starting from the old file
  // never reads half of the new one.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
  return path;
}

/** Removes a session's settings files, whichever name it was written under. */
export async function removeClaudeSettingsFiles(
  config: DaedalusConfig,
  sessionId: string,
): Promise<void> {
  await Promise.all(
    [true, false].map((inbox) =>
      rm(sessionClaudeSettingsPath(config, sessionId, { inbox }), {
        force: true,
      }),
    ),
  );
}

/**
 * The launch arguments that start a session in the provider's own
 * "only ask about what looks unsafe" mode.
 *
 * Daedalus exists to let agents work continuously, so a spawned session
 * starts relaxed unless the user configures `permissionMode: "inherit"`.
 *
 * Applied at spawn and nowhere else. A user who tightens a live session —
 * Claude's shift+tab, Codex's `/permissions` — has made a decision, and
 * re-applying this on restore would silently undo it. `relaunch` therefore
 * rebuilds its arguments without calling this, and that asymmetry is
 * deliberate: a restored session that is stricter than expected is friction,
 * one that is quietly looser is a bug.
 *
 * The same idea needs different arguments and does not have the same reach in
 * each provider. Claude's `auto` weighs every tool call, because nothing but
 * judgement bounds it. Codex's reviewer only sees escalations *out of* the
 * seatbelt sandbox, so it engages far less often — which is also why
 * `approval_policy` must stay `on-request`: under `never` no escalation is
 * ever raised, and the reviewer would have nothing to review.
 *
 * Neither reaches an enterprise `PreToolUse` hook. Those run ahead of the
 * permission flow and are not a permission mode, so a managed guardrail stops
 * an `auto` session exactly as it stops a default one.
 */
export function permissionModeArgs(
  provider: string,
  mode: AgentPermissionMode = "auto",
): string[] {
  if (mode === "inherit") return [];
  switch (provider) {
    case "claude":
      return ["--permission-mode", "auto"];
    case "codex":
      // Values are quoted so Codex parses them as TOML strings rather than
      // falling back to its raw-literal path.
      return [
        "-c",
        'approvals_reviewer="auto_review"',
        "-c",
        'approval_policy="on-request"',
      ];
    default:
      return [];
  }
}

export const codexConfigPath = (config: DaedalusConfig): string =>
  join(dirname(config.codexSessionsDirectory), "config.toml");

/**
 * What every agent is told at launch about reporting its own state.
 *
 * Daedalus raises Needs me only from structured signals, never from reading
 * the agent's prose, so an agent that asks a question in plain text shows as
 * `done`. This is what makes the structured channels the ones it reaches for.
 * It travels with the launch rather than in `AGENTS.md`, which is the user's
 * to edit and which a session started outside the workspace never reads.
 */
export const DAEDALUS_STATUS_INSTRUCTIONS = `You are running inside Daedalus, which shows the user whether each session is working, done, or needs them.
- When you need the user to decide, answer, or approve something before you can continue, run \`daedal attention "<what you need from them>"\`. If you have a tool for asking the user a question (AskUserQuestion), you may use that instead. A question written only in your reply is shown as done, not as waiting on the user.
- Run \`daedal attention --clear\` as soon as that is resolved.
- When you finish what you were asked, just end your turn. Daedalus marks it done.
- When a command needs an API key, token or password, do not ask the user to paste it. Run \`daedal secret list\` and use one with \`daedal exec --secret NAME -- <command>\`. If it is not there, ask the user to add it from the key icon on the workspace's card in Daedalus (the key in the Workspaces heading for every workspace).`;

const CLAUDE_APPEND_PROMPT = "--append-system-prompt";

/**
 * The status instructions as launch arguments for one provider.
 *
 * Claude gets them through `--append-system-prompt`, joined onto any value
 * the user already passes there. Codex gets them as `developer_instructions`,
 * which has no append form, so a user who set their own in `config.toml`
 * keeps it and goes without.
 */
export async function daedalusInstructionArgs(
  config: DaedalusConfig,
  provider: string,
  existingArgs: readonly string[],
): Promise<string[]> {
  if (provider === "claude") {
    if (
      existingArgs.some((argument) =>
        argument.startsWith(`${CLAUDE_APPEND_PROMPT}-file`),
      )
    )
      return [...existingArgs];
    const index = existingArgs.indexOf(CLAUDE_APPEND_PROMPT);
    if (index >= 0 && index + 1 < existingArgs.length) {
      const args = [...existingArgs];
      args[index + 1] = `${args[index + 1]}\n\n${DAEDALUS_STATUS_INSTRUCTIONS}`;
      return args;
    }
    return [
      ...existingArgs,
      CLAUDE_APPEND_PROMPT,
      DAEDALUS_STATUS_INSTRUCTIONS,
    ];
  }
  if (provider === "codex") {
    const own = await Bun.file(codexConfigPath(config))
      .text()
      .catch(() => "");
    if (/^\s*developer_instructions\s*=/m.test(own)) return [...existingArgs];
    return [
      ...existingArgs,
      "-c",
      // A JSON string is a valid TOML basic string, escapes included.
      `developer_instructions=${JSON.stringify(DAEDALUS_STATUS_INSTRUCTIONS)}`,
    ];
  }
  return [...existingArgs];
}

/**
 * Writes Daedalus's block into the user's Codex configuration and returns the
 * launch arguments that go with it.
 *
 * Codex has no per-session way to add hooks without taking over the key, so
 * this writes to `~/.codex/config.toml` — the only global mutation Daedalus
 * makes, and the reason it is careful:
 *
 * - Nothing is written unless the rendered block actually differs, because
 *   every change to a hook definition invalidates its trust record and makes
 *   Codex ask the user to approve it again.
 * - The block is appended, so hooks belonging to other tools keep their group
 *   indices and therefore their existing approvals.
 * - The first write leaves a one-time `config.toml.daedalus-backup` beside it.
 * - The write is atomic, because Codex writes to this file too.
 *
 * Builds older than 0.145 ignore hooks silently, so no hook tables are written
 * for them and activity falls back to the rollout tail. The block is still
 * written, because the user's skill settings also live in it and they do not
 * depend on hook support. Deciding both from one version probe meant that on
 * an older Codex, turning a skill off wrote the preference and then silently
 * did nothing about it.
 */
export async function ensureCodexHooks(
  config: DaedalusConfig,
  executable: string,
  run: typeof runCommand = runCommand,
): Promise<string[]> {
  let hooks = false;
  try {
    const version = await run(executable, ["--version"]);
    hooks = version.exitCode === 0 && codexSupportsHooks(version.stdout);
  } catch {
    hooks = false;
  }
  const skillEntries = await new SkillService(config).codexSkillEntries();
  // Nothing of ours to say, and saying nothing is what leaves the user's file
  // alone on the machines where neither feature applies.
  if (!hooks && skillEntries.length === 0) return [];
  const configPath = codexConfigPath(config);
  try {
    // Codex creates its own home on first run, so a user who has installed it
    // but not started it yet has no directory here. Writing into a directory
    // that does not exist threw, and the catch below swallowed it, which meant
    // a skill switched off before Codex had ever run was switched off in name
    // only.
    await ensureDirectory(dirname(configPath));
    const file = Bun.file(configPath);
    const existing = (await file.exists()) ? await file.text() : "";
    // Named after this channel, so a machine with both builds installed keeps
    // one block per app instead of them overwriting each other's.
    const channel = channelName(config.home);
    const merged = mergeCodexConfigToml(
      existing,
      renderCodexHookBlock(
        daedalExecutable(config),
        channel,
        skillEntries,
        hooks,
      ),
      channel,
    );
    if (merged !== existing) {
      const backup = `${configPath}.daedalus-backup`;
      if (existing && !(await Bun.file(backup).exists()))
        await writeFile(backup, existing, { mode: 0o600 });
      const temporary = `${configPath}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, merged, { flag: "wx", mode: 0o600 });
        await rename(temporary, configPath);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  } catch {
    // A configuration Daedalus cannot read or write is the user's to own.
    // Activity degrades to the rollout tail rather than the launch failing.
    return [];
  }
  // Stable and on by default from 0.154, but not on every build in the
  // supported range, and a per-session flag costs nothing. A build that does
  // not understand hooks gets no flag, only its skill settings.
  if (!hooks) return [];
  return [
    "-c",
    "features.hooks=true",
    ...((await codexHasNoDaemonFlag(executable, run)) ? ["--no-daemon"] : []),
  ];
}

/**
 * Whether this Codex can run a session without the shared app server.
 *
 * From about 0.160 the TUI hands its turns to one background server that
 * every Codex on the machine shares, and that server runs the hooks. They
 * inherit the server's environment, which is whatever process happened to
 * start it, so `DAEDALUS_SESSION_ID` was missing or named some other session
 * and no Codex session reported activity. With `--no-daemon` the session runs
 * its own server and its hooks see the session's environment. `codex queue`
 * still reaches such a session (checked with 0.162).
 */
async function codexHasNoDaemonFlag(
  executable: string,
  run: typeof runCommand,
): Promise<boolean> {
  try {
    const help = await run(executable, ["--help"]);
    return help.exitCode === 0 && /^\s*--no-daemon\b/m.test(help.stdout);
  } catch {
    return false;
  }
}

interface ClaudeModelInfo {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
}

export function parseClaudeModelCatalog(
  stdout: string,
  requestId: string,
  configuredDefault?: string,
): ProviderModelCatalog {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let message: {
      type?: unknown;
      response?: {
        subtype?: unknown;
        request_id?: unknown;
        response?: { models?: ClaudeModelInfo[] };
      };
    };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      message.type !== "control_response" ||
      message.response?.subtype !== "success" ||
      message.response.request_id !== requestId
    )
      continue;
    const discovered = (message.response.response?.models ?? []).filter(
      (model) =>
        typeof model.value === "string" &&
        typeof model.displayName === "string",
    );
    const defaultEntry = discovered.find((model) => model.value === "default");
    const configuredEntry = discovered.find(
      (model) => model.value === configuredDefault,
    );
    const defaultModel = configuredDefault
      ? typeof configuredEntry?.resolvedModel === "string"
        ? configuredEntry.resolvedModel
        : configuredDefault
      : typeof defaultEntry?.resolvedModel === "string"
        ? defaultEntry.resolvedModel
        : undefined;
    return {
      provider: "claude",
      defaultModel,
      source: "provider",
      models: discovered
        .filter((model) => model.value !== "default")
        .map((model) => ({
          id: model.value as string,
          label: model.displayName as string,
          ...(typeof model.resolvedModel === "string"
            ? { resolvedModel: model.resolvedModel }
            : {}),
          ...(typeof model.description === "string"
            ? { description: model.description }
            : {}),
        })),
    };
  }
  throw new DaedalusError(
    "INTERNAL",
    "Claude returned an invalid model catalog",
  );
}

/**
 * Whether a catalog lists `model`, by id or by the model an alias resolves
 * to. A workspace default is stored as whichever of the two the user chose,
 * and the board picks ids while the CLI is as likely to be handed a resolved
 * name, so both count.
 */
export function catalogOffersModel(
  catalog: ProviderModelCatalog,
  model: string,
): boolean {
  return catalog.models.some(
    (entry) => entry.id === model || entry.resolvedModel === model,
  );
}

/**
 * Claude's own name for its recommended model, accepted by `--model` and
 * resolved when the session starts. Daedalus passes it whenever a Claude
 * session is launched with nothing else naming a model, because passing no
 * `--model` at all lets Claude read the last `/model` pick from the user's
 * settings file, which is where every session's in-flight choice ends up.
 */
export const CLAUDE_DEFAULT_MODEL = "default";

export function modelArgument(args: string[]): string | undefined {
  for (let index = args.length - 1; index >= 0; index--) {
    const value = args[index]!;
    if (value.startsWith("--model=")) return value.slice("--model=".length);
    if ((value === "--model" || value === "-m") && args[index + 1])
      return args[index + 1];
  }
  return undefined;
}

export function isValidModelName(model: string): boolean {
  return (
    model.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[(?:1|2)m\])?$/.test(model)
  );
}

/**
 * The model a provider starts with when Daedalus names none, as far as it
 * can be read without launching one. A `--model` in the Daedalus agent
 * arguments wins for either provider. Codex's own `config.toml` is read
 * because a session with no `--model` uses it. Claude's `settings.json` is
 * deliberately not: its `model` key is where `/model` picks land, and a
 * Claude session Daedalus starts is asked for the recommended model by name
 * instead, so that file no longer describes what will launch.
 */
const configuredModel = async (
  config: DaedalusConfig,
  provider: "codex" | "claude",
): Promise<string | undefined> => {
  const fromArgs = modelArgument(config.agents[provider]?.args ?? []);
  if (fromArgs) return fromArgs;
  if (provider === "claude") return undefined;
  try {
    const file = Bun.file(
      join(dirname(config.codexSessionsDirectory), "config.toml"),
    );
    if (!(await file.exists())) return undefined;
    const parsed = Bun.TOML.parse(await file.text()) as {
      model?: unknown;
    };
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
};

export async function discoverProviderModels(
  config: DaedalusConfig,
  provider: "codex" | "claude",
  /** Points the provider at an account profile; empty for the default. */
  env: Record<string, string> = {},
): Promise<ProviderModelCatalog> {
  const definition = config.agents[provider];
  const executable = definition
    ? resolveAgentExecutable(provider, definition.executable)
    : undefined;
  if (!executable)
    throw new DaedalusError(
      "DEPENDENCY",
      `Agent executable '${definition?.executable ?? provider}' is not available on PATH`,
    );
  const defaultModel = await configuredModel(config, provider);
  if (provider === "claude") {
    const requestId = crypto.randomUUID();
    const input = `${JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "initialize", hooks: {}, sdkMcpServers: [] },
    })}\n`;
    const result = await runCommand(
      executable,
      [
        "--safe-mode",
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      { stdin: input, env },
    );
    if (result.exitCode !== 0)
      throw new DaedalusError(
        "DEPENDENCY",
        result.stderr.trim() || "Claude model discovery failed",
      );
    return parseClaudeModelCatalog(result.stdout, requestId, defaultModel);
  }

  const result = await runCommand(executable, ["debug", "models"], { env });
  if (result.exitCode !== 0)
    throw new DaedalusError(
      "DEPENDENCY",
      result.stderr.trim() || "Codex model discovery failed",
    );
  try {
    const catalog = JSON.parse(result.stdout) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        description?: unknown;
        visibility?: unknown;
        priority?: unknown;
      }>;
    };
    const models = (catalog.models ?? [])
      .filter(
        (model) =>
          model.visibility === "list" && typeof model.slug === "string",
      )
      .sort(
        (left, right) =>
          (typeof left.priority === "number" ? left.priority : 999) -
          (typeof right.priority === "number" ? right.priority : 999),
      )
      .map((model) => ({
        id: model.slug as string,
        label:
          typeof model.display_name === "string"
            ? model.display_name
            : (model.slug as string),
        ...(typeof model.description === "string"
          ? { description: model.description }
          : {}),
      }));
    return { provider, defaultModel, models, source: "provider" };
  } catch (error) {
    throw new DaedalusError(
      "INTERNAL",
      "Codex returned an invalid model catalog",
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export interface AgentProvider {
  probe(): Promise<{ available: boolean; executable: string }>;
  buildLaunch(input: LaunchInput): Promise<ProviderLaunch>;
}

const CHATGPT_CODEX_EXECUTABLE =
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const STANDARD_CODEX_EXECUTABLES = new Set([
  "codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
]);

/**
 * Where a provider named by a bare command may be installed besides `PATH`.
 * The app is launched by Launch Services with no Homebrew on PATH, so the
 * standard directories come first. Claude's own install script puts `claude`
 * in `~/.local/bin`, which no PATH a packaged app has contains; the older
 * `claude migrate-installer` used `~/.claude/local`. npm under nvm, Volta or a
 * custom prefix is only on the user's login shell PATH, which is used once it
 * has been read. It comes last so a provider found earlier keeps its path.
 * A configured path is used as it is.
 */
export function providerExecutableFallbacks(
  value: string,
  home = homedir(),
  shellPath = knownLoginShellPath(),
): string[] {
  if (value.includes("/")) return [];
  return [
    ...new Set([
      ...standardExecutableFallbacks(value),
      join(home, ".local", "bin", value),
      ...(value === "claude" ? [join(home, ".claude", "local", value)] : []),
      ...(shellPath ?? "")
        .split(":")
        .filter((directory) => isAbsolute(directory))
        .map((directory) => join(directory, value)),
    ]),
  ];
}

// Codex has the ChatGPT bundle to fall back on; a bare name for any provider
// is looked up in the places above too.
const findProviderExecutable = (value: string): string | undefined =>
  findExecutable(value, providerExecutableFallbacks(value));

export function resolveAgentExecutable(
  name: string,
  executable: string,
  finder: (value: string) => string | undefined = findProviderExecutable,
  platform = process.platform,
): string | undefined {
  if (
    platform === "darwin" &&
    name === "codex" &&
    STANDARD_CODEX_EXECUTABLES.has(executable)
  ) {
    return finder(CHATGPT_CODEX_EXECUTABLE) ?? finder(executable);
  }
  return finder(executable);
}

class ConfiguredProvider implements AgentProvider {
  constructor(
    private readonly name: string,
    private readonly definition: AgentDefinition,
    private readonly promptArgument: boolean,
    private readonly config?: DaedalusConfig,
  ) {}

  async probe(): Promise<{ available: boolean; executable: string }> {
    // A provider installed only on the login shell's PATH is found once that
    // PATH is known. The session launched next needs it anyway.
    if (!resolveAgentExecutable(this.name, this.definition.executable))
      await loginShellPath();
    const executable = resolveAgentExecutable(
      this.name,
      this.definition.executable,
    );
    return {
      available: Boolean(executable),
      executable: executable ?? this.definition.executable,
    };
  }

  async buildLaunch(input: LaunchInput): Promise<ProviderLaunch> {
    const args = [...this.definition.args];
    const env: Record<string, string> = {};
    let providerSessionId: string | undefined;
    const model = input.model?.trim();
    if (model) {
      if (!isValidModelName(model))
        throw new DaedalusError("VALIDATION", "Model name is invalid");
      args.push("--model", model);
    }
    if (this.promptArgument)
      for (const directory of input.additionalDirectories ?? [])
        args.push("--add-dir", directory);
    if (this.promptArgument)
      args.push(
        ...permissionModeArgs(this.name, this.definition.permissionMode),
      );
    if (this.promptArgument && this.name === "codex") {
      args.push(...CODEX_DAEDALUS_TUI_ARGS);
      // Codex's sandbox lets a session write only inside its working
      // directory. Every `daedal` command that changes state writes the
      // SQLite database under the Daedalus home, so without this one
      // `daedal attention` or `agent continue` fails with "attempt to write a
      // readonly database" whenever the reviewer keeps it sandboxed.
      if (this.config) args.push("--add-dir", this.config.home);
      if (this.config)
        args.push(
          ...(await ensureCodexHooks(
            this.config,
            resolveAgentExecutable(this.name, this.definition.executable) ??
              this.definition.executable,
          )),
        );
    }
    if (this.promptArgument && this.config)
      args.splice(
        0,
        args.length,
        ...(await daedalusInstructionArgs(this.config, this.name, args)),
      );
    if (this.promptArgument && this.name === "claude" && this.config)
      args.splice(
        0,
        args.length,
        ...(await claudeDaedalusSettingsArgs(
          this.config,
          args,
          input.sessionId,
          { acceptPeerMessages: input.acceptPeerMessages },
        )),
      );
    if (this.promptArgument && this.name === "claude" && input.sessionId) {
      providerSessionId = input.sessionId;
      args.push("--session-id", input.sessionId);
      if (input.sessionName) args.push("--name", input.sessionName);
    }
    if (input.prompt) {
      if (this.promptArgument) args.push(input.prompt);
      else env.DAEDALUS_TASK_PROMPT = input.prompt;
    }
    if (input.taskId) env.DAEDALUS_TASK_ID = input.taskId;
    return {
      executable:
        resolveAgentExecutable(this.name, this.definition.executable) ??
        this.definition.executable,
      args,
      env,
      providerSessionId,
    };
  }
}

export function resolveProvider(
  config: DaedalusConfig,
  selection: { provider?: string; command?: string },
): { name: "claude" | "codex" | "custom"; adapter: AgentProvider } {
  if (selection.provider && selection.command)
    throw new DaedalusError(
      "VALIDATION",
      "Choose either --provider or --command, not both",
    );
  if (!selection.provider && !selection.command)
    throw new DaedalusError(
      "VALIDATION",
      "Agent spawn requires --provider or --command",
    );
  const key = selection.command ?? selection.provider!;
  const definition = config.agents[key];
  if (!definition)
    throw new DaedalusError(
      "NOT_FOUND",
      `Agent configuration '${key}' was not found`,
    );
  if (
    selection.provider !== undefined &&
    selection.provider !== "codex" &&
    selection.provider !== "claude"
  )
    throw new DaedalusError(
      "VALIDATION",
      "Provider must be 'codex' or 'claude'",
    );
  return {
    name: selection.command
      ? "custom"
      : (selection.provider as "claude" | "codex"),
    adapter: new ConfiguredProvider(
      key,
      definition,
      !selection.command,
      config,
    ),
  };
}

/** The `--model` a session was launched with, if it was given one. */
export function sessionLaunchModel(
  args: readonly string[],
): string | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const argument = args[index]!;
    if (argument.startsWith("--model=")) return argument.slice(8);
    if (argument === "--model") return args[index + 1];
  }
  return undefined;
}

/** Where a rebirth note lives: the working directory both sessions share. */
export const REBIRTH_FILE = "REBIRTH.md";

/**
 * The name a rebirth's successor takes: the same name with a generation
 * counter, so the two cards are told apart and a third rebirth reads `· 3`
 * rather than growing a second suffix.
 */
export function rebirthSessionName(name: string): string {
  const match = /^(.*) · (\d+)$/.exec(name);
  return match ? `${match[1]} · ${Number(match[2]) + 1}` : `${name} · 2`;
}

/** A name without its rebirth counter: `API · 3` is `API`. */
export function sessionBaseName(name: string): string {
  return /^(.*) · \d+$/.exec(name)?.[1] ?? name;
}

/** The skill every rebirth runs, whoever asks for it. */
export const REBIRTH_SKILL = "daedalus-rebirth";

/**
 * What a running agent is sent to start a rebirth: its provider's way of
 * invoking the rebirth skill, and nothing else. The instructions live in the
 * skill alone, so the button, the automatic threshold and a typed
 * `/daedalus-rebirth` all do the same thing.
 *
 * `skillName` carries the channel suffix a dev build installs it under.
 */
export function buildRebirthRequest(
  provider: "claude" | "codex",
  skillName: string,
): string {
  return buildSkillInvocation(provider, skillName);
}

/** A skill typed into a session: `/name args` in Claude, `$name args` in Codex. */
export function buildSkillInvocation(
  provider: "claude" | "codex",
  skillName: string,
  args = "",
): string {
  const invocation = provider === "claude" ? `/${skillName}` : `$${skillName}`;
  return args.trim() ? `${invocation} ${args.trim()}` : invocation;
}

/** The skill a Refine session starts with, when it is installed. */
export const REFINEMENT_SKILL = "daedalus-refinement";

export function buildAgentPrompt(input: {
  taskNumber?: number;
  message?: string;
  /**
   * How a `draft-brief` session invokes the refinement skill, such as
   * `/daedalus-refinement`. It leads the prompt so the instruction becomes the
   * skill's arguments; without it the session writes the brief unprompted.
   */
  refinement?: string;
  /**
   * `draft-brief` asks for the brief to be written back, not the work done.
   * `continue` starts a session that picks up where an earlier one stopped,
   * in the same working directory and in the same state: waiting on the user
   * if it was, working if it was. `note` says whether it left one.
   */
  mode?: "execute" | "draft-brief" | "continue";
  note?: boolean;
}): string | undefined {
  if (input.mode === "continue") {
    const work = input.taskNumber ? `task #${input.taskNumber}` : "the work";
    const source = input.note
      ? `It left a note in ${REBIRTH_FILE} in your working directory. Read that first, then check the worktree's actual state with git before relying on it.`
      : "It left no note, so rebuild the picture from the task brief, JOURNAL.md and the worktree's git state and history.";
    return [
      `Continue ${work}. An earlier session worked on it in this same working directory and was reborn as you because its context was full. ${source} Pick up in the state it stopped in. If it was waiting for the user, show the user the same question or plan again, run \`daedal attention\` with it, and wait for their answer. If it was in the middle of work, carry on from its next step. Instructions from the user in the note come first. Do not redo finished work.`,
      input.message?.trim() || undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const taskInstruction = !input.taskNumber
    ? undefined
    : input.mode === "draft-brief"
      ? [
          input.refinement,
          `Draft the brief for task #${input.taskNumber}. Read the workspace, then write the brief back with \`daedal task update ${input.taskNumber} --description-file -\`. Do not start the task itself.`,
        ]
          .filter(Boolean)
          .join(" ")
      : `Execute task #${input.taskNumber}. Do not merely summarize or restate it; complete the task.`;
  const message = input.message?.trim() || undefined;
  return [taskInstruction, message].filter(Boolean).join("\n\n") || undefined;
}

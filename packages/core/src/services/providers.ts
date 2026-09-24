import {
  ensureDirectory,
  findExecutable,
  standardExecutableFallbacks,
} from "@daedalus/platform";
import { runCommand } from "@daedalus/platform";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  channelName,
  type AgentDefinition,
  type AgentPermissionMode,
  type DaedalusConfig,
} from "../config";
import { DaedalusError } from "../errors";
import { SkillService } from "./skills";
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
): Promise<string[]> {
  // The skill system contributes two keys here: `outputStyle`, which is what
  // actually turns an installed writing style on, and `skillOverrides` for
  // skills the user switched off. Both ride the settings argument Daedalus
  // already passes, so neither one edits the user's own settings file.
  const daedalus: ClaudeSettings = {
    ...daedalusClaudeSettings(daedalExecutable(config)),
    ...new SkillService(config).claudeSkillSettings(),
  };
  const existingValue = settingsArgumentValue(existingArgs);
  if (existingValue === undefined)
    return [...existingArgs, "--settings", JSON.stringify(daedalus)];
  const parsed = await parseClaudeSettingsArgument(existingValue);
  if (!parsed) return [...existingArgs];
  return [
    ...withoutSettingsArgument(existingArgs),
    "--settings",
    JSON.stringify(mergeClaudeSettings(parsed, daedalus)),
  ];
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
  return hooks ? ["-c", "features.hooks=true"] : [];
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
      { stdin: input },
    );
    if (result.exitCode !== 0)
      throw new DaedalusError(
        "DEPENDENCY",
        result.stderr.trim() || "Claude model discovery failed",
      );
    return parseClaudeModelCatalog(result.stdout, requestId, defaultModel);
  }

  const result = await runCommand(executable, ["debug", "models"]);
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

// The app is launched by Launch Services with no Homebrew on PATH, which is
// where `claude` lives. Codex has the ChatGPT bundle to fall back on; a bare
// name for any other provider is looked up in the standard directories too.
const findProviderExecutable = (value: string): string | undefined =>
  findExecutable(value, standardExecutableFallbacks(value));

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
    if (this.promptArgument && this.name === "claude" && this.config)
      args.splice(
        0,
        args.length,
        ...(await claudeDaedalusSettingsArgs(this.config, args)),
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
    if (input.additionalDirectories?.length)
      env.DAEDALUS_ADDITIONAL_DIRECTORIES =
        input.additionalDirectories.join(":");
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

/** Where a handoff note lives: the working directory both sessions share. */
export const HANDOFF_FILE = "HANDOFF.md";

/**
 * The name a handoff's successor takes: the same name with a generation
 * counter, so the two cards are told apart and a third handoff reads `· 3`
 * rather than growing a second suffix.
 */
export function handoffSessionName(name: string): string {
  const match = /^(.*) · (\d+)$/.exec(name);
  return match ? `${match[1]} · ${Number(match[2]) + 1}` : `${name} · 2`;
}

/** The skill every handoff runs, whoever asks for it. */
export const HANDOFF_SKILL = "daedalus-handoff";

/**
 * What a running agent is sent to start a handoff: its provider's way of
 * invoking the handoff skill, and nothing else. The instructions live in the
 * skill alone, so the button, the automatic threshold and a typed
 * `/daedalus-handoff` all do the same thing.
 *
 * `skillName` carries the channel suffix a dev build installs it under.
 */
export function buildHandoffRequest(
  provider: "claude" | "codex",
  skillName: string,
): string {
  return provider === "claude" ? `/${skillName}` : `$${skillName}`;
}

export function buildAgentPrompt(input: {
  taskNumber?: number;
  message?: string;
  /**
   * `draft-brief` asks for the brief to be written back, not the work done.
   * `continue` starts a session that picks up where an earlier one stopped,
   * in the same working directory; `daedalus-handoff` says whether it left a note.
   */
  mode?: "execute" | "draft-brief" | "continue";
  handoff?: boolean;
}): string | undefined {
  if (input.mode === "continue") {
    const work = input.taskNumber ? `task #${input.taskNumber}` : "the work";
    const source = input.handoff
      ? `It left a handoff note in ${HANDOFF_FILE} in your working directory. Read that first, then check the worktree's actual state with git before relying on it.`
      : "It left no handoff note, so rebuild the picture from the task brief, JOURNAL.md and the worktree's git state and history.";
    return [
      `Continue ${work}. An earlier session worked on it in this same working directory and stopped because its context was full. ${source} Do not redo finished work; carry on to completion.`,
      input.message?.trim() || undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const taskInstruction = !input.taskNumber
    ? undefined
    : input.mode === "draft-brief"
      ? `Draft the brief for task #${input.taskNumber}. Read the workspace, then write the brief back with \`daedal task update ${input.taskNumber} --description-file -\`. Do not start the task itself.`
      : `Execute task #${input.taskNumber}. Do not merely summarize or restate it; complete the task.`;
  const message = input.message?.trim() || undefined;
  return [taskInstruction, message].filter(Boolean).join("\n\n") || undefined;
}

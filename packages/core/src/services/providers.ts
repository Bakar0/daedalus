import { findExecutable } from "@daedalus/platform";
import { runCommand } from "@daedalus/platform";
import { dirname, join } from "node:path";
import type { AgentDefinition, DaedalusConfig } from "../config";
import { DaedalusError } from "../errors";

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

export const CLAUDE_DAEDALUS_STATUS_ARGS = [
  "--settings",
  JSON.stringify({
    statusLine: {
      type: "command",
      command: "daedal agent telemetry",
      padding: 0,
    },
  }),
] as const;

export function claudeDaedalusStatusArgs(existingArgs: string[]): string[] {
  return existingArgs.some(
    (argument) =>
      argument === "--settings" || argument.startsWith("--settings="),
  )
    ? []
    : [...CLAUDE_DAEDALUS_STATUS_ARGS];
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

const configuredModel = async (
  config: DaedalusConfig,
  provider: "codex" | "claude",
): Promise<string | undefined> => {
  const fromArgs = modelArgument(config.agents[provider]?.args ?? []);
  if (fromArgs) return fromArgs;
  try {
    if (provider === "codex") {
      const file = Bun.file(
        join(dirname(config.codexSessionsDirectory), "config.toml"),
      );
      if (!(await file.exists())) return undefined;
      const parsed = Bun.TOML.parse(await file.text()) as {
        model?: unknown;
      };
      return typeof parsed.model === "string" ? parsed.model : undefined;
    }
    const file = Bun.file(
      join(dirname(config.claudeProjectsDirectory), "settings.json"),
    );
    if (!(await file.exists())) return undefined;
    const parsed = (await file.json()) as { model?: unknown };
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

export function resolveAgentExecutable(
  name: string,
  executable: string,
  finder: (value: string) => string | undefined = findExecutable,
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
    if (this.promptArgument && this.name === "codex")
      args.push(...CODEX_DAEDALUS_TUI_ARGS);
    if (this.promptArgument && this.name === "claude")
      args.push(...claudeDaedalusStatusArgs(args));
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
    adapter: new ConfiguredProvider(key, definition, !selection.command),
  };
}

export function buildAgentPrompt(input: {
  taskNumber?: number;
  message?: string;
}): string | undefined {
  const taskInstruction = input.taskNumber
    ? `Execute task #${input.taskNumber}. Do not merely summarize or restate it; complete the task.`
    : undefined;
  const message = input.message?.trim() || undefined;
  return [taskInstruction, message].filter(Boolean).join("\n\n") || undefined;
}

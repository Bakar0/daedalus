import { findExecutable } from "@daedalus/platform";
import type { AgentDefinition, DaedalusConfig } from "../config";
import { DaedalusError } from "../errors";

export interface LaunchInput {
  prompt?: string;
  taskId?: string;
  sessionId?: string;
  sessionName?: string;
  additionalDirectories?: string[];
}

export interface ProviderLaunch {
  executable: string;
  args: string[];
  env: Record<string, string>;
  providerSessionId?: string;
  bootstrapInput?: string[];
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
    let bootstrapInput: string[] | undefined;
    if (this.promptArgument)
      for (const directory of input.additionalDirectories ?? [])
        args.push("--add-dir", directory);
    if (this.promptArgument && this.name === "claude" && input.sessionId) {
      providerSessionId = input.sessionId;
      args.push("--session-id", input.sessionId);
      if (input.sessionName) args.push("--name", input.sessionName);
    }
    if (this.promptArgument && this.name === "codex" && input.sessionId) {
      providerSessionId = `daedalus-${input.sessionId}`;
      bootstrapInput = [
        `/rename ${providerSessionId}`,
        ...(input.prompt ? [input.prompt] : []),
      ];
    } else if (input.prompt) {
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
      bootstrapInput,
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

export function buildTaskPrompt(title: string, description: string): string {
  return description.trim() ? `${title}\n\n${description}` : title;
}

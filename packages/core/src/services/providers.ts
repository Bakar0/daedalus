import { findExecutable } from "@daedalus/platform";
import type { AgentDefinition, DaedalusConfig } from "../config";
import { DaedalusError } from "../errors";

export interface LaunchInput {
  prompt?: string;
  taskId?: string;
}

export interface ProviderLaunch {
  executable: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentProvider {
  probe(): Promise<{ available: boolean; executable: string }>;
  buildLaunch(input: LaunchInput): Promise<ProviderLaunch>;
}

class ConfiguredProvider implements AgentProvider {
  constructor(
    private readonly definition: AgentDefinition,
    private readonly promptArgument: boolean,
  ) {}

  async probe(): Promise<{ available: boolean; executable: string }> {
    return {
      available: Boolean(findExecutable(this.definition.executable)),
      executable: this.definition.executable,
    };
  }

  async buildLaunch(input: LaunchInput): Promise<ProviderLaunch> {
    const args = [...this.definition.args];
    const env: Record<string, string> = {};
    if (input.prompt) {
      if (this.promptArgument) args.push(input.prompt);
      else env.DAEDALUS_TASK_PROMPT = input.prompt;
    }
    if (input.taskId) env.DAEDALUS_TASK_ID = input.taskId;
    return { executable: this.definition.executable, args, env };
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
    adapter: new ConfiguredProvider(definition, !selection.command),
  };
}

export function buildTaskPrompt(title: string, description: string): string {
  return description.trim() ? `${title}\n\n${description}` : title;
}

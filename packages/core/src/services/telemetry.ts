import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";
import type { SqliteRepositories } from "../repositories";
import { resolveAgentExecutable } from "./providers";

const SESSION_CACHE_MS = 5_000;
const PROVIDER_CACHE_MS = 60_000;
const CLAUDE_USAGE_MAX_AGE_MS = 15 * 60_000;

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt?: string;
}

export interface ProviderUsage {
  provider: "codex" | "claude";
  windows: UsageWindow[];
  observedAt: string;
}

export interface SessionTelemetry {
  sessionId: string;
  model?: string;
  context?: {
    usedTokens: number;
    totalTokens?: number;
    usedPercent?: number;
  };
  observedAt: string;
}

interface TelemetrySnapshot {
  providerUsage: ProviderUsage[];
  sessionTelemetry: SessionTelemetry[];
}

interface ClaudeStatusPayload {
  observedAt?: unknown;
  model?: { id?: unknown; display_name?: unknown };
  context_window?: {
    total_input_tokens?: unknown;
    total_output_tokens?: unknown;
    context_window_size?: unknown;
    used_percentage?: unknown;
  };
  rate_limits?: {
    five_hour?: { used_percentage?: unknown; resets_at?: unknown };
    seven_day?: { used_percentage?: unknown; resets_at?: unknown };
  };
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const percentage = (value: unknown): number | undefined => {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.min(100, Math.max(0, number));
};

function usageWindow(
  label: string,
  value?: { used_percentage?: unknown; resets_at?: unknown },
): UsageWindow | undefined {
  const usedPercent = percentage(value?.used_percentage);
  if (usedPercent === undefined) return undefined;
  return {
    label,
    usedPercent,
    ...(typeof value?.resets_at === "string"
      ? { resetsAt: value.resets_at }
      : {}),
  };
}

export function parseClaudeStatus(
  sessionId: string,
  payload: ClaudeStatusPayload,
): { session?: SessionTelemetry; usage?: ProviderUsage } {
  const observedAt =
    typeof payload.observedAt === "string"
      ? payload.observedAt
      : new Date().toISOString();
  const context = payload.context_window;
  const inputTokens = finiteNumber(context?.total_input_tokens);
  const outputTokens = finiteNumber(context?.total_output_tokens);
  const totalTokens = finiteNumber(context?.context_window_size);
  const usedPercent = percentage(context?.used_percentage);
  const model =
    typeof payload.model?.display_name === "string"
      ? payload.model.display_name
      : typeof payload.model?.id === "string"
        ? payload.model.id
        : undefined;
  const hasContext =
    inputTokens !== undefined &&
    outputTokens !== undefined &&
    totalTokens !== undefined &&
    totalTokens > 0;
  const windows = [
    usageWindow("5h", payload.rate_limits?.five_hour),
    usageWindow("7d", payload.rate_limits?.seven_day),
  ].filter((item): item is UsageWindow => Boolean(item));
  return {
    session:
      hasContext || model
        ? {
            sessionId,
            ...(model ? { model } : {}),
            ...(hasContext
              ? {
                  context: {
                    usedTokens: inputTokens + outputTokens,
                    totalTokens,
                    usedPercent:
                      usedPercent ??
                      ((inputTokens + outputTokens) / totalTokens) * 100,
                  },
                }
              : {}),
            observedAt,
          }
        : undefined,
    usage:
      windows.length > 0
        ? { provider: "claude", windows, observedAt }
        : undefined,
  };
}

export function parseCodexTokenUsage(
  sessionId: string,
  text: string,
  observedAt: string,
): SessionTelemetry | undefined {
  const lines = text.trimEnd().split("\n");
  let context: SessionTelemetry["context"];
  let model: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]!) as {
        type?: unknown;
        payload?: {
          type?: unknown;
          model?: unknown;
          info?: {
            last_token_usage?: { total_tokens?: unknown };
            total_token_usage?: { total_tokens?: unknown };
            model_context_window?: unknown;
          };
        };
      };
      const payload = event.payload;
      if (event.type === "turn_context" && typeof payload?.model === "string")
        model ??= payload.model;
      if (payload?.type !== "token_count") continue;
      const info = payload.info;
      const usedTokens =
        finiteNumber(info?.last_token_usage?.total_tokens) ??
        finiteNumber(info?.total_token_usage?.total_tokens);
      const totalTokens = finiteNumber(info?.model_context_window);
      if (
        usedTokens === undefined ||
        totalTokens === undefined ||
        totalTokens <= 0
      )
        continue;
      context ??= {
        usedTokens,
        totalTokens,
        usedPercent: (usedTokens / totalTokens) * 100,
      };
    } catch {
      // A truncated first line is expected when reading the tail of a rollout.
    }
  }
  return context || model
    ? {
        sessionId,
        ...(model ? { model } : {}),
        ...(context ? { context } : {}),
        observedAt,
      }
    : undefined;
}

export async function codexRolloutPath(
  sessionsDirectory: string,
  agent: AgentSession,
): Promise<string | undefined> {
  const id = agent.providerSessionId ?? agent.id;
  const startedAt = Date.parse(agent.startedAt);
  if (!Number.isFinite(startedAt)) return undefined;
  for (const offset of [-1, 0, 1]) {
    const [year, month, day] = new Date(startedAt + offset * 86_400_000)
      .toISOString()
      .slice(0, 10)
      .split("-");
    const directory = join(sessionsDirectory, year!, month!, day!);
    try {
      const match = (await readdir(directory)).find((entry) =>
        entry.endsWith(`${id}.jsonl`),
      );
      if (match) return join(directory, match);
    } catch {
      // Missing date directories are normal.
    }
  }
  return undefined;
}

async function readCodexSession(
  config: DaedalusConfig,
  agent: AgentSession,
): Promise<SessionTelemetry | undefined> {
  const path = await codexRolloutPath(config.codexSessionsDirectory, agent);
  if (!path) return undefined;
  try {
    const file = Bun.file(path);
    const size = file.size;
    const [head, tail] = await Promise.all([
      file.slice(0, Math.min(size, 128 * 1024)).text(),
      file.slice(Math.max(0, size - 512 * 1024)).text(),
    ]);
    return parseCodexTokenUsage(
      agent.id,
      `${head}\n${tail}`,
      new Date(file.lastModified).toISOString(),
    );
  } catch {
    return undefined;
  }
}

async function readClaudeStatus(
  config: DaedalusConfig,
  agent: AgentSession,
): Promise<ReturnType<typeof parseClaudeStatus> | undefined> {
  try {
    const payload = (await Bun.file(
      join(config.home, "telemetry", `${agent.id}.json`),
    ).json()) as ClaudeStatusPayload;
    return parseClaudeStatus(agent.id, payload);
  } catch {
    return undefined;
  }
}

const claudeProjectKey = (workingDirectory: string) =>
  workingDirectory.replace(/[^a-zA-Z0-9]/g, "-");

function selectedModel(args: string[]): string | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const argument = args[index]!;
    if (argument.startsWith("--model=")) return argument.slice(8);
    if (argument === "--model") return args[index + 1];
  }
  return undefined;
}

function contextWindowFromModel(model?: string): number | undefined {
  const match = model?.match(/\[(\d+)([mk])\]$/i);
  if (!match) return undefined;
  return (
    Number(match[1]) * (match[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000)
  );
}

export function parseClaudeTranscript(
  sessionId: string,
  text: string,
  configuredModel?: string,
): SessionTelemetry | undefined {
  const lines = text.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]!) as {
        type?: unknown;
        timestamp?: unknown;
        message?: {
          model?: unknown;
          usage?: {
            input_tokens?: unknown;
            cache_creation_input_tokens?: unknown;
            cache_read_input_tokens?: unknown;
            output_tokens?: unknown;
          };
        };
      };
      if (event.type !== "assistant" || !event.message?.usage) continue;
      const usage = event.message.usage;
      const usedTokens = [
        usage.input_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
        usage.output_tokens,
      ]
        .map((value) => finiteNumber(value) ?? 0)
        .reduce((total, value) => total + value, 0);
      if (!usedTokens) continue;
      const model =
        configuredModel ??
        (typeof event.message.model === "string"
          ? event.message.model
          : undefined);
      const totalTokens = contextWindowFromModel(configuredModel);
      return {
        sessionId,
        ...(model ? { model } : {}),
        context: {
          usedTokens,
          ...(totalTokens
            ? {
                totalTokens,
                usedPercent: (usedTokens / totalTokens) * 100,
              }
            : {}),
        },
        observedAt:
          typeof event.timestamp === "string"
            ? event.timestamp
            : new Date().toISOString(),
      };
    } catch {
      // A partial first line is expected when reading a transcript tail.
    }
  }
  return undefined;
}

async function readClaudeTranscript(
  config: DaedalusConfig,
  agent: AgentSession,
): Promise<SessionTelemetry | undefined> {
  const id = agent.providerSessionId ?? agent.id;
  const path = join(
    config.claudeProjectsDirectory,
    claudeProjectKey(agent.workingDirectory),
    `${id}.jsonl`,
  );
  try {
    const file = Bun.file(path);
    const text = await file.slice(Math.max(0, file.size - 512 * 1024)).text();
    return parseClaudeTranscript(agent.id, text, selectedModel(agent.args));
  } catch {
    return undefined;
  }
}

interface AppServerWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface AppServerIndividualLimit {
  remainingPercent?: unknown;
  resetsAt?: unknown;
}

export function parseCodexRateLimits(
  value: unknown,
  observedAt = new Date().toISOString(),
): ProviderUsage | undefined {
  const limits = (value as { rateLimits?: unknown } | undefined)?.rateLimits as
    | {
        primary?: AppServerWindow;
        secondary?: AppServerWindow;
        individualLimit?: AppServerIndividualLimit;
      }
    | undefined;
  const windows = [limits?.primary, limits?.secondary]
    .map((window) => {
      const usedPercent = percentage(window?.usedPercent);
      const duration = finiteNumber(window?.windowDurationMins);
      if (usedPercent === undefined || duration === undefined) return undefined;
      const label =
        duration % (24 * 60) === 0
          ? `${duration / (24 * 60)}d`
          : duration % 60 === 0
            ? `${duration / 60}h`
            : `${duration}m`;
      return {
        label,
        usedPercent,
        ...(typeof window?.resetsAt === "number"
          ? { resetsAt: new Date(window.resetsAt * 1_000).toISOString() }
          : {}),
      };
    })
    .filter((item): item is UsageWindow => Boolean(item));
  if (windows.length === 0) {
    const remainingPercent = percentage(
      limits?.individualLimit?.remainingPercent,
    );
    if (remainingPercent !== undefined)
      windows.push({
        label: "allowance",
        usedPercent: 100 - remainingPercent,
        ...(typeof limits?.individualLimit?.resetsAt === "number"
          ? {
              resetsAt: new Date(
                limits.individualLimit.resetsAt * 1_000,
              ).toISOString(),
            }
          : {}),
      });
  }
  return windows.length
    ? { provider: "codex", windows, observedAt }
    : undefined;
}

async function readCodexUsage(
  config: DaedalusConfig,
): Promise<ProviderUsage | undefined> {
  const definition = config.agents.codex;
  if (!definition) return undefined;
  const executable =
    resolveAgentExecutable("codex", definition.executable) ??
    definition.executable;
  try {
    const process = Bun.spawn([executable, "app-server", "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      const writer = process.stdin;
      writer.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "daedalus", title: "Daedalus", version: "0.2.0" }, capabilities: { experimentalApi: true } } })}\n`,
      );
      writer.write(
        `${JSON.stringify({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true, supportsLunaReserve: false } })}\n`,
      );
      const reader = process.stdout.getReader();
      const response = await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) return undefined;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              try {
                const message = JSON.parse(line) as {
                  id?: unknown;
                  result?: unknown;
                };
                if (message.id === 2)
                  return parseCodexRateLimits(message.result);
              } catch {
                // Ignore non-protocol output.
              }
            }
          }
        })(),
        Bun.sleep(5_000).then(() => undefined),
      ]);
      await reader.cancel();
      return response;
    } finally {
      process.kill();
    }
  } catch {
    return undefined;
  }
}

export class TelemetryService {
  private sessionCache?: { expiresAt: number; value: TelemetrySnapshot };
  private providerCache?: { expiresAt: number; value?: ProviderUsage };

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly config: DaedalusConfig,
  ) {}

  async read(): Promise<TelemetrySnapshot> {
    const now = Date.now();
    if (this.sessionCache && this.sessionCache.expiresAt > now)
      return this.sessionCache.value;
    const agents = this.repositories
      .listAgents()
      .filter(
        (agent) =>
          agent.kind === "agent" &&
          (agent.status === "running" || agent.status === "starting"),
      );
    const results = await Promise.all(
      agents.map(async (agent) => {
        if (agent.provider === "codex")
          return { session: await readCodexSession(this.config, agent) };
        if (agent.provider === "claude") {
          const status = await readClaudeStatus(this.config, agent);
          const transcript = await readClaudeTranscript(this.config, agent);
          const statusSession = status?.session;
          return {
            usage: status?.usage,
            session:
              statusSession || transcript
                ? {
                    sessionId: agent.id,
                    ...(statusSession?.model || transcript?.model
                      ? { model: statusSession?.model ?? transcript?.model }
                      : {}),
                    ...(statusSession?.context || transcript?.context
                      ? {
                          context:
                            statusSession?.context ?? transcript?.context,
                        }
                      : {}),
                    observedAt:
                      statusSession?.observedAt ??
                      transcript?.observedAt ??
                      new Date().toISOString(),
                  }
                : undefined,
          };
        }
        return {};
      }),
    );
    if (!this.providerCache || this.providerCache.expiresAt <= now) {
      this.providerCache = {
        expiresAt: now + PROVIDER_CACHE_MS,
        value: await readCodexUsage(this.config),
      };
    }
    const newestClaudeUsage = results
      .map((result) => result.usage)
      .filter((item): item is ProviderUsage => Boolean(item))
      .filter(
        (item) => now - Date.parse(item.observedAt) <= CLAUDE_USAGE_MAX_AGE_MS,
      )
      .sort((left, right) =>
        right.observedAt.localeCompare(left.observedAt),
      )[0];
    const value = {
      providerUsage: [this.providerCache.value, newestClaudeUsage].filter(
        (item): item is ProviderUsage => Boolean(item),
      ),
      sessionTelemetry: results
        .map((result) => result.session)
        .filter((item): item is SessionTelemetry => Boolean(item)),
    };
    this.sessionCache = { expiresAt: now + SESSION_CACHE_MS, value };
    return value;
  }
}

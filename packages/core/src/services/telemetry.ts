import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";
import type { SqliteRepositories } from "../repositories";
import { resolveAgentExecutable, sessionLaunchModel } from "./providers";

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
  /**
   * The session's current permission mode, in the provider's own vocabulary.
   *
   * Codex only. Its rollout writes a `turn_context` record per turn carrying
   * the live `approvals_reviewer`, `approval_policy` and `sandbox_policy`, so
   * this follows a `/permissions` change on the next turn rather than
   * reporting whatever the session was launched with. Claude has no
   * equivalent — `permission_mode` is absent from its status-line payload —
   * but it also needs none, because Claude shows its own mode in the input
   * border and Codex displays its mode nowhere at all.
   */
  permissionMode?: string;
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

/**
 * A Codex `turn_context` rendered in the wording of its own `/permissions`
 * picker, so the badge and the picker cannot disagree about what a session is
 * doing.
 *
 * Read in order of how contracted each field is, which is not the order the
 * picker presents. `sandbox_policy.type` and `approvals_reviewer` have held a
 * stable shape across every rollout on disk, so they decide first: sandbox
 * outranks everything, because a read-only or full-access session is that
 * whoever answers approvals, and the reviewer is the only field separating
 * "Approve for me" from "Ask for approval".
 *
 * `approval_policy` is consulted last and only when it is a string, because
 * it is the one that drifts: older rollouts carry a granular object
 * (`{ granular: { sandbox_approval, rules, … } }`) where newer ones carry
 * `"on-request"`. Leading with it dropped the badge entirely for those
 * sessions. Anything still unrecognised returns undefined and shows no badge,
 * which is the honest answer for a format Daedalus only scrapes.
 */
function codexPermissionLabel(payload: {
  approvals_reviewer?: unknown;
  approval_policy?: unknown;
  sandbox_policy?: { type?: unknown };
}): string | undefined {
  const sandbox = payload.sandbox_policy?.type;
  if (sandbox === "read-only") return "Read only";
  if (sandbox === "danger-full-access") return "Full access";
  if (payload.approvals_reviewer === "auto_review") return "Approve for me";
  if (payload.approval_policy === "never") return "Never ask";
  // Either field alone is enough, and neither is present in every rollout:
  // the reviewer is missing from some, and `approval_policy` is an object
  // rather than a string in others. Checking only one loses the sessions
  // carrying the other.
  if (
    payload.approvals_reviewer === "user" ||
    payload.approval_policy === "on-request"
  )
    return "Ask for approval";
  return undefined;
}

export function parseCodexTokenUsage(
  sessionId: string,
  text: string,
  observedAt: string,
): SessionTelemetry | undefined {
  const lines = text.trimEnd().split("\n");
  let context: SessionTelemetry["context"];
  let model: string | undefined;
  let permissionMode: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]!) as {
        type?: unknown;
        payload?: {
          type?: unknown;
          model?: unknown;
          approvals_reviewer?: unknown;
          approval_policy?: unknown;
          sandbox_policy?: { type?: unknown };
          info?: {
            last_token_usage?: { total_tokens?: unknown };
            total_token_usage?: { total_tokens?: unknown };
            model_context_window?: unknown;
          };
        };
      };
      const payload = event.payload;
      if (event.type === "turn_context") {
        if (typeof payload?.model === "string") model ??= payload.model;
        // Walking backwards, so the first record seen is the newest turn.
        if (payload) permissionMode ??= codexPermissionLabel(payload);
      }
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
  return context || model || permissionMode
    ? {
        sessionId,
        ...(model ? { model } : {}),
        ...(permissionMode ? { permissionMode } : {}),
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
  const payload = await readClaudeStatusPayload(config, agent);
  return payload ? parseClaudeStatus(agent.id, payload) : undefined;
}

async function readClaudeStatusPayload(
  config: DaedalusConfig,
  agent: AgentSession,
): Promise<ClaudeStatusPayload | undefined> {
  try {
    return (await Bun.file(
      join(config.home, "telemetry", `${agent.id}.json`),
    ).json()) as ClaudeStatusPayload;
  } catch {
    return undefined;
  }
}

const claudeProjectKey = (workingDirectory: string) =>
  workingDirectory.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * Where Claude keeps this session's transcript. Unlike Codex's rollout there
 * is nothing to search for: Daedalus hands Claude `--session-id` at launch, so
 * the file name is known before the session writes a byte.
 *
 * Exported because the activity detector tails the same file for the one thing
 * Claude's hooks never report — a turn the user interrupted — and a second
 * copy of this path is a second thing to get wrong.
 */
export const claudeTranscriptPath = (
  projectsDirectory: string,
  agent: AgentSession,
): string =>
  join(
    projectsDirectory,
    claudeProjectKey(agent.workingDirectory),
    `${agent.providerSessionId ?? agent.id}.jsonl`,
  );

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
  const path = claudeTranscriptPath(config.claudeProjectsDirectory, agent);
  try {
    const file = Bun.file(path);
    const text = await file.slice(Math.max(0, file.size - 512 * 1024)).text();
    return parseClaudeTranscript(
      agent.id,
      text,
      sessionLaunchModel(agent.args),
    );
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

/**
 * What a whole session used, as opposed to what it is using now: every model
 * it ran and the fullest its context got. Read from the same files as live
 * telemetry, but from start to end rather than from the tail.
 */
export interface SessionUsageHistory {
  models: string[];
  peakTokens?: number;
  peakPercent?: number;
}

/** A transcript past this is read from its end; a peak before it is missed. */
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

const addModel = (models: string[], model: unknown) => {
  if (typeof model !== "string" || !model.trim()) return;
  if (!models.some((known) => known.toLowerCase() === model.toLowerCase()))
    models.push(model);
};

/** Every `token_count` and `turn_context` in a Codex rollout. */
export function codexUsageHistory(text: string): SessionUsageHistory {
  const models: string[] = [];
  let peakTokens: number | undefined;
  let peakPercent: number | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes("token_count") && !line.includes("turn_context"))
      continue;
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        payload?: {
          type?: unknown;
          model?: unknown;
          info?: {
            last_token_usage?: { total_tokens?: unknown };
            model_context_window?: unknown;
          };
        };
      };
      if (event.type === "turn_context") addModel(models, event.payload?.model);
      if (event.payload?.type !== "token_count") continue;
      const used = finiteNumber(
        event.payload.info?.last_token_usage?.total_tokens,
      );
      const window = finiteNumber(event.payload.info?.model_context_window);
      if (used === undefined) continue;
      peakTokens = Math.max(peakTokens ?? 0, used);
      if (window && window > 0)
        peakPercent = Math.max(peakPercent ?? 0, (used / window) * 100);
    } catch {
      // A line cut by the read window is expected; it carries nothing.
    }
  }
  return {
    models,
    ...(peakTokens === undefined ? {} : { peakTokens }),
    ...(peakPercent === undefined
      ? {}
      : { peakPercent: Math.min(100, peakPercent) }),
  };
}

/**
 * Every assistant turn in a Claude transcript. The context window is not in
 * the transcript, so the percentage needs one from elsewhere: the status
 * line's reported size, or a `[1m]` suffix on the launch model.
 */
export function claudeUsageHistory(
  text: string,
  contextWindow?: number,
): SessionUsageHistory {
  const models: string[] = [];
  let peakTokens: number | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        message?: {
          model?: unknown;
          usage?: Record<string, unknown>;
        };
      };
      if (event.type !== "assistant" || !event.message?.usage) continue;
      const usage = event.message.usage;
      const used = [
        usage.input_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
        usage.output_tokens,
      ]
        .map((value) => finiteNumber(value) ?? 0)
        .reduce((total, value) => total + value, 0);
      // "<synthetic>" marks turns Claude Code wrote itself, not a model.
      if (event.message.model !== "<synthetic>")
        addModel(models, event.message.model);
      if (used > 0) peakTokens = Math.max(peakTokens ?? 0, used);
    } catch {
      // As above.
    }
  }
  return {
    models,
    ...(peakTokens === undefined ? {} : { peakTokens }),
    ...(peakTokens !== undefined && contextWindow
      ? { peakPercent: Math.min(100, (peakTokens / contextWindow) * 100) }
      : {}),
  };
}

async function readHistoryText(path: string): Promise<string | undefined> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    return await file.slice(Math.max(0, file.size - MAX_HISTORY_BYTES)).text();
  } catch {
    return undefined;
  }
}

export class TelemetryService {
  private sessionCache?: { expiresAt: number; value: TelemetrySnapshot };
  private providerCache?: { expiresAt: number; value?: ProviderUsage };

  /** Keyed by file path; reused while the file's size and mtime hold. */
  private readonly historyCache = new Map<
    string,
    { size: number; modified: number; value: SessionUsageHistory }
  >();

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly config: DaedalusConfig,
  ) {}

  private async cachedHistory(
    path: string,
    read: (text: string) => SessionUsageHistory,
  ): Promise<SessionUsageHistory | undefined> {
    let stat: { size: number; modified: number };
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      stat = { size: file.size, modified: file.lastModified };
    } catch {
      return undefined;
    }
    const cached = this.historyCache.get(path);
    if (
      cached &&
      cached.size === stat.size &&
      cached.modified === stat.modified
    )
      return cached.value;
    const text = await readHistoryText(path);
    if (text === undefined) return undefined;
    const value = read(text);
    this.historyCache.set(path, { ...stat, value });
    return value;
  }

  /**
   * What one session used over its whole life, live or finished. Absent
   * files degrade to what the launch arguments say, never to an error: a
   * session whose transcript is gone still has a model it was started with.
   */
  async sessionUsage(agent: AgentSession): Promise<SessionUsageHistory> {
    const launched = sessionLaunchModel(agent.args);
    // What the transcript names is what ran. The launch argument is often an
    // alias for the same model ("opus[1m]" for "claude-opus-5"), so it only
    // speaks when the transcript is silent.
    const merge = (history?: SessionUsageHistory): SessionUsageHistory => {
      const models: string[] = [];
      for (const model of history?.models ?? []) addModel(models, model);
      if (models.length === 0) addModel(models, launched);
      return { ...history, models };
    };
    if (agent.kind !== "agent") return { models: [] };
    if (agent.provider === "codex") {
      const path = await codexRolloutPath(
        this.config.codexSessionsDirectory,
        agent,
      );
      return merge(
        path ? await this.cachedHistory(path, codexUsageHistory) : undefined,
      );
    }
    if (agent.provider === "claude") {
      const status = await readClaudeStatusPayload(this.config, agent);
      const window =
        finiteNumber(status?.context_window?.context_window_size) ??
        contextWindowFromModel(launched);
      const history = await this.cachedHistory(
        claudeTranscriptPath(this.config.claudeProjectsDirectory, agent),
        (text) => claudeUsageHistory(text, window),
      );
      // The status line's own percentage is a reading the transcript may not
      // reach, so it is a floor under the peak rather than ignored.
      const reported = percentage(status?.context_window?.used_percentage);
      const peakPercent =
        reported === undefined
          ? history?.peakPercent
          : Math.max(reported, history?.peakPercent ?? 0);
      return merge({
        models: history?.models ?? [],
        ...(history?.peakTokens === undefined
          ? {}
          : { peakTokens: history.peakTokens }),
        ...(peakPercent === undefined ? {} : { peakPercent }),
      });
    }
    return merge();
  }

  async read(): Promise<TelemetrySnapshot> {
    const now = Date.now();
    if (this.sessionCache && this.sessionCache.expiresAt > now)
      return this.sessionCache.value;
    const results = await this.readLiveSessions();
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

  /**
   * Model and context for every live agent session, without the provider's
   * rate-limit windows. Those take a provider round trip, and a caller that
   * only wants to know which model a session runs should not wait on it.
   */
  async sessionTelemetry(): Promise<SessionTelemetry[]> {
    return (await this.readLiveSessions())
      .map((result) => result.session)
      .filter((item): item is SessionTelemetry => Boolean(item));
  }

  private async readLiveSessions(): Promise<
    Array<{ session?: SessionTelemetry; usage?: ProviderUsage }>
  > {
    const agents = this.repositories
      .listAgents()
      .filter(
        (agent) =>
          agent.kind === "agent" &&
          (agent.status === "running" || agent.status === "starting"),
      );
    return Promise.all(
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
  }
}

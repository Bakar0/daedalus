import { join } from "node:path";
import type { DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";
import { accountConfig } from "./account-homes";
import { claudeTranscriptPath } from "./telemetry";

/**
 * A message in a session's main conversation, as its agent's transcript
 * holds it: what the user typed and what the agent wrote, without tool calls
 * or their output. A thread hangs off one of these by `id`, which is the
 * provider's own and never changes: Claude's entry `uuid`, Codex's message
 * `id`. Terminal lines are never used to find a message; they move on every
 * resize and redraw.
 */
export interface MainMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  at: string;
}

/** How much of a transcript is read, from its end. */
const TAIL_BYTES = 4 * 1024 * 1024;

/** Text Claude records as a user turn that the user never typed. */
const CLAUDE_INJECTED =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr|task-notification)\b/;

/** Text Codex records as a user message that the user never typed. */
const CODEX_INJECTED =
  /^\s*(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<turn_aborted>)/;

interface ClaudeBlock {
  type?: unknown;
  text?: unknown;
}

const jsonLines = (text: string): unknown[] =>
  text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      // The first line of a tail is usually cut in half.
      return [];
    }
  });

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The messages in a Claude transcript, oldest first. */
export function parseClaudeMessages(text: string): MainMessage[] {
  const messages: MainMessage[] = [];
  for (const line of jsonLines(text)) {
    const entry = record(line);
    if (!entry || typeof entry.uuid !== "string") continue;
    if (entry.isMeta === true || entry.isSidechain === true) continue;
    const role =
      entry.type === "user" ? "user" : entry.type === "assistant" ? "agent" : 0;
    if (!role) continue;
    const content = record(entry.message)?.content;
    let body: string;
    if (typeof content === "string") body = content;
    else if (Array.isArray(content))
      body = (content as ClaudeBlock[])
        .filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text as string)
        .join("\n");
    else continue;
    body = body.trim();
    if (!body || (role === "user" && CLAUDE_INJECTED.test(body))) continue;
    messages.push({
      id: entry.uuid,
      role,
      text: body,
      at: typeof entry.timestamp === "string" ? entry.timestamp : "",
    });
  }
  return messages;
}

/** The messages in a Codex rollout, oldest first. */
export function parseCodexMessages(text: string): MainMessage[] {
  const messages: MainMessage[] = [];
  for (const line of jsonLines(text)) {
    const entry = record(line);
    if (entry?.type !== "response_item") continue;
    const payload = record(entry.payload);
    if (payload?.type !== "message" || typeof payload.id !== "string") continue;
    const role =
      payload.role === "user"
        ? "user"
        : payload.role === "assistant"
          ? "agent"
          : 0;
    if (!role || !Array.isArray(payload.content)) continue;
    const body = (payload.content as ClaudeBlock[])
      .filter(
        (block) =>
          (block.type === "input_text" || block.type === "output_text") &&
          typeof block.text === "string",
      )
      .map((block) => block.text as string)
      .join("\n")
      .trim();
    if (!body || (role === "user" && CODEX_INJECTED.test(body))) continue;
    messages.push({
      id: payload.id,
      role,
      text: body,
      at: typeof entry.timestamp === "string" ? entry.timestamp : "",
    });
  }
  return messages;
}

async function tail(path: string): Promise<string | undefined> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    return await file.slice(Math.max(0, file.size - TAIL_BYTES)).text();
  } catch {
    return undefined;
  }
}

/** The rollout file of a Codex session, or undefined before it writes one. */
async function codexRollout(
  sessionsDirectory: string,
  id: string,
): Promise<string | undefined> {
  try {
    const glob = new Bun.Glob(`*/*/*/rollout-*-${id}.jsonl`);
    let found: string | undefined;
    for await (const path of glob.scan({
      cwd: sessionsDirectory,
      onlyFiles: true,
    }))
      found = join(sessionsDirectory, path);
    return found;
  } catch {
    return undefined;
  }
}

/**
 * A session's main messages, oldest first, from the end of its transcript.
 * Empty for a session with no transcript yet or a provider that keeps none.
 */
export async function readMainMessages(
  shared: DaedalusConfig,
  agent: AgentSession,
): Promise<MainMessage[]> {
  if (agent.kind !== "agent") return [];
  const config = accountConfig(shared, agent.provider, agent.account);
  if (agent.provider === "claude") {
    const text = await tail(
      claudeTranscriptPath(config.claudeProjectsDirectory, agent),
    );
    return text ? parseClaudeMessages(text) : [];
  }
  if (agent.provider === "codex") {
    const path = await codexRollout(
      config.codexSessionsDirectory,
      agent.providerSessionId ?? agent.id,
    );
    const text = path ? await tail(path) : undefined;
    return text ? parseCodexMessages(text) : [];
  }
  return [];
}

/** The last thing the agent wrote in main: what a new thread hangs off. */
export const lastAgentMessage = (
  messages: readonly MainMessage[],
): MainMessage | undefined =>
  messages.findLast((message) => message.role === "agent");

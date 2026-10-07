import { createConnection } from "node:net";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, type CommandResult } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";
import { accountConfig, accountEnvironment } from "./account-homes";

/** One delivery of team chat messages into a member's or the lead's session. */
export interface TeamDelivery {
  session: AgentSession;
  text: string;
  /** Who it is from, as the session shows it: `[team "API"] server-worker`. */
  from: string;
}

/**
 * How a team chat message reaches a running session without typing into its
 * pane. Throws when it was not delivered, with a reason fit for `team list`.
 */
export interface TeamTransport {
  deliver(delivery: TeamDelivery): Promise<void>;
}

/** How long a socket write or `codex queue` may take before it counts as failed. */
const DELIVERY_TIMEOUT_MS = 5_000;

/**
 * Claude through the session's inbox socket, Codex through `codex queue`.
 * Neither touches what the user is typing, and a busy session gets the
 * message in or after its current turn.
 */
export class ProviderTeamTransport implements TeamTransport {
  constructor(
    private readonly config: DaedalusConfig,
    private readonly codexExecutable: (
      session: AgentSession,
    ) => string | undefined,
    private readonly run: (
      executable: string,
      args: string[],
      options: { cwd: string; env: Record<string, string>; timeoutMs: number },
    ) => Promise<CommandResult> = runCommand,
  ) {}

  async deliver(delivery: TeamDelivery): Promise<void> {
    const { session } = delivery;
    if (session.provider === "claude") return this.deliverToClaude(delivery);
    if (session.provider === "codex") return this.deliverToCodex(delivery);
    throw new Error(`A ${session.provider} session has no team inbox`);
  }

  private async deliverToClaude(delivery: TeamDelivery): Promise<void> {
    const sessionId = delivery.session.providerSessionId ?? delivery.session.id;
    const { claudeHome } = accountConfig(
      this.config,
      "claude",
      delivery.session.account,
    );
    const inbox = await findClaudeInbox(claudeHome, sessionId);
    if (!inbox)
      throw new Error(
        `Claude has no live session ${sessionId} under ${join(claudeHome, "sessions")}; it may not be running yet, or /clear gave it a new id`,
      );
    await writeSocketLine(
      inbox.socketPath,
      claudeInboxLine({ text: delivery.text, from: delivery.from, sessionId }),
    );
  }

  private async deliverToCodex(delivery: TeamDelivery): Promise<void> {
    const { session } = delivery;
    if (!session.providerSessionId)
      throw new Error("Daedalus has not found this Codex session's thread id");
    const codex = this.codexExecutable(session);
    if (!codex) throw new Error("Codex is not installed");
    const result = await this.run(
      codex,
      codexQueueArgs(session.providerSessionId, delivery.text),
      {
        cwd: session.workingDirectory,
        env: accountEnvironment(this.config, "codex", session.account),
        timeoutMs: DELIVERY_TIMEOUT_MS,
      },
    );
    if (result.exitCode !== 0)
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `codex queue exited with code ${result.exitCode}`,
      );
  }
}

export const codexQueueArgs = (threadId: string, text: string): string[] => [
  "queue",
  "--thread",
  threadId,
  "--message",
  text,
];

/**
 * The line Claude reads from its inbox socket as a message from another
 * session. Not in Claude's public docs; its debug log prints the shape.
 */
export const claudeInboxLine = (input: {
  text: string;
  from: string;
  sessionId: string;
}): string =>
  `${JSON.stringify({
    type: "user",
    message: { role: "user", content: input.text },
    from: input.from,
    session_id: input.sessionId,
  })}\n`;

interface ClaudeSessionFile {
  pid?: unknown;
  sessionId?: unknown;
  messagingSocketPath?: unknown;
  updatedAt?: unknown;
}

/**
 * The inbox of the live Claude process running a conversation. Each process
 * writes `<claudeHome>/sessions/<pid>.json`; a file can outlive its process,
 * so only a pid that still exists counts, and the newest file wins.
 */
export async function findClaudeInbox(
  claudeHome: string,
  sessionId: string,
  alive: (pid: number) => boolean = processAlive,
): Promise<{ pid: number; socketPath: string } | undefined> {
  const directory = join(claudeHome, "sessions");
  const names = await readdir(directory).catch(() => [] as string[]);
  let best: { pid: number; socketPath: string; updatedAt: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = (await Bun.file(join(directory, name))
      .json()
      .catch(() => undefined)) as ClaudeSessionFile | undefined;
    if (
      !file ||
      file.sessionId !== sessionId ||
      typeof file.messagingSocketPath !== "string" ||
      typeof file.pid !== "number" ||
      !alive(file.pid)
    )
      continue;
    const updatedAt = typeof file.updatedAt === "number" ? file.updatedAt : 0;
    if (!best || updatedAt > best.updatedAt)
      best = { pid: file.pid, socketPath: file.messagingSocketPath, updatedAt };
  }
  return best && { pid: best.pid, socketPath: best.socketPath };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: another user's process, not ours to message.
    return false;
  }
}

/** Writes one line to a Unix socket and closes it. */
export function writeSocketLine(
  socketPath: string,
  line: string,
  timeoutMs = DELIVERY_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Claude's inbox at ${socketPath} did not answer`));
    }, timeoutMs);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Claude's inbox at ${socketPath}: ${error.message}`));
    });
    socket.on("connect", () => {
      socket.end(line, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

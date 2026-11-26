import { chmod, mkdir, open, rm, stat } from "node:fs/promises";
import { DaedalusError } from "../errors";
import {
  acpPaths,
  type AcpCommand,
  type AcpHostEvent,
  type AcpLaunch,
  type AcpLogEntry,
  type AcpPaths,
  type AcpReply,
} from "./acp-host";

/** How long a host gets to answer a command on its socket. */
const COMMAND_TIMEOUT_MS = 5_000;

export interface AcpEvents {
  entries: AcpLogEntry[];
  /** The byte to read from next time. */
  offset: number;
}

/** Sends one command line to a host's socket and reads its one reply line. */
function sendCommand(
  socketPath: string,
  command: AcpCommand,
): Promise<AcpReply> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (reply: AcpReply | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reply instanceof Error) reject(reply);
      else resolve(reply);
    };
    const timer = setTimeout(
      () => finish(new Error("The agent's host did not answer")),
      COMMAND_TIMEOUT_MS,
    );
    Bun.connect({
      unix: socketPath,
      socket: {
        open: (socket) => {
          socket.write(`${JSON.stringify(command)}\n`);
        },
        data: (socket, chunk) => {
          buffer += chunk.toString();
          const at = buffer.indexOf("\n");
          if (at < 0) return;
          try {
            finish(JSON.parse(buffer.slice(0, at)) as AcpReply);
          } catch {
            finish(new Error("The agent's host sent no reply"));
          }
          socket.end();
        },
        close: () =>
          finish(new Error("The agent's host closed the connection")),
        error: (_socket, error) => finish(error),
        connectError: (_socket, error) => finish(error),
      },
    }).catch((error: unknown) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

/**
 * The app's side of an agent that runs over ACP: it writes what the host is
 * to run, sends the host commands, and reads what the host logged. See
 * `AcpHost` for the other side.
 */
export class AcpService {
  constructor(private readonly home: string) {}

  paths(sessionId: string): AcpPaths {
    return acpPaths(this.home, sessionId);
  }

  /** Writes the file `daedal acp-host` reads, and returns its path. */
  async writeLaunch(launch: AcpLaunch): Promise<string> {
    const paths = this.paths(launch.sessionId);
    await mkdir(paths.directory, { recursive: true });
    await Bun.write(paths.launch, JSON.stringify(launch));
    // It holds the first prompt and the adapter's options.
    await chmod(paths.launch, 0o600);
    return paths.launch;
  }

  /** The model a session was last launched with, when one was chosen. */
  async launchModel(sessionId: string): Promise<string | undefined> {
    const launch = (await Bun.file(this.paths(sessionId).launch)
      .json()
      .catch(() => undefined)) as Partial<AcpLaunch> | undefined;
    return typeof launch?.model === "string" ? launch.model : undefined;
  }

  /** Sends text as a turn. During a turn it waits for that turn to end. */
  prompt(sessionId: string, text: string): Promise<void> {
    return this.command(sessionId, { type: "prompt", text });
  }

  /** Ends the turn the agent is on. */
  cancel(sessionId: string): Promise<void> {
    return this.command(sessionId, { type: "cancel" });
  }

  answerPermission(
    sessionId: string,
    requestId: number | string,
    optionId: string,
  ): Promise<void> {
    return this.command(sessionId, { type: "permission", requestId, optionId });
  }

  setMode(sessionId: string, modeId: string): Promise<void> {
    return this.command(sessionId, { type: "mode", modeId });
  }

  /** Asks the host to end its adapter and exit. */
  stop(sessionId: string): Promise<void> {
    return this.command(sessionId, { type: "stop" });
  }

  /**
   * What the host logged from `offset` on. A line still being written is left
   * for the next read, so an entry is never returned in halves.
   */
  async events(sessionId: string, offset = 0): Promise<AcpEvents> {
    const { log } = this.paths(sessionId);
    const size = await stat(log).then(
      (found) => found.size,
      () => 0,
    );
    // A log shorter than the offset is a new one: start it from the top.
    const from = offset > size ? 0 : offset;
    if (size === from) return { entries: [], offset: from };
    const file = await open(log, "r");
    try {
      const bytes = Buffer.alloc(size - from);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, from);
      const end = bytes.lastIndexOf(0x0a, bytesRead - 1);
      if (end < 0) return { entries: [], offset: from };
      const entries: AcpLogEntry[] = [];
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
        if (!line) continue;
        try {
          entries.push(JSON.parse(line) as AcpLogEntry);
        } catch {
          // A line the host did not finish before it died.
        }
      }
      return { entries, offset: from + end + 1 };
    } finally {
      await file.close();
    }
  }

  /**
   * Waits for the host to open its ACP session and resolves with that
   * session's id. Rejects when the host reports an error or exits first.
   */
  async waitReady(
    sessionId: string,
    timeoutMs: number,
  ): Promise<Extract<AcpHostEvent, { type: "ready" }>> {
    const deadline = Date.now() + timeoutMs;
    let offset = 0;
    let lastError: string | undefined;
    for (;;) {
      const read = await this.events(sessionId, offset);
      offset = read.offset;
      for (const entry of read.entries) {
        if (entry.from !== "host") continue;
        if (entry.event.type === "ready") return entry.event;
        if (entry.event.type === "error") lastError = entry.event.message;
        if (entry.event.type === "stderr") lastError ??= entry.event.text;
        if (entry.event.type === "exit")
          throw new DaedalusError(
            "DEPENDENCY",
            `The agent did not start: ${lastError ?? `it exited with code ${entry.event.code}`}`,
          );
      }
      if (Date.now() >= deadline)
        throw new DaedalusError(
          "DEPENDENCY",
          `The agent did not start in ${Math.round(timeoutMs / 1000)} seconds${lastError ? `: ${lastError}` : ""}`,
        );
      await Bun.sleep(100);
    }
  }

  /** Removes a session's host files. Its conversation is the provider's own. */
  async remove(sessionId: string): Promise<void> {
    const paths = this.paths(sessionId);
    await Promise.all(
      [paths.log, paths.socket, paths.launch].map((path) =>
        rm(path, { force: true }),
      ),
    );
  }

  private async command(sessionId: string, command: AcpCommand): Promise<void> {
    let reply: AcpReply;
    try {
      reply = await sendCommand(this.paths(sessionId).socket, command);
    } catch (error) {
      throw new DaedalusError(
        "CONFLICT",
        `The agent's host is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!reply.ok) throw new DaedalusError("CONFLICT", reply.error);
  }
}

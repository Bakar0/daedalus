import { chmod, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { emptyAcpLive, reduceAcpLive, type AcpLive } from "../domain/acp-live";
import { DaedalusError } from "../errors";
import {
  acpPaths,
  parseAcpLogEntry,
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
    let open: { end(): void } | undefined;
    const finish = (reply: AcpReply | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      open?.end();
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
          open = socket;
          // Too late: the wait for it already ended.
          if (settled) socket.end();
          else socket.write(`${JSON.stringify(command)}\n`);
        },
        data: (_socket, chunk) => {
          buffer += chunk.toString();
          const at = buffer.indexOf("\n");
          if (at < 0) return;
          finish(
            parseReply(buffer.slice(0, at)) ??
              new Error("The agent's host sent no reply"),
          );
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

function parseReply(line: string): AcpReply | undefined {
  try {
    const reply: unknown = JSON.parse(line);
    if (typeof reply !== "object" || reply === null) return undefined;
    const { ok, error } = reply as { ok?: unknown; error?: unknown };
    if (ok === true) return { ok: true };
    return ok === false
      ? { ok: false, error: typeof error === "string" ? error : "Refused" }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The app's side of an agent that runs over ACP: it writes what the host is
 * to run, sends the host commands, and reads what the host logged. See
 * `AcpHost` for the other side.
 */
export class AcpService {
  private readonly lives = new Map<
    string,
    { file: string; offset: number; live: AcpLive }
  >();

  constructor(private readonly home: string) {}

  paths(sessionId: string): AcpPaths {
    return acpPaths(this.home, sessionId);
  }

  /** Writes the file `daedal acp-host` reads, and returns its path. */
  async writeLaunch(launch: AcpLaunch): Promise<string> {
    const paths = this.paths(launch.sessionId);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    // The owner's only from the start: it holds the first prompt.
    await writeFile(paths.launch, JSON.stringify(launch), { mode: 0o600 });
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
          const entry = parseAcpLogEntry(JSON.parse(line));
          if (entry) entries.push(entry);
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
   * What the agent is doing now. Each call reads only what the host logged
   * since the last one.
   */
  async live(sessionId: string): Promise<AcpLive> {
    // A relaunched host starts a new log file, whoever relaunched it: the
    // file's own identity says so, where its length and numbers may not.
    const file = await stat(this.paths(sessionId).log).then(
      (found) => `${found.ino}:${found.birthtimeMs}`,
      () => undefined,
    );
    if (file === undefined) {
      this.lives.delete(sessionId);
      return emptyAcpLive();
    }
    const cached = this.lives.get(sessionId);
    const known =
      cached?.file === file
        ? cached
        : { file, offset: 0, live: emptyAcpLive() };
    const read = await this.events(sessionId, known.offset);
    let { live } = known;
    for (const entry of read.entries) live = reduceAcpLive(live, entry);
    this.lives.set(sessionId, { file, offset: read.offset, live });
    return live;
  }

  /** Forgets what was read of sessions that are not among `sessionIds`. */
  keepOnly(sessionIds: ReadonlySet<string>): void {
    for (const id of this.lives.keys())
      if (!sessionIds.has(id)) this.lives.delete(id);
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
    /** The adapter's last line on stderr, which is where it says why it quit. */
    let lastSaid: string | undefined;
    for (;;) {
      const read = await this.events(sessionId, offset);
      offset = read.offset;
      for (const entry of read.entries) {
        if (entry.from !== "host") continue;
        if (entry.event.type === "ready") return entry.event;
        if (entry.event.type === "error") lastError = entry.event.message;
        if (entry.event.type === "stderr") lastSaid = entry.event.text;
        if (entry.event.type === "exit")
          throw new DaedalusError(
            "DEPENDENCY",
            `The agent did not start: ${lastError ?? lastSaid ?? `it exited with code ${entry.event.code}`}`,
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
    this.lives.delete(sessionId);
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

import { PresenceService, type PresenceReport } from "./presence";
import { systemIdleSeconds } from "@daedalus/platform";

/** How often the sidecar writes when the window is quiet; see `keepAlive`. */
export const HEARTBEAT_INTERVAL_MS = 1_200;

/** How often the sidecar asks the system for the idle time. */
export const IDLE_SAMPLE_INTERVAL_MS = 5_000;

export interface PresenceHeartbeatOptions {
  presence: PresenceService;
  /** The process whose presence this is; the loop ends when it is gone. */
  hostPid: number;
  /** JSON `PresenceReport`s, one per line, as the host forwards them. */
  reports: AsyncIterable<string>;
  intervalMs?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

/** `kill(pid, 0)` delivers nothing and fails only when there is no such process. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else; the host
    // and its sidecar share a user, so that never applies here.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The default idle probe spawns `ioreg`, and `posix_spawn` blocks the thread
 * until the child has started. That is the very delay the sidecar exists to
 * escape, so it samples in the background and answers from the last value.
 * A first call before any sample has landed reads as present; see
 * `systemIdleSeconds` for why that is the safe side.
 */
export function cachedIdleSampler(
  sample: () => Promise<number> = () => systemIdleSeconds(),
  intervalMs = IDLE_SAMPLE_INTERVAL_MS,
  now: () => number = Date.now,
): () => Promise<number> {
  let value = 0;
  // Never sampled yet, so the first call kicks one off whatever the clock.
  let sampledAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  return async () => {
    if (!inFlight && now() - sampledAt >= intervalMs) {
      inFlight = sample()
        .then((seconds) => {
          value = seconds;
          sampledAt = now();
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
        });
    }
    return value;
  };
}

/** One forwarded report, or `null` for a line that is not one. */
export function parsePresenceReport(line: string): PresenceReport | null {
  try {
    const value = JSON.parse(line) as Partial<PresenceReport>;
    if (typeof value !== "object" || value === null) return null;
    if (typeof value.appForeground !== "boolean") return null;
    return {
      appForeground: value.appForeground,
      workspaceId:
        typeof value.workspaceId === "string" ? value.workspaceId : null,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    };
  } catch {
    return null;
  }
}

/** Splits a byte stream into lines, without the terminator. */
export async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      yield pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  if (pending) yield pending;
}

/**
 * The heartbeat loop the sidecar runs: publish every report the host
 * forwards, stand in for a quiet window every `intervalMs`, and stop when
 * the host is gone or has closed the pipe. Resolves when it stops. It never
 * removes the file; a heartbeat that simply stops going stale is the honest
 * signal, and the host's `retire` removes it on an orderly quit.
 */
export async function runPresenceHeartbeat(
  options: PresenceHeartbeatOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const isAlive = options.isAlive ?? processIsAlive;
  const now = options.now ?? Date.now;
  let stopped = false;
  let resolveStop: () => void = () => undefined;
  const stop = () => {
    stopped = true;
    resolveStop();
  };
  const done = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  const timer = setInterval(() => {
    if (stopped) return;
    if (!isAlive(options.hostPid)) {
      stop();
      return;
    }
    void options.presence.keepAlive(now()).catch(() => undefined);
  }, intervalMs);

  void (async () => {
    try {
      for await (const line of options.reports) {
        if (stopped) break;
        const report = parsePresenceReport(line);
        if (report)
          await options.presence.publish(report, now()).catch(() => undefined);
      }
    } finally {
      // The host closed the pipe, which it only does on its way out.
      stop();
    }
  })();

  await done;
  clearInterval(timer);
}

import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureDirectory,
  findExecutable,
  runCommand,
  standardExecutableFallbacks,
  systemIdleSeconds,
} from "@daedalus/platform";
import {
  channelIdentifier,
  saveFocusMode,
  type DaedalusConfig,
} from "../config";
import type { PresenceState } from "../domain";

/**
 * A presence sample older than this is treated as "the app is not running".
 * The desktop host republishes every 1.2 s alongside its change check, so the
 * window is wide enough to survive a slow tick and short enough that a crashed
 * app stops absorbing notifications within a few seconds.
 */
export const PRESENCE_MAX_AGE_MS = 8_000;

/**
 * Past this, assume an in-app toast will go unseen and prefer a desktop
 * notification. Borrowed from dev-3.0, which treats five minutes of idleness
 * as the point where the screen stops being a delivery channel.
 */
export const IDLE_SECONDS_THRESHOLD = 300;

/** A focus request older than this is stale and is dropped rather than obeyed. */
export const FOCUS_REQUEST_MAX_AGE_MS = 60_000;

export interface FocusRequest {
  sessionId: string;
  requestedAt: string;
}

export interface PresenceReport {
  appForeground: boolean;
  workspaceId: string | null;
  sessionId: string | null;
}

const OFFLINE: PresenceState = {
  appRunning: false,
  appForeground: false,
  workspaceId: null,
  sessionId: null,
  userIdleSeconds: 0,
  observedAt: new Date(0).toISOString(),
};

interface StoredPresence extends PresenceReport {
  userIdleSeconds: number;
  observedAt: string;
}

/**
 * Presence lives in a file rather than the database because it is a heartbeat,
 * not a record: it is rewritten every second or two by exactly one writer (the
 * desktop app) and read by every CLI process that wants to know whether an
 * alert has anywhere to land. Putting it in SQLite would churn the WAL and
 * make every `daedal attention` call look like a data change to the app.
 */
export class PresenceService {
  constructor(private readonly config: DaedalusConfig) {}

  private get path(): string {
    return join(this.config.home, "presence.json");
  }

  async read(now = Date.now()): Promise<PresenceState> {
    try {
      const stored = (await Bun.file(this.path).json()) as StoredPresence;
      const observedAt = Date.parse(stored.observedAt);
      if (!Number.isFinite(observedAt)) return OFFLINE;
      // A stale heartbeat is not "the user is away from a running app"; it is
      // "there is no app", which routes to desktop rather than to a toast that
      // nothing would ever draw.
      if (now - observedAt > PRESENCE_MAX_AGE_MS)
        return { ...OFFLINE, observedAt: stored.observedAt };
      return {
        appRunning: true,
        appForeground: stored.appForeground === true,
        workspaceId: stored.workspaceId ?? null,
        sessionId: stored.sessionId ?? null,
        userIdleSeconds: Number.isFinite(stored.userIdleSeconds)
          ? stored.userIdleSeconds
          : 0,
        observedAt: stored.observedAt,
      };
    } catch {
      return OFFLINE;
    }
  }

  /** Called by the desktop app on every change-check tick. */
  async publish(report: PresenceReport): Promise<PresenceState> {
    const state: PresenceState = {
      appRunning: true,
      ...report,
      userIdleSeconds: await systemIdleSeconds(),
      observedAt: new Date().toISOString(),
    };
    await ensureDirectory(this.config.home);
    const temporaryPath = join(
      this.config.home,
      `presence.${crypto.randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, JSON.stringify(state), { flag: "wx" });
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return state;
  }

  /** Clears the heartbeat so the next reader sees the app as gone. */
  async retire(): Promise<void> {
    await rm(this.path, { force: true });
  }

  private get focusRequestPath(): string {
    return join(this.config.home, "focus-request.json");
  }

  /**
   * Parks a request for the app to select a session, and raises the app. Split
   * this way because the process that decides to focus something — a clicked
   * notification, running `daedal focus` — is almost never the app itself.
   */
  async requestFocus(sessionId: string): Promise<{ raised: boolean }> {
    await ensureDirectory(this.config.home);
    const temporaryPath = join(
      this.config.home,
      `focus-request.${crypto.randomUUID()}.tmp`,
    );
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify({
          sessionId,
          requestedAt: new Date().toISOString(),
        } satisfies FocusRequest),
        { flag: "wx" },
      );
      await rename(temporaryPath, this.focusRequestPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    const open = findExecutable("open", standardExecutableFallbacks("open"));
    if (!open) return { raised: false };
    // A dev home must raise the dev app: they are separate applications and
    // macOS keys activation off the identifier.
    const result = await runCommand(open, [
      "-b",
      channelIdentifier(this.config.home),
    ]);
    return { raised: result.exitCode === 0 };
  }

  /**
   * Reads and consumes a pending request. Consuming is the point: a focus that
   * fired once must not fire again on the next tick.
   */
  async takeFocusRequest(now = Date.now()): Promise<FocusRequest | undefined> {
    let request: FocusRequest;
    try {
      request = (await Bun.file(this.focusRequestPath).json()) as FocusRequest;
    } catch {
      return undefined;
    }
    await rm(this.focusRequestPath, { force: true });
    const requestedAt = Date.parse(request.requestedAt);
    if (!Number.isFinite(requestedAt)) return undefined;
    // Yanking the user somewhere because of a notification they ignored an
    // hour ago is worse than doing nothing.
    if (now - requestedAt > FOCUS_REQUEST_MAX_AGE_MS) return undefined;
    return request;
  }

  get focusMode(): boolean {
    return this.config.focusMode;
  }

  async setFocusMode(enabled: boolean): Promise<boolean> {
    await saveFocusMode(this.config, enabled);
    return enabled;
  }
}

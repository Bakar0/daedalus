import {
  sendNativeNotification,
  type NativeNotification,
  type NativeNotifierResult,
} from "@daedalus/platform";
import type {
  NotificationChannel,
  NotificationLevel,
  PendingNotification,
  PresenceState,
} from "../domain";
import type { SqliteRepositories } from "../repositories";
import { IDLE_SECONDS_THRESHOLD, type PresenceService } from "./presence";

export interface NotificationRequest {
  sessionId?: string | null;
  workspaceId?: string | null;
  level: NotificationLevel;
  title: string;
  /** Second line of a desktop alert: workspace, session, task number. */
  subtitle?: string;
  body: string;
  /**
   * The user has to act before the session can continue. A blocking alert
   * always leaves a badge behind, and reaches the user wherever they are.
   */
  blocking?: boolean;
  /** Ask for the desktop channel regardless of where the user is. */
  desktop?: boolean;
}

export type NotificationSuppression =
  "focus_mode" | "on_screen" | "debounced" | null;

export interface NotificationDecision {
  delivered: NotificationChannel[];
  suppressed: NotificationSuppression;
  /** Human-readable, and deliberately explicit: callers must be able to tell
   * suppression from failure. */
  reason: string;
  /** True when the alert was parked for a surface that is not up yet. */
  queued: boolean;
  /** Set when a native alert fired but could not be made clickable. */
  degraded?: boolean;
}

/**
 * Picks the one channel that has a chance of being seen. The mistake this
 * avoids is treating "notify" as a single thing: a toast sent to a
 * backgrounded app is a dropped alert, and a desktop notification sent to
 * someone already looking at the session is noise.
 */
export function routeNotification(
  presence: PresenceState,
  request: NotificationRequest,
  focusMode: boolean,
): {
  channel: "toast" | "desktop" | null;
  suppressed: NotificationSuppression;
} {
  const present =
    presence.appRunning && presence.userIdleSeconds < IDLE_SECONDS_THRESHOLD;
  const watching =
    present &&
    presence.appForeground &&
    Boolean(request.sessionId) &&
    presence.sessionId === request.sessionId;
  // Already on screen: the indicator has said it. A second alert for what the
  // user is looking at is what teaches people to dismiss alerts unread.
  if (watching && !request.desktop)
    return { channel: null, suppressed: "on_screen" };
  if (focusMode) return { channel: null, suppressed: "focus_mode" };
  const away = !present || !presence.appForeground;
  return {
    channel: request.desktop || away ? "desktop" : "toast",
    suppressed: null,
  };
}

export interface NotificationServiceOptions {
  /** Injected so tests never reach the real Notification Center. */
  sendNative?: (
    notification: NativeNotification,
  ) => Promise<NativeNotifierResult>;
  /** Set by the desktop host; a CLI has no window to draw a toast in. */
  canDrawToasts?: () => boolean;
  /**
   * The `daedal` shim, run when a desktop notification is clicked. Without it
   * the alert still fires but cannot open the session it is about.
   */
  cliExecutable?: string;
  bundleId?: string;
  /** Passed through to the platform notifier; see `NativeNotifierOptions`. */
  showInApp?: (notification: NativeNotification) => void;
}

export class NotificationService {
  private readonly sendNative: (
    notification: NativeNotification,
  ) => Promise<NativeNotifierResult>;
  private readonly canDrawToasts: () => boolean;
  private readonly cliExecutable?: string;
  private readonly bundleId?: string;
  private readonly showInApp?: (notification: NativeNotification) => void;

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly presence: PresenceService,
    options: NotificationServiceOptions = {},
  ) {
    this.showInApp = options.showInApp;
    this.sendNative =
      options.sendNative ??
      ((notification) =>
        sendNativeNotification(notification, {
          ...(this.showInApp ? { showInApp: this.showInApp } : {}),
        }));
    this.canDrawToasts = options.canDrawToasts ?? (() => false);
    this.cliExecutable = options.cliExecutable;
    this.bundleId = options.bundleId;
  }

  async notify(request: NotificationRequest): Promise<NotificationDecision> {
    const presence = await this.presence.read();
    const { channel, suppressed } = routeNotification(
      presence,
      request,
      this.presence.focusMode,
    );
    const delivered: NotificationChannel[] = request.blocking ? ["badge"] : [];
    if (!channel)
      return {
        delivered,
        suppressed,
        reason:
          suppressed === "focus_mode"
            ? "focus mode is on"
            : "the session is already on screen",
        queued: false,
      };
    if (channel === "toast") {
      // The window can be gone between the presence sample and now, and a
      // toast nobody drew is a lost alert, so it waits in the queue instead.
      const queued = !this.canDrawToasts();
      this.enqueue(request, "toast");
      return {
        delivered: [...delivered, "toast"],
        suppressed: null,
        reason: queued ? "queued for the next window" : "shown in the app",
        queued,
      };
    }
    // A CLI has no bundle of its own, so its AppleScript alerts are attributed
    // to Script Editor. When the app is up it can deliver the same alert as
    // Daedalus, so hand it over rather than shouting under a borrowed name.
    if (!this.canDrawToasts() && presence.appRunning) {
      this.enqueue(request, "desktop");
      return {
        delivered: [...delivered, "desktop"],
        suppressed: null,
        reason: "handed to the running app",
        queued: true,
      };
    }
    const result = await this.sendNative({
      title: request.title,
      ...(request.subtitle ? { subtitle: request.subtitle } : {}),
      body: request.body,
      ...(this.cliExecutable && request.sessionId
        ? {
            activate: {
              executable: this.cliExecutable,
              args: ["focus", request.sessionId],
            },
          }
        : {}),
      ...(this.bundleId ? { bundleId: this.bundleId } : {}),
    });
    if (!result.delivered) {
      this.enqueue(request, "desktop");
      return {
        delivered,
        suppressed: null,
        reason: "no notifier available; queued",
        queued: true,
      };
    }
    return {
      delivered: [...delivered, "desktop"],
      suppressed: null,
      reason: `delivered via ${result.backend}`,
      queued: false,
      degraded: result.degraded,
    };
  }

  private enqueue(
    request: NotificationRequest,
    channel: "toast" | "desktop",
  ): PendingNotification {
    const notification: PendingNotification = {
      id: crypto.randomUUID(),
      sessionId: request.sessionId ?? null,
      workspaceId: request.workspaceId ?? null,
      channel,
      level: request.level,
      title: request.title,
      body: request.body,
      createdAt: new Date().toISOString(),
    };
    this.repositories.createPendingNotification(notification);
    return notification;
  }

  pending(channel?: "toast" | "desktop"): PendingNotification[] {
    return this.repositories.listPendingNotifications(channel);
  }

  /** Drops a whole channel's queue without delivering it. */
  discardPending(channel: "toast" | "desktop"): void {
    this.repositories.deletePendingNotifications(
      this.repositories.listPendingNotifications(channel).map((it) => it.id),
    );
  }

  acknowledge(ids: string[]): void {
    this.repositories.deletePendingNotifications(ids);
  }

  /**
   * Delivers desktop alerts that were parked because no notifier was reachable
   * when they were raised, then drops them whether or not this attempt worked.
   * A queue that retries forever is a queue that eventually shouts a week of
   * stale alerts at someone.
   */
  async flushDesktop(
    limit = 10,
    maxAgeMs = Number.POSITIVE_INFINITY,
    now = Date.now(),
  ): Promise<number> {
    const queued = this.repositories
      .listPendingNotifications("desktop")
      .filter((item) => now - Date.parse(item.createdAt) <= maxAgeMs)
      .slice(0, limit);
    for (const notification of queued)
      await this.sendNative({
        title: notification.title,
        body: notification.body,
        ...(notification.sessionId && this.cliExecutable
          ? {
              activate: {
                executable: this.cliExecutable,
                args: ["focus", notification.sessionId],
              },
            }
          : {}),
        ...(this.bundleId ? { bundleId: this.bundleId } : {}),
      });
    this.repositories.deletePendingNotifications(
      this.repositories
        .listPendingNotifications("desktop")
        .map((item) => item.id),
    );
    return queued.length;
  }

  /**
   * Drops everything queued for a session. Called on every clear: badge events
   * queue while the app is not running, so without this a badge the agent
   * already retracted comes back to life the moment the queue flushes.
   */
  purge(sessionId: string): void {
    this.repositories.deletePendingNotificationsForSession(sessionId);
  }
}

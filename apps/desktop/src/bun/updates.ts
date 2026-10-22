import {
  chooseUpdate,
  type FeedRelease,
  type UpdateFeed,
} from "@daedalus/core";
import type { AppUpdateDto } from "@daedalus/protocol";

/**
 * The part of Electrobun's `Updater` this uses, so the controller can be
 * tested without a bundle or a network.
 */
export interface AppUpdater {
  /** The running build's version and channel, from its version.json. */
  local(): Promise<{ version: string; channel: string }>;
  /**
   * Reads one feed. `updateAvailable` is Electrobun's own answer, which only
   * compares bundle hashes.
   */
  check(feed: UpdateFeed): Promise<{
    version: string;
    updateAvailable: boolean;
    error?: string;
  }>;
  /** Fetches the new bundle from `feed`. `ready` is false when it failed. */
  download(feed: UpdateFeed): Promise<{ ready: boolean; error?: string }>;
  /** Replaces the app and quits; the new version opens on its own. */
  apply(): Promise<void>;
}

export interface UpdateControllerOptions {
  updater: AppUpdater;
  /**
   * The feeds to read, stable first: only stable, or stable and beta when
   * "Get beta updates" is on. Asked before every check, so the setting
   * applies without a restart.
   */
  feeds(): Promise<UpdateFeed[]>;
  /** The version the user said "Later" to, if any. */
  readDismissed(): Promise<string | undefined>;
  writeDismissed(version: string): Promise<void>;
  /** Sends the prompt to the window. */
  publish(update: AppUpdateDto | null): void;
  /** Runs just before the app replaces itself; the quit path's own cleanup. */
  beforeRestart?(): Promise<void>;
  log?(event: string, fields: Record<string, unknown>): void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  setRepeatingTimer?: (callback: () => void, ms: number) => unknown;
}

/** First check after launch: late enough not to compete with startup. */
export const FIRST_UPDATE_CHECK_DELAY_MS = 30_000;
/** Then every six hours, for an app that stays open for days. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Decides when the window offers a newer Daedalus, and installs it on request.
 *
 * Electrobun's updater calls any release whose bundle hash differs from the
 * running one an update. Every local `bun run app:install` build has its own
 * hash, so that alone would offer the published release to anyone running a
 * build of main, including one newer than the release. The prompt therefore
 * needs a strictly higher version as well.
 *
 * With beta updates on it reads the beta feed as well and offers the higher
 * of the two. Turning them off never moves anyone backwards: a beta build
 * sees no stable release as newer until one passes its version.
 *
 * A background check is silent unless it finds something: being offline or
 * up to date is not news. A check the user asked for from the menu always
 * answers.
 */
export class UpdateController {
  #update: AppUpdateDto | null = null;
  /** The feed the offered version came from; the download reads it. */
  #feed: UpdateFeed = "stable";
  #busy = false;

  constructor(private readonly options: UpdateControllerOptions) {}

  get update(): AppUpdateDto | null {
    return this.#update;
  }

  /** Schedules the background checks. Dev builds have no feed and skip it. */
  async start(): Promise<void> {
    const { channel } = await this.options.updater.local();
    if (channel === "dev") return;
    const setTimer =
      this.options.setTimer ??
      ((callback: () => void, ms: number) => setTimeout(callback, ms));
    const setRepeatingTimer =
      this.options.setRepeatingTimer ??
      ((callback: () => void, ms: number) => setInterval(callback, ms));
    setTimer(() => void this.check(), FIRST_UPDATE_CHECK_DELAY_MS);
    setRepeatingTimer(() => void this.check(), UPDATE_CHECK_INTERVAL_MS);
  }

  async check(
    options: { manual?: boolean } = {},
  ): Promise<AppUpdateDto | null> {
    // An install in progress owns the prompt; a timer firing mid-download
    // must not replace "Downloading" with "Available".
    if (this.#busy) return this.#update;
    const manual = options.manual ?? false;
    const { version: currentVersion, channel } =
      await this.options.updater.local();
    if (channel === "dev") {
      if (manual)
        this.#set({
          state: "error",
          currentVersion,
          message: "Development builds do not update themselves.",
        });
      return this.#update;
    }
    const releases: FeedRelease[] = [];
    const failures: string[] = [];
    for (const feed of await this.options.feeds()) {
      const result = await this.options.updater
        .check(feed)
        .catch((error: unknown) => ({
          version: "",
          updateAvailable: false,
          error: describe(error),
        }));
      if (result.error) {
        this.#log("update_check_failed", { feed, message: result.error });
        failures.push(result.error);
        continue;
      }
      releases.push({
        feed,
        version: result.version,
        updateAvailable: result.updateAvailable,
      });
    }
    // One feed answering is enough. The beta feed may not exist yet, and a
    // stable answer alone is still a complete check.
    if (releases.length === 0) {
      if (manual)
        this.#set({
          state: "error",
          currentVersion,
          message: `Could not check for updates: ${failures[0] ?? "no feed to read"}`,
        });
      return this.#update;
    }
    const chosen = chooseUpdate(currentVersion, releases);
    this.#log("update_checked", {
      currentVersion,
      latestVersion: releases.find((release) => release.feed === "stable")
        ?.version,
      betaVersion: releases.find((release) => release.feed === "beta")?.version,
      newer: Boolean(chosen),
      feed: chosen?.feed,
      manual,
    });
    if (!chosen) {
      this.#set(manual ? { state: "current", currentVersion } : null);
      return this.#update;
    }
    if (!manual && (await this.options.readDismissed()) === chosen.version) {
      this.#set(null);
      return this.#update;
    }
    this.#feed = chosen.feed;
    this.#set({ state: "available", currentVersion, version: chosen.version });
    return this.#update;
  }

  async install(): Promise<AppUpdateDto | null> {
    const offered = this.#update;
    if (this.#busy || offered?.state !== "available") return offered;
    this.#busy = true;
    this.#set({ ...offered, state: "downloading" });
    const downloaded = await this.options.updater
      .download(this.#feed)
      .catch((error: unknown) => ({ ready: false, error: describe(error) }));
    if (!downloaded.ready) {
      this.#busy = false;
      const message = downloaded.error ?? "the download did not complete";
      this.#log("update_download_failed", { message });
      this.#set({
        ...offered,
        state: "error",
        message: `Could not download Daedalus ${offered.version}: ${message}`,
      });
      return this.#update;
    }
    this.#set({ ...offered, state: "restarting" });
    this.#log("update_applying", {
      from: offered.currentVersion,
      to: offered.version,
    });
    await this.options.beforeRestart?.().catch(() => undefined);
    // On success this does not return: the app quits and reopens. Returning
    // means it gave up before replacing anything.
    await this.options.updater.apply().catch((error: unknown) => {
      this.#log("update_apply_failed", { message: describe(error) });
    });
    this.#busy = false;
    this.#set({
      ...offered,
      state: "error",
      message: `Could not install Daedalus ${offered.version}. The current version is unchanged.`,
    });
    return this.#update;
  }

  async dismiss(version?: string): Promise<AppUpdateDto | null> {
    if (this.#busy) return this.#update;
    if (version) await this.options.writeDismissed(version);
    this.#set(null);
    return this.#update;
  }

  #set(update: AppUpdateDto | null) {
    this.#update = update;
    this.options.publish(update);
  }

  #log(event: string, fields: Record<string, unknown>) {
    this.options.log?.(event, fields);
  }
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

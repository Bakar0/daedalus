import { reloadSettings, updateSettings, type DaedalusConfig } from "../config";
import { isNewerVersion } from "../versions";

/**
 * Where beta builds publish their update feed. GitHub's `releases/latest`
 * never points at a prerelease, so betas cannot share the stable URL. The
 * release workflow keeps one rolling prerelease tagged `beta` and replaces
 * its assets on every beta, which keeps this URL the same for every version.
 * The stable feed is the `release.baseUrl` baked into each build (see
 * `RELEASE_BASE_URL` in electrobun.config.ts).
 */
export const BETA_FEED_URL =
  "https://github.com/Bakar0/daedalus/releases/download/beta";

export type UpdateFeed = "stable" | "beta";

/** What one feed's `update.json` said. */
export interface FeedRelease {
  feed: UpdateFeed;
  version: string;
  /** Electrobun's own answer: the feed's bundle hash differs from this one. */
  updateAvailable: boolean;
}

/**
 * The release to offer, if any: the highest version newer than `current`
 * among the feeds that answered. Ties go to the earlier feed in the list,
 * so stable wins over a beta feed that carries the same version.
 */
export function chooseUpdate(
  current: string,
  releases: readonly FeedRelease[],
): FeedRelease | undefined {
  let best: FeedRelease | undefined;
  for (const release of releases) {
    if (!release.updateAvailable || !isNewerVersion(release.version, current))
      continue;
    if (!best || isNewerVersion(release.version, best.version)) best = release;
  }
  return best;
}

/** The feeds to read for a given setting, stable first. */
export function updateFeeds(betaUpdates: boolean): UpdateFeed[] {
  return betaUpdates ? ["stable", "beta"] : ["stable"];
}

/**
 * The "Get beta updates" setting. The desktop updater reads it before every
 * check, and from the file rather than its own copy of the config, so
 * `daedal update beta on` takes effect at the app's next check without a
 * restart.
 */
export class AppUpdateService {
  constructor(private readonly config: DaedalusConfig) {}

  async betaUpdates(): Promise<boolean> {
    return (await reloadSettings(this.config)).betaUpdatesEnabled;
  }

  async setBetaUpdates(enabled: boolean): Promise<boolean> {
    await updateSettings(this.config, () => ({ betaUpdatesEnabled: enabled }));
    return enabled;
  }

  /**
   * The feeds the next check reads. A config.json that cannot be read, say
   * mid-edit by hand, means stable only: the same as the default, and never
   * a reason for a background check to fail.
   */
  async feeds(): Promise<UpdateFeed[]> {
    return updateFeeds(await this.betaUpdates().catch(() => false));
  }
}

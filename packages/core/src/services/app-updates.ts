import { reloadSettings, updateSettings, type DaedalusConfig } from "../config";

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

interface ParsedVersion {
  core: [number, number, number];
  /** Dot-separated prerelease identifiers; empty for a release. */
  prerelease: string[];
}

const VERSION =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersion(version: string): ParsedVersion | undefined {
  const match = VERSION.exec(version.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

const NUMERIC = /^\d+$/;

/**
 * Orders two versions by semver precedence: `major.minor.patch` as numbers,
 * then a release above any of its prereleases, then the prerelease
 * identifiers one by one, numbers as numbers and below words. So
 * `0.32.0 > 0.32.0-beta.10 > 0.32.0-beta.2 > 0.32.0-beta.1 > 0.31.0`.
 * Undefined when either does not parse.
 */
export function compareVersions(
  left: string,
  right: string,
): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return Math.sign(b.prerelease.length - a.prerelease.length);
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumber = NUMERIC.test(x);
    const yNumber = NUMERIC.test(y);
    if (xNumber && yNumber) return Math.sign(Number(x) - Number(y));
    if (xNumber) return -1;
    if (yNumber) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * True when `candidate` is a strictly later version than `current`. A
 * version that does not parse is never newer, so a malformed feed cannot
 * produce a prompt.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return (compareVersions(candidate, current) ?? 0) > 0;
}

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

  async feeds(): Promise<UpdateFeed[]> {
    return updateFeeds(await this.betaUpdates());
  }
}

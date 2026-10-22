// Version order for releases and betas. No imports, so the release workflow
// can run it (scripts/beta-feed.ts) without installing dependencies.

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

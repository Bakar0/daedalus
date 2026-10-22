// Picks the release the rolling `beta` feed should carry: the highest beta
// among the published releases. The release workflow runs it after every
// beta tag:
//
//   gh release list --exclude-drafts --limit 200 \
//     --json tagName,isPrerelease | bun run scripts/beta-feed.ts
//
// It prints that release's tag, or nothing when there is no beta yet. Asking
// for the highest beta, rather than taking the tag that triggered the run,
// means a run that was skipped or ran out of order cannot leave the feed on
// an older beta: whichever run comes last puts the highest one there.
import { compareVersions } from "../packages/core/src/versions";

export interface ListedRelease {
  tagName: string;
  isPrerelease: boolean;
}

/** The tag of the highest `v<version>-<suffix>` prerelease, if any. */
export function highestBeta(
  releases: readonly ListedRelease[],
): string | undefined {
  let best: string | undefined;
  for (const { tagName, isPrerelease } of releases) {
    // The feed release itself is tagged `beta` and never parses.
    if (!isPrerelease || !/^v\d+\.\d+\.\d+-/.test(tagName)) continue;
    if (compareVersions(tagName, tagName) === undefined) continue;
    if (!best || (compareVersions(tagName, best) ?? 0) > 0) best = tagName;
  }
  return best;
}

if (import.meta.main) {
  const releases = JSON.parse(await Bun.stdin.text()) as ListedRelease[];
  const tag = highestBeta(releases);
  if (tag) console.log(tag);
}

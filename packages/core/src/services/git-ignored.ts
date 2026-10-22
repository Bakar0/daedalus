import { findExecutable, runCommand } from "@daedalus/platform";

/**
 * Reads `git ls-files --others --ignored --exclude-standard --directory -z`
 * into a test for one path. With `--directory` an ignored folder is one entry
 * ending in `/`, so `dist/` stands for everything a build writes under it,
 * and a path is ignored when it is a listed file or lies under a listed
 * folder.
 */
export function ignoredPathMatcher(
  listing: string,
): (relativePath: string) => boolean {
  const files = new Set<string>();
  const folders = new Set<string>();
  for (const entry of listing.split("\0"))
    if (entry.endsWith("/")) folders.add(entry);
    else if (entry) files.add(entry);
  return (relativePath) => {
    if (files.has(relativePath)) return true;
    let slash = relativePath.indexOf("/");
    while (slash !== -1) {
      if (folders.has(relativePath.slice(0, slash + 1))) return true;
      slash = relativePath.indexOf("/", slash + 1);
    }
    return folders.has(`${relativePath}/`);
  };
}

/**
 * Asked again this long after the last listing. Only a safety net: an edit to
 * any `.gitignore` drops the listing at once.
 */
const IGNORED_LISTING_MAX_AGE_MS = 5 * 60_000;

/**
 * What git ignores in each working tree, so a file change there that git
 * would never report does not cost a status pass. Build output, caches and
 * logs churn constantly while an agent works, and every one of those writes
 * used to mark the tree changed.
 *
 * Wrong only in the safe direction. Until a tree's listing has arrived
 * nothing counts as ignored, and a newly ignored file that the listing does
 * not name yet is reported like any other change. What is skipped is only
 * what git said it ignores.
 */
export class IgnoredPaths {
  private readonly trees = new Map<
    string,
    { at: number; matches?: (relativePath: string) => boolean }
  >();

  constructor(
    private readonly run: typeof runCommand = runCommand,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether git ignores `relativePath` in the tree at `root`. Never waits. */
  matches(root: string, relativePath: string): boolean {
    const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    if (name === ".gitignore") {
      // The rules changed, so the listing is stale; the edit itself counts.
      this.trees.delete(root);
      return false;
    }
    const tree = this.trees.get(root);
    if (!tree || this.now() - tree.at >= IGNORED_LISTING_MAX_AGE_MS)
      this.load(root);
    return tree?.matches?.(relativePath) ?? false;
  }

  forget(root: string): void {
    this.trees.delete(root);
  }

  /** Settles once every listing asked for so far has arrived. For tests. */
  async settle(): Promise<void> {
    await Promise.all(this.loading);
  }

  private readonly loading = new Set<Promise<void>>();

  private load(root: string): void {
    const previous = this.trees.get(root);
    // Marked first, so a burst of events starts one listing, not hundreds.
    const entry: { at: number; matches?: (relativePath: string) => boolean } = {
      at: this.now(),
      ...(previous?.matches ? { matches: previous.matches } : {}),
    };
    this.trees.set(root, entry);
    const git = findExecutable("git");
    if (!git) return;
    const loading = this.run(git, [
      "--no-optional-locks",
      "-C",
      root,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ])
      .then((result) => {
        if (result.exitCode === 0 && this.trees.get(root) === entry)
          entry.matches = ignoredPathMatcher(result.stdout);
      })
      .catch(() => undefined)
      .finally(() => this.loading.delete(loading));
    this.loading.add(loading);
  }
}

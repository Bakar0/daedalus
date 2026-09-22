/**
 * A recursive filesystem watcher that reports what changed rather than that
 * something did.
 *
 * Bun 1.4.2's `fs.watch` is recursive on macOS and needs no dependency, but
 * its output is raw to the point of being misleading. Characterised on this
 * machine:
 *
 *   - Every event type is `"rename"`. A create, a write, a rename and a delete
 *     are indistinguishable by the reported type, so classification here is by
 *     `stat` and never by `type`.
 *   - A rename fires two unlinked events, one per path, with nothing tying
 *     them together.
 *   - There is no coalescing at all. 200 created files produced 201 events;
 *     `rm -r` of that directory produced 203, out of order, with the parent's
 *     own event buried among the children rather than replacing them.
 *
 * The coalescing rules are reimplemented from the behaviour of VS Code's
 * `FileChangesEvent` / `coalesceEvents` (microsoft/vscode, MIT) — the
 * supersede table in `coalesceFileChanges` and the "a deleted folder swallows
 * everything beneath it" rule are theirs. The code is written from that
 * described behaviour rather than copied.
 */
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export type FileChangeKind = "added" | "updated" | "deleted";

export interface FileChange {
  /** Relative to the watched root, with `/` separators. */
  path: string;
  kind: FileChangeKind;
  /** `null` for a deletion, where there is nothing left to stat. */
  entryKind: "file" | "directory" | null;
}

export interface FileChangeBatch {
  changes: FileChange[];
  /**
   * The window carried more raw events than it is worth being precise about,
   * so `changes` is empty and the consumer should re-read whatever it is
   * showing. See `overflowLimit`.
   */
  overflow: boolean;
}

/**
 * Directories whose churn is never worth a redraw. `.git` rewrites its index
 * on every command an agent runs, and `node_modules` moves tens of thousands
 * of files during an install — either one alone would keep the tree in
 * permanent overflow.
 */
export const DEFAULT_IGNORED_DIRECTORIES = [".git", "node_modules"] as const;

export function isIgnoredWatchPath(
  relativePath: string,
  ignored: readonly string[] = DEFAULT_IGNORED_DIRECTORIES,
): boolean {
  return relativePath.split("/").some((segment) => ignored.includes(segment));
}

/**
 * Collapses a window's worth of changes into the smallest set that says the
 * same thing. Pure, so it is unit-tested with no filesystem at all.
 *
 * Two passes, in this order:
 *
 *  1. Supersede by path. Later beats earlier, except where the pair means
 *     something the later event alone does not: added-then-deleted never
 *     happened and drops out entirely, deleted-then-added is an update, and
 *     added-then-updated is still an addition.
 *  2. Coalesce by ancestor. A deleted directory drops every change beneath it,
 *     which is the difference between one event and the 500 that `rm -r`
 *     actually produces.
 */
export function coalesceFileChanges(
  changes: readonly FileChange[],
): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const change of changes) {
    const existing = byPath.get(change.path);
    if (!existing) {
      byPath.set(change.path, change);
      continue;
    }
    if (existing.kind === "added" && change.kind === "deleted") {
      // It was created and removed inside one window. Reporting either half
      // would describe a file that no consumer ever had a chance to see.
      byPath.delete(change.path);
      continue;
    }
    if (existing.kind === "deleted" && change.kind === "added") {
      byPath.set(change.path, { ...change, kind: "updated" });
      continue;
    }
    if (existing.kind === "added" && change.kind === "updated") {
      // Still an addition as far as anyone watching is concerned; the write
      // that followed it is part of the same arrival.
      byPath.set(change.path, { ...change, kind: "added" });
      continue;
    }
    byPath.set(change.path, change);
  }

  const deletedDirectories = [...byPath.values()]
    .filter((change) => change.kind === "deleted")
    .map((change) => `${change.path}/`);
  if (deletedDirectories.length === 0) return [...byPath.values()];
  return [...byPath.values()].filter(
    (change) =>
      !deletedDirectories.some(
        (prefix) =>
          change.path !== prefix.slice(0, -1) && change.path.startsWith(prefix),
      ),
  );
}

export interface WatchFileTreeOptions {
  root: string;
  onChanges: (batch: FileChangeBatch) => void;
  onError?: (error: Error) => void;
  /** Directory names dropped wherever they appear in a path. */
  ignored?: readonly string[];
  /** How long a quiet period ends a window. Defaults to 150ms. */
  debounceMs?: number;
  /**
   * Raw events in one window past which precision stops being worth it.
   * `rm -rf node_modules` is tens of thousands of events; re-listing what is
   * on screen is both cheaper and more correct than trying to replay them.
   */
  overflowLimit?: number;
  /** Injected by the tests so classification needs no real clock. */
  now?: () => number;
}

export interface FileTreeWatcher {
  close(): void;
}

/**
 * Classification is by `stat`, because the reported event type carries no
 * information:
 *
 *   - the path is gone       -> `deleted`
 *   - it was born since we started watching -> `added`
 *   - otherwise              -> `updated`
 *
 * `birthtime` is real on APFS and survives a rename, which leaves one known
 * imprecision: a file *moved* into the tree from outside reports as `updated`
 * at its new path rather than `added`. That costs the consumer nothing —
 * reconciliation is per parent directory, and the parent is named either way —
 * and it is the price of not indexing the whole tree up front.
 */
async function classify(
  root: string,
  relativePath: string,
  watchStartedAt: number,
): Promise<FileChange> {
  try {
    const entry = await stat(join(root, relativePath));
    return {
      path: relativePath,
      kind: entry.birthtimeMs >= watchStartedAt ? "added" : "updated",
      entryKind: entry.isDirectory() ? "directory" : "file",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: relativePath, kind: "deleted", entryKind: null };
    throw error;
  }
}

export function watchFileTree(options: WatchFileTreeOptions): FileTreeWatcher {
  const {
    root,
    onChanges,
    onError,
    ignored = DEFAULT_IGNORED_DIRECTORIES,
    debounceMs = 150,
    overflowLimit = 512,
    now = Date.now,
  } = options;

  const watchStartedAt = now();
  let pending = new Set<string>();
  let rawEvents = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let watcher: FSWatcher | undefined;

  const flush = (): void => {
    timer = undefined;
    const paths = [...pending];
    const overflowed = rawEvents > overflowLimit;
    pending = new Set();
    rawEvents = 0;
    if (overflowed) {
      onChanges({ changes: [], overflow: true });
      return;
    }
    if (paths.length === 0) return;
    void Promise.all(
      paths.map((path) => classify(root, path, watchStartedAt)),
    ).then(
      (classified) => {
        if (closed) return;
        const changes = coalesceFileChanges(classified);
        if (changes.length > 0) onChanges({ changes, overflow: false });
      },
      (error: unknown) =>
        onError?.(error instanceof Error ? error : new Error(String(error))),
    );
  };

  try {
    watcher = watch(root, { recursive: true }, (_type, filename) => {
      if (closed || !filename) return;
      const relativePath = String(filename).split("\\").join("/");
      if (!relativePath || isIgnoredWatchPath(relativePath, ignored)) return;
      rawEvents += 1;
      // Past the limit the individual paths stop being worth holding: the
      // batch is going to be an overflow whatever else arrives.
      if (rawEvents > overflowLimit) pending.clear();
      else pending.add(relativePath);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    });
    watcher.on("error", (error) => onError?.(error));
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}

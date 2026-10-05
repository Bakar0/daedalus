import type { WorkspaceFileChangeDto } from "@daedalus/protocol";

export const EXPLORER_MIN_WIDTH = 170;
export const EXPLORER_MAX_WIDTH = 560;
export const EXPLORER_DEFAULT_WIDTH = 255;
// The editor next to the explorer stops being an editor below this.
export const EXPLORER_VIEWER_MIN_WIDTH = 300;

export const clampExplorerWidth = (width: number, available: number) =>
  Math.min(
    Math.max(EXPLORER_MIN_WIDTH, Math.round(width)),
    Math.max(EXPLORER_MIN_WIDTH, Math.min(EXPLORER_MAX_WIDTH, available)),
  );

export const workspaceParentPath = (path: string) => {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
};

export const workspaceBaseName = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1);

const expandedDirectoriesStorageKey = (workspaceId: string) =>
  `daedalus.explorer.expanded.${workspaceId}`;

// Every remembered folder costs one directory listing on the way back into a
// workspace, and a tree nobody could have opened by hand is not worth paying
// for. The cap keeps the shallowest, because a child whose parent was dropped
// would not be reachable anyway.
const MAX_REMEMBERED_DIRECTORIES = 200;

export function parseRememberedDirectories(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const paths = parsed.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return [...new Set(paths)]
    .sort((a, b) => a.split("/").length - b.split("/").length)
    .slice(0, MAX_REMEMBERED_DIRECTORIES);
}

export const rememberedExpandedDirectories = (workspaceId: string) => {
  if (typeof window === "undefined") return [];
  try {
    return parseRememberedDirectories(
      window.localStorage.getItem(expandedDirectoriesStorageKey(workspaceId)),
    );
  } catch {
    return [];
  }
};

export const rememberExpandedDirectories = (
  workspaceId: string,
  directories: Iterable<string>,
) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      expandedDirectoriesStorageKey(workspaceId),
      JSON.stringify([...directories]),
    );
  } catch {
    // A disabled or full store is not worth failing a disclosure triangle over.
  }
};

export interface ExplorerRefreshPlan {
  /** Folders whose listing is now wrong and has to be fetched again. */
  relist: string[];
  /** Folders that are gone: drop their cached listing and their expansion. */
  dropped: string[];
}

/**
 * Turns a batch of filesystem changes into the smallest amount of work the
 * explorer has to do.
 *
 * It answers in folders, never in rows, and deliberately never touches the
 * DOM. Re-listing the affected folders and writing the result back into the
 * directory cache is what lets expansion, selection, scroll position and an
 * unsaved draft survive a change on disk — replacing the tree would lose all
 * four.
 *
 * Only folders the explorer has already listed are re-listed. A change deep
 * inside a folder nobody has opened is real, but there is nothing on screen
 * that is wrong because of it, and listing it would be work for no one.
 */
export function planExplorerRefresh(input: {
  known: readonly string[];
  changes: readonly WorkspaceFileChangeDto[];
  overflow: boolean;
}): ExplorerRefreshPlan {
  const known = new Set(input.known);
  // Past the overflow limit the host stops describing individual paths, so
  // the only correct answer is to re-read everything that is on screen.
  if (input.overflow) return { relist: [...known], dropped: [] };

  const dropped = new Set<string>();
  for (const change of input.changes) {
    if (change.kind !== "deleted") continue;
    for (const folder of known)
      if (folder === change.path || folder.startsWith(`${change.path}/`))
        dropped.add(folder);
  }

  const relist = new Set<string>();
  for (const change of input.changes) {
    const parent = workspaceParentPath(change.path);
    // A folder that is itself gone is not worth re-listing; its own parent is
    // already in the set and will report it missing.
    if (known.has(parent) && !dropped.has(parent)) relist.add(parent);
  }
  return { relist: [...relist], dropped: [...dropped] };
}

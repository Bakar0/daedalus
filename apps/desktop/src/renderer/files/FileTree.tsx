import {
  dragAndDropFeature,
  expandAllFeature,
  hotkeysCoreFeature,
  type ItemInstance,
  propMemoizationFeature,
  renamingFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import {
  type ChangedFileDto,
  type WorkspaceFileEntryDto,
  formatKeyGlyphs,
} from "@daedalus/protocol";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DesktopClient } from "../client-types";
import { useCommand } from "../commands";
import { askConfirm, askText, plainLine } from "../dialogs";
import { type ItemAction, useItemActions } from "../item-actions";
import { FileTypeIcon } from "./file-icons";
import {
  planExplorerRefresh,
  rememberedExpandedDirectories,
  rememberExpandedDirectories,
  workspaceBaseName,
  workspaceParentPath,
} from "./explorer-state";

/** The tree's own id for the workspace root, which has the path "". */
const ROOT = "\u0000root";
const INDENT = 12;
const MAX_DROPPED_FILE_BYTES = 50 * 1024 * 1024;

/** A dropped file's bytes as base64, in chunks the call stack can take. */
const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
};

/** One dropped item: a file, or a folder and what is in it. */
type DroppedEntry =
  | { kind: "file"; file: File }
  | { kind: "directory"; name: string; children: DroppedEntry[] };

/**
 * What Finder dropped, folders included. The entries must be taken while the
 * drop event runs; reading them can wait.
 */
const droppedEntries = async (
  dataTransfer: DataTransfer,
): Promise<DroppedEntry[]> => {
  const roots = [...dataTransfer.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (roots.length === 0)
    return [...dataTransfer.files].map((file) => ({ kind: "file", file }));
  const read = async (entry: FileSystemEntry): Promise<DroppedEntry> => {
    if (entry.isFile)
      return {
        kind: "file",
        file: await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        ),
      };
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    // A reader hands entries over in batches until one comes back empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      children.push(...batch);
    }
    return {
      kind: "directory",
      name: entry.name,
      children: await Promise.all(children.map(read)),
    };
  };
  return Promise.all(roots.map(read));
};

type GitStatus = ChangedFileDto["status"];
const GIT_LETTER: Record<GitStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};
// Which change a folder shows when it holds several, as VS Code ranks them.
const GIT_WEIGHT: Record<GitStatus, number> = {
  deleted: 4,
  modified: 3,
  renamed: 2,
  added: 1,
  untracked: 1,
};

/**
 * The colour each row takes: a changed file its own status, and every folder
 * above it the weightiest status of what it holds.
 */
function gitDecorations(
  changes: ReadonlyMap<string, GitStatus> | undefined,
): ReadonlyMap<string, { status: GitStatus; folder: boolean }> {
  const decorations = new Map<string, { status: GitStatus; folder: boolean }>();
  if (!changes) return decorations;
  for (const [path, status] of changes) {
    decorations.set(path, { status, folder: false });
    for (
      let parent = workspaceParentPath(path);
      parent;
      parent = workspaceParentPath(parent)
    ) {
      const current = decorations.get(parent);
      if (current && GIT_WEIGHT[current.status] >= GIT_WEIGHT[status]) break;
      decorations.set(parent, { status, folder: true });
    }
  }
  return decorations;
}

const isReadOnlyFolder = (path: string) =>
  path === "repos" || path.startsWith("repos/");

export interface FileTreeHandle {
  /** Starts an inline new-entry row in the folder holding `near`. */
  newEntry(kind: "file" | "directory"): void;
  collapseAll(): void;
}

export interface FileTreeProps {
  client: DesktopClient;
  workspaceId: string;
  workspacePath: string;
  /** The file the editor is showing; the tree selects it and opens its folders. */
  activePath?: string;
  /** What session worktrees changed, by workspace path, to colour the rows. */
  gitStatus?: ReadonlyMap<string, GitStatus>;
  /** The root listing, when the caller already has it, so the first render is not empty. */
  initialRoot?: WorkspaceFileEntryDto[];
  onOpen(path: string, options: { pinned: boolean }): void;
  /** An entry was renamed or moved from inside the tree. */
  onMoved(from: string, to: string): void;
  onRemoved(path: string): void;
  onError(message: string): void;
  handleRef?: React.Ref<FileTreeHandle>;
}

type Listings = Record<string, WorkspaceFileEntryDto[]>;

interface PendingEntry {
  parent: string;
  kind: "file" | "directory";
  name: string;
}

export function FileTree({
  client,
  workspaceId,
  workspacePath,
  activePath,
  gitStatus,
  initialRoot,
  onOpen,
  onMoved,
  onRemoved,
  onError,
  handleRef,
}: FileTreeProps) {
  const decorations = useMemo(() => gitDecorations(gitStatus), [gitStatus]);
  const [listings, setListings] = useState<Listings>(() =>
    initialRoot ? { "": initialRoot } : ({} as Listings),
  );
  const listingsRef = useRef(listings);
  listingsRef.current = listings;
  const [expanded, setExpandedState] = useState<string[]>([]);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // The trash ids of each delete, newest last, for Command-Z. A trash id
  // restores only into the workspace it came from, so switching starts over.
  const removals = useRef<string[][]>([]);
  useEffect(() => {
    removals.current = [];
  }, [workspaceId]);
  const [pending, setPending] = useState<PendingEntry>();
  // Why the root could not be listed, in the host's words, such as a cloud
  // workspace that is asleep. Shown in place of the tree.
  const [rootError, setRootError] = useState<string>();
  const [menu, setMenu] = useState<{
    entry?: WorkspaceFileEntryDto;
    x: number;
    y: number;
    /** Opened by ⇧F10: its first item takes focus. */
    byKey?: boolean;
  }>();
  // The row a menu opened from by key gets focus back when it closes.
  const menuReturn = useRef<HTMLElement | null>(null);
  // A right-click leaves focus where the pointer put it: nothing to return.
  const openMenuByMouse = (next: {
    entry?: WorkspaceFileEntryDto;
    x: number;
    y: number;
  }) => {
    menuReturn.current = null;
    setMenu(next);
  };

  const entryByPath = useCallback((path: string) => {
    const parent = listingsRef.current[workspaceParentPath(path)];
    return parent?.find((entry) => entry.path === path);
  }, []);

  const list = useCallback(
    async (path: string) => {
      const response = await client.request.workspaceDirectoryList({
        workspace: workspaceId,
        path: path || undefined,
      });
      return response.ok ? response.data : undefined;
    },
    [client, workspaceId],
  );

  const relist = useCallback(
    async (paths: readonly string[]) => {
      const results = await Promise.all(
        [...new Set(paths)].map(
          async (path) => [path, await list(path)] as const,
        ),
      );
      setListings((current) => {
        const next = { ...current };
        for (const [path, entries] of results)
          if (entries) next[path] = entries;
          else delete next[path];
        return next;
      });
    },
    [list],
  );

  const setExpanded = useCallback(
    (paths: string[]) => {
      // Closing a folder closes what is inside it. Keeping the descendants
      // would spring the whole subtree back open the next time the parent is
      // opened, which is not what closing a folder means (#21).
      const closed = expandedRef.current.filter(
        (path) => !paths.includes(path),
      );
      const unique = [...new Set(paths)].filter(
        (path) => !closed.some((folder) => path.startsWith(`${folder}/`)),
      );
      setExpandedState(unique);
      rememberExpandedDirectories(workspaceId, unique);
      const unlisted = unique.filter((path) => !listingsRef.current[path]);
      if (unlisted.length > 0) void relist(unlisted);
    },
    [relist, workspaceId],
  );

  // The root, then every folder the user left open, each listed again rather
  // than trusted: a folder can be gone between two visits.
  useEffect(() => {
    let cancelled = false;
    setExpandedState([]);
    setPending(undefined);
    setRootError(undefined);
    void (async () => {
      const response = await client.request.workspaceDirectoryList({
        workspace: workspaceId,
      });
      if (cancelled) return;
      if (!response.ok) {
        setListings({});
        setRootError(
          response.error.message || "Could not list the workspace folder.",
        );
        return;
      }
      const root = response.data;
      const remembered = rememberedExpandedDirectories(workspaceId);
      const restored = await Promise.all(
        remembered.map(async (path) => [path, await list(path)] as const),
      );
      if (cancelled) return;
      const next: Listings = { "": root };
      const open: string[] = [];
      for (const [path, entries] of restored)
        if (entries) {
          next[path] = entries;
          open.push(path);
        }
      setListings(next);
      setExpandedState(open);
      if (open.length !== remembered.length)
        rememberExpandedDirectories(workspaceId, open);
    })();
    return () => {
      cancelled = true;
    };
    // `onError` is a fresh closure on every render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, workspaceId]);

  // Changes on disk re-list the folders on screen that they touch. The tree is
  // never rebuilt from scratch, so expansion, selection and scroll survive.
  useEffect(
    () =>
      client.subscribeWorkspaceFiles(
        ({ workspaceId: changed, changes, overflow }) => {
          if (changed !== workspaceId) return;
          const plan = planExplorerRefresh({
            known: Object.keys(listingsRef.current),
            changes,
            overflow,
          });
          if (plan.dropped.length > 0) {
            setListings((current) => {
              const next = { ...current };
              for (const folder of plan.dropped) delete next[folder];
              return next;
            });
            const open = expandedRef.current.filter(
              (path) => !plan.dropped.includes(path),
            );
            if (open.length !== expandedRef.current.length) setExpanded(open);
          }
          if (plan.relist.length > 0) void relist(plan.relist);
        },
      ),
    [client, relist, setExpanded, workspaceId],
  );

  const createPending = async (entry: PendingEntry) => {
    setPending(undefined);
    const name = entry.name.trim();
    if (!name) return;
    const response = await client.request.workspaceEntryCreate({
      workspace: workspaceId,
      parentPath: entry.parent || undefined,
      name,
      kind: entry.kind,
    });
    if (!response.ok) {
      onError(response.error.message);
      return;
    }
    await relist([entry.parent]);
    if (response.data.kind === "file")
      onOpen(response.data.path, { pinned: true });
    else setExpanded([...expandedRef.current, response.data.path]);
  };

  const rename = async (entry: WorkspaceFileEntryDto, value: string) => {
    const name = value.trim();
    if (!name || name === entry.name) return;
    const response = await client.request.workspaceEntryRename({
      workspace: workspaceId,
      path: entry.path,
      name,
    });
    if (!response.ok) {
      onError(response.error.message);
      return;
    }
    followMove(entry.path, response.data.path);
    await relist([workspaceParentPath(entry.path)]);
  };

  /** Carries open folders across a rename or move, then tells the editor. */
  const followMove = (from: string, to: string) => {
    const repath = (path: string) =>
      path === from
        ? to
        : path.startsWith(`${from}/`)
          ? to + path.slice(from.length)
          : path;
    if (
      expandedRef.current.some(
        (path) => path === from || path.startsWith(`${from}/`),
      )
    )
      setExpanded(expandedRef.current.map(repath));
    setListings((current) => {
      const next: Listings = {};
      for (const [path, entries] of Object.entries(current))
        if (path !== from && !path.startsWith(`${from}/`)) next[path] = entries;
      return next;
    });
    onMoved(from, to);
  };

  const move = async (
    entries: readonly WorkspaceFileEntryDto[],
    destination: string,
  ) => {
    const parents = new Set<string>([destination]);
    for (const entry of entries) {
      if (workspaceParentPath(entry.path) === destination) continue;
      const response = await client.request.workspaceEntryMove({
        workspace: workspaceId,
        path: entry.path,
        destinationPath: destination,
      });
      if (!response.ok) {
        onError(response.error.message);
        continue;
      }
      parents.add(workspaceParentPath(entry.path));
      followMove(entry.path, response.data.path);
    }
    await relist([...parents]);
  };

  const remove = async (entries: readonly WorkspaceFileEntryDto[]) => {
    const removable = entries.filter((entry) => entry.mutable);
    if (removable.length === 0) return;
    const only = removable.length === 1 ? removable[0] : undefined;
    const confirmed = await askConfirm({
      title: only
        ? `Delete ${only.name}?`
        : `Delete ${removable.length} items?`,
      message: only
        ? only.kind === "directory"
          ? "The folder and everything inside it. \u2318Z puts it back."
          : "\u2318Z puts it back."
        : `${removable.map((entry) => entry.name).join(", ")}. \u2318Z puts them back.`,
      confirmLabel: "Delete",
      danger: true,
      enterConfirms: true,
    });
    if (!confirmed) return;
    const parents = new Set<string>();
    const trashIds: string[] = [];
    for (const entry of removable) {
      const response = await client.request.workspaceEntryRemove({
        workspace: workspaceId,
        path: entry.path,
      });
      if (!response.ok) {
        onError(response.error.message);
        continue;
      }
      parents.add(workspaceParentPath(entry.path));
      trashIds.push(response.data.trashId);
      onRemoved(entry.path);
    }
    if (trashIds.length > 0) removals.current.push(trashIds);
    setExpanded(
      expandedRef.current.filter(
        (path) =>
          !removable.some(
            (entry) => path === entry.path || path.startsWith(`${entry.path}/`),
          ),
      ),
    );
    await relist([...parents]);
  };

  /** Puts back what the last delete removed, newest delete first. */
  const undoRemove = async () => {
    const trashIds = removals.current.pop();
    if (!trashIds) return;
    const parents = new Set<string>();
    for (const trashId of [...trashIds].reverse()) {
      const response = await client.request.workspaceEntryRestore({
        workspace: workspaceId,
        trashId,
      });
      if (!response.ok) {
        onError(response.error.message);
        continue;
      }
      parents.add(workspaceParentPath(response.data.path));
    }
    await relist([...parents]);
  };

  /**
   * Files and folders dragged in from Finder, any kind of file up to 50 MB.
   * A name already taken in the folder is reported, never overwritten.
   */
  const copyIn = async (
    entries: readonly DroppedEntry[],
    destination: string,
  ) => {
    const refused: string[] = [];
    const place = async (entry: DroppedEntry, parent: string) => {
      if (entry.kind === "directory") {
        const created = await client.request.workspaceEntryCreate({
          workspace: workspaceId,
          parentPath: parent || undefined,
          name: entry.name,
          kind: "directory",
        });
        if (!created.ok) {
          onError(created.error.message);
          return;
        }
        for (const child of entry.children)
          await place(child, created.data.path);
        return;
      }
      if (entry.file.size > MAX_DROPPED_FILE_BYTES) {
        refused.push(entry.file.name);
        return;
      }
      const bytes = new Uint8Array(await entry.file.arrayBuffer());
      const imported = await client.request.workspaceFileImport({
        workspace: workspaceId,
        parentPath: parent || undefined,
        name: entry.file.name,
        base64: toBase64(bytes),
      });
      if (!imported.ok) onError(imported.error.message);
    };
    for (const entry of entries) await place(entry, destination);
    if (refused.length > 0)
      onError(`Not copied (over 50 MB): ${refused.join(", ")}`);
    await relist([destination]);
  };

  // Absolute paths last cut with Cmd+X. A paste of exactly these moves them;
  // anything else on the pasteboard is copied.
  const cutPaths = useRef<string[]>([]);
  const absolute = (path: string) => `${workspacePath}/${path}`;

  const copyToPasteboard = async (
    entries: readonly WorkspaceFileEntryDto[],
    cut: boolean,
  ) => {
    const chosen = cut ? entries.filter((entry) => entry.mutable) : entries;
    if (chosen.length === 0) return;
    const paths = chosen.map((entry) => absolute(entry.path));
    const response = await client.request.clipboardFilesWrite({ paths });
    if (!response.ok) {
      onError(response.error.message);
      return;
    }
    cutPaths.current = cut ? paths : [];
  };

  const paste = async (destination: string) => {
    if (isReadOnlyFolder(destination)) {
      onError("repos/ holds read-only checkouts.");
      return;
    }
    const response = await client.request.clipboardFilesRead({});
    if (!response.ok) {
      onError(response.error.message);
      return;
    }
    const { paths } = response.data;
    if (paths.length === 0) return;
    const prefix = `${workspacePath}/`;
    const cut = cutPaths.current;
    if (
      cut.length > 0 &&
      cut.length === paths.length &&
      cut.every((path) => paths.includes(path)) &&
      paths.every((path) => path.startsWith(prefix))
    ) {
      cutPaths.current = [];
      await move(
        paths.map(
          (path) =>
            entryByPath(path.slice(prefix.length)) ?? {
              name: workspaceBaseName(path),
              path: path.slice(prefix.length),
              kind: "file",
              mutable: true,
            },
        ),
        destination,
      );
      return;
    }
    const copied = await client.request.workspaceEntriesCopy({
      workspace: workspaceId,
      sources: paths,
      destinationPath: destination,
    });
    if (!copied.ok) onError(copied.error.message);
    if (destination && !expandedRef.current.includes(destination))
      setExpanded([...expandedRef.current, destination]);
    await relist([destination]);
  };

  const tree = useTree<WorkspaceFileEntryDto>({
    rootItemId: ROOT,
    state: { expandedItems: expanded },
    setExpandedItems: (updater) =>
      setExpanded(
        typeof updater === "function" ? updater(expandedRef.current) : updater,
      ),
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().kind === "directory",
    dataLoader: {
      getItem: (id) =>
        id === ROOT
          ? { name: "", path: "", kind: "directory", mutable: false }
          : (entryByPath(id) ?? {
              name: workspaceBaseName(id),
              path: id,
              kind: "file",
              mutable: false,
            }),
      getChildren: (id) =>
        (listingsRef.current[id === ROOT ? "" : id] ?? []).map(
          (entry) => entry.path,
        ),
    },
    indent: INDENT,
    onPrimaryAction: (item) => {
      const entry = item.getItemData();
      if (entry.kind === "file") onOpen(entry.path, { pinned: false });
    },
    canRename: (item) => item.getItemData().mutable,
    onRename: (item, value) => void rename(item.getItemData(), value),
    canReorder: false,
    openOnDropDelay: 600,
    canDrag: (items) => items.every((item) => item.getItemData().mutable),
    canDrop: (items, target) => {
      const destination =
        target.item.getId() === ROOT ? "" : target.item.getId();
      if (isReadOnlyFolder(destination)) return false;
      return items.every(
        (item) =>
          destination !== item.getId() &&
          !destination.startsWith(`${item.getId()}/`),
      );
    },
    onDrop: (items, target) =>
      move(
        items.map((item) => item.getItemData()),
        target.item.getId() === ROOT ? "" : target.item.getId(),
      ),
    // Dragged out of the tree, a row carries its absolute path, which is what
    // a terminal or a text field wants to receive.
    createForeignDragObject: (items) => ({
      format: "text/plain",
      data: items.map((item) => `${workspacePath}/${item.getId()}`).join("\n"),
    }),
    canDragForeignDragObjectOver: (dataTransfer, target) =>
      dataTransfer.types.includes("Files") &&
      !isReadOnlyFolder(
        target.item.getId() === ROOT ? "" : target.item.getId(),
      ),
    canDropForeignDragObject: (dataTransfer) => dataTransfer.files.length > 0,
    onDropForeignDragObject: (dataTransfer, target) => {
      const destination =
        target.item.getId() === ROOT ? "" : target.item.getId();
      void droppedEntries(dataTransfer).then((entries) =>
        copyIn(entries, destination),
      );
    },
    hotkeys: {
      // VS Code on macOS: Enter renames, Space opens and keeps focus here.
      // Cmd combinations are handled in `onCommandKey` below.
      customRename: {
        hotkey: "Enter",
        isEnabled: (instance) => !instance.isRenamingItem(),
        preventDefault: true,
        handler: (_, instance) => {
          const focused = instance.getFocusedItem();
          if (focused.canRename()) focused.startRenaming();
        },
      },
      customOpen: {
        hotkey: "Space",
        preventDefault: true,
        handler: (_, instance) => {
          const entry = instance.getFocusedItem().getItemData();
          if (entry.kind === "file") onOpen(entry.path, { pinned: false });
        },
      },
    },
    features: [
      syncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      renamingFeature,
      expandAllFeature,
      propMemoizationFeature,
    ],
  });

  // The data loader reads the listings through a ref, so the tree has to be
  // told when they move.
  useLayoutEffect(() => {
    tree.rebuildTree();
  }, [expanded, listings, tree]);

  // Follow the editor: open the active file's folders and select its row,
  // without taking focus from the editor. A file outside the workspace, open
  // by its absolute path from a terminal link, has no row to follow.
  useEffect(() => {
    if (!activePath || activePath.startsWith("/")) return;
    const ancestors: string[] = [];
    for (
      let parent = workspaceParentPath(activePath);
      parent;
      parent = workspaceParentPath(parent)
    )
      ancestors.unshift(parent);
    const missing = ancestors.filter(
      (path) => !expandedRef.current.includes(path),
    );
    if (missing.length > 0) setExpanded([...expandedRef.current, ...missing]);
    tree.setSelectedItems([activePath]);
    tree.getItemInstance(activePath).setFocused();
    requestAnimationFrame(() =>
      tree
        .getItemInstance(activePath)
        .getElement()
        ?.scrollIntoView({ block: "nearest" }),
    );
  }, [activePath, setExpanded, tree]);

  const startNewEntry = useCallback(
    (kind: "file" | "directory", near?: string) => {
      const focused = near ?? tree.getState().focusedItem ?? undefined;
      const focusedEntry =
        focused && focused !== ROOT ? entryByPath(focused) : undefined;
      const parent = focusedEntry
        ? focusedEntry.kind === "directory"
          ? focusedEntry.path
          : workspaceParentPath(focusedEntry.path)
        : "";
      if (isReadOnlyFolder(parent)) {
        onError("repos/ holds read-only checkouts.");
        return;
      }
      if (parent && !expandedRef.current.includes(parent))
        setExpanded([...expandedRef.current, parent]);
      setPending({ parent, kind, name: "" });
    },
    [entryByPath, onError, setExpanded, tree],
  );

  useEffect(() => {
    if (!handleRef) return;
    const handle: FileTreeHandle = {
      newEntry: (kind) => startNewEntry(kind),
      collapseAll: () => setExpanded([]),
    };
    if (typeof handleRef === "function") {
      handleRef(handle);
      return () => {
        handleRef(null);
      };
    }
    (handleRef as React.RefObject<FileTreeHandle | null>).current = handle;
    return () => {
      (handleRef as React.RefObject<FileTreeHandle | null>).current = null;
    };
  }, [handleRef, setExpanded, startNewEntry]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      menuReturn.current = null;
      setMenu(undefined);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);

  const selectedOrFocused = () => {
    const selected = tree.getSelectedItems();
    const focused = tree.getState().focusedItem;
    return (
      selected.length > 0
        ? selected
        : focused && focused !== ROOT
          ? [tree.getItemInstance(focused)]
          : []
    ).map((item) => item.getItemData());
  };
  const folderOf = (entry?: WorkspaceFileEntryDto) =>
    !entry
      ? ""
      : entry.kind === "directory"
        ? entry.path
        : workspaceParentPath(entry.path);

  const items = tree.getItems();
  const pendingRow = pending && (
    <div
      className="file-tree-row pending"
      key="\u0000pending"
      style={{
        paddingLeft: `${4 + (pending.parent ? pending.parent.split("/").length : 0) * INDENT}px`,
      }}
    >
      <span className="file-tree-twisty" aria-hidden="true">
        {pending.kind === "directory" ? "›" : ""}
      </span>
      <input
        aria-label={`New ${pending.kind === "file" ? "file" : "folder"} name`}
        autoFocus
        onBlur={() => void createPending(pending)}
        onChange={(event) =>
          setPending({ ...pending, name: event.target.value })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void createPending(pending);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setPending(undefined);
          }
        }}
        value={pending.name}
      />
    </div>
  );

  const rows: React.ReactNode[] = [];
  if (pending && !pending.parent) rows.push(pendingRow);
  for (const item of items) {
    rows.push(
      <TreeRow
        git={decorations.get(item.getId())}
        item={item}
        key={item.getKey()}
        onMenu={openMenuByMouse}
        onOpen={onOpen}
      />,
    );
    if (pending && pending.parent === item.getId() && item.isExpanded())
      rows.push(pendingRow);
  }

  const copy = (text: string) => void client.request.clipboardWrite({ text });
  /**
   * What the menu offers for `entry` (the explorer itself when none), as
   * data: the right-click menu and ⇧F10 draw it, and the ⌘K palette lists
   * it for the focused file. `section` divides the menu.
   */
  const fileMenuActions = (
    entry: WorkspaceFileEntryDto | undefined,
  ): (ItemAction & { section: number })[] => {
    const target = folderOf(entry);
    const targets = () => {
      if (!entry) return [];
      const selected = tree
        .getSelectedItems()
        .map((item) => item.getItemData());
      return selected.some((item) => item.path === entry.path)
        ? selected
        : [entry];
    };
    const readOnly = isReadOnlyFolder(target);
    return [
      ...(entry?.kind === "file"
        ? [
            {
              id: "open",
              label: "Open",
              section: 0,
              run: () => onOpen(entry.path, { pinned: true }),
            },
          ]
        : []),
      {
        id: "new-file",
        label: "New File…",
        section: 0,
        disabled: readOnly,
        run: () => startNewEntry("file", entry?.path ?? ROOT),
      },
      {
        id: "new-folder",
        label: "New Folder…",
        section: 0,
        disabled: readOnly,
        run: () => startNewEntry("directory", entry?.path ?? ROOT),
      },
      ...(entry
        ? [
            {
              id: "cut",
              label: "Cut",
              keys: "mod+x",
              section: 1,
              disabled: !entry.mutable,
              run: () => void copyToPasteboard(targets(), true),
            },
            {
              id: "copy",
              label: "Copy",
              keys: "mod+c",
              section: 1,
              run: () => void copyToPasteboard(targets(), false),
            },
          ]
        : []),
      {
        id: "paste",
        label: "Paste",
        keys: "mod+v",
        section: 1,
        disabled: readOnly,
        run: () => void paste(target),
      },
      ...(entry
        ? [
            {
              id: "copy-path",
              label: "Copy Path",
              section: 2,
              run: () => copy(`${workspacePath}/${entry.path}`),
            },
            {
              id: "copy-relative-path",
              label: "Copy Relative Path",
              section: 2,
              run: () => copy(entry.path),
            },
            {
              id: "rename",
              label: "Rename",
              keys: "f2",
              section: 3,
              disabled: !entry.mutable,
              run: () => tree.getItemInstance(entry.path).startRenaming(),
            },
            {
              id: "move",
              label: "Move to…",
              section: 3,
              disabled: !entry.mutable,
              run: () =>
                void askText({
                  title: `Move ${entry.name}`,
                  message:
                    "Move into which folder? Leave empty for the workspace root.",
                  initial: workspaceParentPath(entry.path),
                  confirmLabel: "Move",
                }).then((destination) => {
                  if (destination === null) return;
                  void move(
                    [entry],
                    destination.trim().replace(/^\/+|\/+$/g, ""),
                  );
                }),
            },
            {
              id: "delete",
              label: "Delete",
              keys: "mod+backspace",
              section: 3,
              danger: true,
              disabled: !entry.mutable,
              run: () => void remove(targets()),
            },
          ]
        : [
            {
              id: "collapse-all",
              label: "Collapse All",
              // Beside Paste, as the menu always had it.
              section: 1,
              run: () => setExpanded([]),
            },
          ]),
    ];
  };
  const entryOfRow = (element: Element) => {
    const row = element.closest<HTMLElement>(".file-tree-row[data-path]");
    if (!row) return undefined;
    return entryByPath(row.dataset.path ?? "");
  };
  // Opened on a focused file, the palette shows the file first, its menu
  // as the file's Actions panel.
  useItemActions((element) => {
    const entry = entryOfRow(element);
    return entry
      ? {
          title: entry.name,
          actions: fileMenuActions(entry),
          ref: { kind: "file", id: entry.path },
        }
      : undefined;
  });
  // ⇧F10 or the menu key opens the focused file's menu under its row.
  useCommand("item.menu", {
    enabled: (context) => Boolean(context.target && entryOfRow(context.target)),
    run: (context) => {
      const row = context.target?.closest<HTMLElement>(".file-tree-row");
      const entry = context.target ? entryOfRow(context.target) : undefined;
      if (!row || !entry) return;
      const box = row.getBoundingClientRect();
      menuReturn.current = row;
      setMenu({ entry, x: box.left + 24, y: box.bottom, byKey: true });
    },
  });

  const menuEntry = menu?.entry;
  const menuItems = menu ? fileMenuActions(menuEntry) : [];
  const closeMenu = (giveFocusBack: boolean) => {
    setMenu(undefined);
    const back = menuReturn.current;
    menuReturn.current = null;
    if (giveFocusBack && back?.isConnected) back.focus();
  };

  return (
    <>
      <div
        {...tree.getContainerProps("Workspace files")}
        className="file-tree"
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) return;
          // The Mac delete key (Backspace), with or without Command, and the
          // forward Delete key (fn-delete). The tree has no type-to-search
          // that Backspace would edit.
          if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            void remove(selectedOrFocused());
            return;
          }
          if (!event.metaKey) return;
          const targets = selectedOrFocused();
          const focusedFolder = folderOf(targets[0]);
          if (event.key === "z" && !event.shiftKey) {
            event.preventDefault();
            void undoRemove();
          } else if (event.key === "c" && !event.shiftKey) {
            event.preventDefault();
            void copyToPasteboard(targets, false);
          } else if (event.key === "x") {
            event.preventDefault();
            void copyToPasteboard(targets, true);
          } else if (event.key === "v") {
            event.preventDefault();
            void paste(focusedFolder);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            if (targets[0]?.kind === "file")
              onOpen(targets[0].path, { pinned: true });
          }
        }}
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          openMenuByMouse({ x: event.clientX, y: event.clientY });
        }}
      >
        {rootError ? (
          <p
            className="file-tree-unavailable"
            data-testid="file-tree-unavailable"
          >
            {plainLine(rootError, 200)}
          </p>
        ) : (
          rows
        )}
        <div className="file-tree-dragline" style={tree.getDragLineStyle()} />
      </div>
      {menu && (
        <>
          <div
            className="workspace-tree-menu-backdrop"
            onContextMenu={(event) => {
              event.preventDefault();
              closeMenu(false);
            }}
            onPointerDown={() => closeMenu(false)}
          />
          <div
            aria-label={
              menuEntry ? `Actions for ${menuEntry.name}` : "Explorer actions"
            }
            className="workspace-tree-menu"
            onKeyDown={(event) => {
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              ];
              const index = items.indexOf(
                document.activeElement as HTMLElement,
              );
              const go = (next: number) => {
                event.preventDefault();
                items[(next + items.length) % items.length]?.focus();
              };
              if (event.key === "ArrowDown") go(index + 1);
              else if (event.key === "ArrowUp") go(index < 0 ? -1 : index - 1);
              else if (event.key === "Home") go(0);
              else if (event.key === "End") go(-1);
              else if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu(true);
              }
            }}
            ref={(node) => {
              if (!node) return;
              const box = node.getBoundingClientRect();
              const overflowX = box.right - window.innerWidth + 8;
              const overflowY = box.bottom - window.innerHeight + 8;
              if (overflowX > 0)
                node.style.left = `${Math.max(8, menu.x - overflowX)}px`;
              if (overflowY > 0)
                node.style.top = `${Math.max(8, menu.y - overflowY)}px`;
              // Opened from the keyboard, its first item takes focus so the
              // arrow keys work straight away.
              if (menu.byKey && !node.contains(document.activeElement))
                node
                  .querySelector<HTMLElement>(
                    '[role="menuitem"]:not(:disabled)',
                  )
                  ?.focus();
            }}
            role="menu"
            style={{ left: menu.x, top: menu.y }}
          >
            {menuEntry?.immutableReason && (
              <small className="workspace-tree-menu-reason">
                {menuEntry.immutableReason}
              </small>
            )}
            {menuItems.map((action, index) => (
              <Fragment key={action.id}>
                {index > 0 &&
                  menuItems[index - 1]?.section !== action.section && <hr />}
                <button
                  className={action.danger ? "destructive" : undefined}
                  disabled={action.disabled}
                  onClick={() => {
                    closeMenu(true);
                    action.run();
                  }}
                  role="menuitem"
                  type="button"
                >
                  {action.label}
                  {action.keys && <kbd>{formatKeyGlyphs(action.keys)}</kbd>}
                </button>
              </Fragment>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function TreeRow({
  git,
  item,
  onMenu,
  onOpen,
}: {
  git?: { status: GitStatus; folder: boolean };
  item: ItemInstance<WorkspaceFileEntryDto>;
  onMenu(menu: { entry: WorkspaceFileEntryDto; x: number; y: number }): void;
  onOpen(path: string, options: { pinned: boolean }): void;
}) {
  const entry = item.getItemData();
  const level = item.getItemMeta().level;
  const classes = [
    "file-tree-row",
    item.isSelected() ? "selected" : "",
    item.isFocused() ? "focused" : "",
    item.isDragTarget() ? "drop-target" : "",
    entry.kind === "symlink" ? "symlink" : "",
    git ? `git-${git.status}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      {...item.getProps()}
      className={classes}
      data-path={entry.path}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!item.isSelected()) item.getTree().setSelectedItems([item.getId()]);
        onMenu({ entry, x: event.clientX, y: event.clientY });
      }}
      onDoubleClick={() => {
        if (entry.kind === "file") onOpen(entry.path, { pinned: true });
      }}
      style={{ paddingLeft: `${4 + level * INDENT}px` }}
      title={
        git
          ? `${entry.path} · ${git.folder ? "contains changes" : git.status}`
          : entry.path
      }
    >
      <span
        aria-hidden="true"
        className={`file-tree-twisty ${item.isExpanded() ? "open" : ""}`}
      >
        {entry.kind === "directory" ? "›" : ""}
      </span>
      <FileIcon entry={entry} open={item.isExpanded()} />
      {item.isRenaming() ? (
        <input
          {...item.getRenameInputProps()}
          aria-label={`Rename ${entry.name}`}
          className="file-tree-rename"
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <span className="file-tree-name">{entry.name}</span>
      )}
      {git &&
        (git.folder ? (
          <span aria-hidden="true" className="file-tree-git folder" />
        ) : (
          <span aria-label={git.status} className="file-tree-git">
            {GIT_LETTER[git.status]}
          </span>
        ))}
    </div>
  );
}

function FileIcon({
  entry,
  open,
}: {
  entry: WorkspaceFileEntryDto;
  open: boolean;
}) {
  if (entry.kind === "directory")
    return (
      <svg
        aria-hidden="true"
        className="file-tree-icon folder"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 16 16"
      >
        {open ? (
          <path d="M1.5 3.5h4.5l1.5 1.5h6v1.5M1.5 3.5v9h11l2-6h-11l-2 6" />
        ) : (
          <path d="M1.5 3.5h4.5l1.5 1.5h7v7.5h-13z" />
        )}
      </svg>
    );
  if (entry.kind === "symlink")
    return (
      <span aria-hidden="true" className="file-tree-icon symlink">
        ↗
      </span>
    );
  return <FileTypeIcon name={entry.name} />;
}

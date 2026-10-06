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
import type { ChangedFileDto, WorkspaceFileEntryDto } from "@daedalus/protocol";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DesktopClient } from "../client-types";
import { askConfirm, askText } from "../dialogs";
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
const MAX_DROPPED_FILE_BYTES = 1024 * 1024;

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
  const [pending, setPending] = useState<PendingEntry>();
  const [menu, setMenu] = useState<{
    entry?: WorkspaceFileEntryDto;
    x: number;
    y: number;
  }>();

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
      const unique = [...new Set(paths)];
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
    void (async () => {
      const root = await list("");
      if (cancelled) return;
      if (!root) {
        onError("Could not list the workspace folder.");
        return;
      }
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
        ? only.kind === "directory"
          ? "Delete folder"
          : "Delete file"
        : `Delete ${removable.length} items`,
      message: only
        ? only.kind === "directory"
          ? `Delete the folder ${only.name} and everything inside it? This cannot be undone.`
          : `Delete ${only.name}? This cannot be undone.`
        : `Delete ${removable.map((entry) => entry.name).join(", ")}? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    const parents = new Set<string>();
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
      onRemoved(entry.path);
    }
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

  /**
   * Files dragged in from Finder. Only text the editor could open is copied,
   * because the file verbs carry text; a binary file is refused by name.
   */
  const copyIn = async (files: readonly File[], destination: string) => {
    const refused: string[] = [];
    for (const file of files) {
      if (file.size > MAX_DROPPED_FILE_BYTES) {
        refused.push(file.name);
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.subarray(0, 8192).includes(0)) {
        refused.push(file.name);
        continue;
      }
      const created = await client.request.workspaceEntryCreate({
        workspace: workspaceId,
        parentPath: destination || undefined,
        name: file.name,
        kind: "file",
      });
      if (!created.ok) {
        onError(created.error.message);
        continue;
      }
      const written = await client.request.workspaceFileWrite({
        workspace: workspaceId,
        path: created.data.path,
        content: new TextDecoder().decode(bytes),
        expectedContent: "",
      });
      if (!written.ok) onError(written.error.message);
    }
    if (refused.length > 0)
      onError(
        `Not copied (binary, a folder, or over 1 MB): ${refused.join(", ")}`,
      );
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
    onDropForeignDragObject: (dataTransfer, target) =>
      copyIn(
        [...dataTransfer.files],
        target.item.getId() === ROOT ? "" : target.item.getId(),
      ),
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
  // without taking focus from the editor.
  useEffect(() => {
    if (!activePath) return;
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
      if (event.key === "Escape") setMenu(undefined);
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
        onMenu={setMenu}
        onOpen={onOpen}
      />,
    );
    if (pending && pending.parent === item.getId() && item.isExpanded())
      rows.push(pendingRow);
  }

  const menuEntry = menu?.entry;
  const menuTarget = menuEntry
    ? menuEntry.kind === "directory"
      ? menuEntry.path
      : workspaceParentPath(menuEntry.path)
    : "";
  const copy = (text: string) => void client.request.clipboardWrite({ text });
  const menuTargets = () => {
    if (!menuEntry) return [];
    const selected = tree.getSelectedItems().map((item) => item.getItemData());
    return selected.some((entry) => entry.path === menuEntry.path)
      ? selected
      : [menuEntry];
  };

  return (
    <>
      <div
        {...tree.getContainerProps("Workspace files")}
        className="file-tree"
        onKeyDown={(event) => {
          if (!event.metaKey || event.target instanceof HTMLInputElement)
            return;
          const targets = selectedOrFocused();
          const focusedFolder = folderOf(targets[0]);
          if (event.key === "Backspace") {
            event.preventDefault();
            void remove(targets);
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
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {rows}
        <div className="file-tree-dragline" style={tree.getDragLineStyle()} />
      </div>
      {menu && (
        <>
          <div
            className="workspace-tree-menu-backdrop"
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(undefined);
            }}
            onPointerDown={() => setMenu(undefined)}
          />
          <div
            aria-label={
              menuEntry ? `Actions for ${menuEntry.name}` : "Explorer actions"
            }
            className="workspace-tree-menu"
            ref={(node) => {
              if (!node) return;
              const box = node.getBoundingClientRect();
              const overflowX = box.right - window.innerWidth + 8;
              const overflowY = box.bottom - window.innerHeight + 8;
              if (overflowX > 0)
                node.style.left = `${Math.max(8, menu.x - overflowX)}px`;
              if (overflowY > 0)
                node.style.top = `${Math.max(8, menu.y - overflowY)}px`;
            }}
            role="menu"
            style={{ left: menu.x, top: menu.y }}
          >
            {menuEntry?.immutableReason && (
              <small className="workspace-tree-menu-reason">
                {menuEntry.immutableReason}
              </small>
            )}
            {menuEntry?.kind === "file" && (
              <button
                onClick={() => {
                  setMenu(undefined);
                  onOpen(menuEntry.path, { pinned: true });
                }}
                role="menuitem"
                type="button"
              >
                Open
              </button>
            )}
            <button
              disabled={isReadOnlyFolder(menuTarget)}
              onClick={() => {
                setMenu(undefined);
                startNewEntry("file", menuEntry?.path ?? ROOT);
              }}
              role="menuitem"
              type="button"
            >
              New File…
            </button>
            <button
              disabled={isReadOnlyFolder(menuTarget)}
              onClick={() => {
                setMenu(undefined);
                startNewEntry("directory", menuEntry?.path ?? ROOT);
              }}
              role="menuitem"
              type="button"
            >
              New Folder…
            </button>
            <hr />
            {menuEntry && (
              <>
                <button
                  disabled={!menuEntry.mutable}
                  onClick={() => {
                    setMenu(undefined);
                    void copyToPasteboard(menuTargets(), true);
                  }}
                  role="menuitem"
                  type="button"
                >
                  Cut <kbd>⌘X</kbd>
                </button>
                <button
                  onClick={() => {
                    setMenu(undefined);
                    void copyToPasteboard(menuTargets(), false);
                  }}
                  role="menuitem"
                  type="button"
                >
                  Copy <kbd>⌘C</kbd>
                </button>
              </>
            )}
            <button
              disabled={isReadOnlyFolder(menuTarget)}
              onClick={() => {
                setMenu(undefined);
                void paste(menuTarget);
              }}
              role="menuitem"
              type="button"
            >
              Paste <kbd>⌘V</kbd>
            </button>
            {menuEntry && (
              <>
                <hr />
                <button
                  onClick={() => {
                    setMenu(undefined);
                    copy(`${workspacePath}/${menuEntry.path}`);
                  }}
                  role="menuitem"
                  type="button"
                >
                  Copy Path
                </button>
                <button
                  onClick={() => {
                    setMenu(undefined);
                    copy(menuEntry.path);
                  }}
                  role="menuitem"
                  type="button"
                >
                  Copy Relative Path
                </button>
                <hr />
                <button
                  disabled={!menuEntry.mutable}
                  onClick={() => {
                    setMenu(undefined);
                    tree.getItemInstance(menuEntry.path).startRenaming();
                  }}
                  role="menuitem"
                  type="button"
                >
                  Rename
                </button>
                <button
                  disabled={!menuEntry.mutable}
                  onClick={() => {
                    setMenu(undefined);
                    void askText({
                      title: `Move ${menuEntry.name}`,
                      message:
                        "Move into which folder? Leave empty for the workspace root.",
                      initial: workspaceParentPath(menuEntry.path),
                      confirmLabel: "Move",
                    }).then((destination) => {
                      if (destination === null) return;
                      void move(
                        [menuEntry],
                        destination.trim().replace(/^\/+|\/+$/g, ""),
                      );
                    });
                  }}
                  role="menuitem"
                  type="button"
                >
                  Move to…
                </button>
                <button
                  className="destructive"
                  disabled={!menuEntry.mutable}
                  onClick={() => {
                    setMenu(undefined);
                    void remove(menuTargets());
                  }}
                  role="menuitem"
                  type="button"
                >
                  Delete <kbd>⌘⌫</kbd>
                </button>
              </>
            )}
            {!menuEntry && (
              <button
                onClick={() => {
                  setMenu(undefined);
                  setExpanded([]);
                }}
                role="menuitem"
                type="button"
              >
                Collapse All
              </button>
            )}
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

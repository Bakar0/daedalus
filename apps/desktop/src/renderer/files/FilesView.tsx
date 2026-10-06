import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChangedFileDto, WorkspaceFileEntryDto } from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import type { DiffTarget, EditorAreaHandle } from "./EditorArea";
import {
  clampExplorerWidth,
  EXPLORER_DEFAULT_WIDTH,
  EXPLORER_MAX_WIDTH,
  EXPLORER_MIN_WIDTH,
  EXPLORER_VIEWER_MIN_WIDTH,
} from "./explorer-state";
import { FileTree, type FileTreeHandle } from "./FileTree";

// Monaco and dockview are several megabytes the app needs only once someone
// opens the Workspace view, and neither can load outside a browser, which is
// where the render tests run.
const EditorArea = lazy(() => import("./EditorArea"));

const PANEL_STEP = 24;

export interface FileOpenRequest {
  path: string;
  line?: number;
  column?: number;
  /** Open the file's changes as a diff instead of the file itself. */
  diff?: DiffTarget;
  pinned?: boolean;
  /** A fresh value per request, so the same file can be asked for twice. */
  nonce: number;
}
const WIDTH_KEY = "daedalus.panel.explorer-width";

const storedWidth = () => {
  if (typeof window === "undefined") return EXPLORER_DEFAULT_WIDTH;
  const stored = Number(window.localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0
    ? stored
    : EXPLORER_DEFAULT_WIDTH;
};

type OpenRequest = Parameters<EditorAreaHandle["open"]>;

export interface FilesViewProps {
  client: DesktopClient;
  workspace: { id: string; name: string; path: string };
  theme: "dark" | "light";
  /** The workspace root's entries, already loaded with the workspace content. */
  initialRoot?: WorkspaceFileEntryDto[];
  /** Session worktree folders and the commit each branched from. */
  worktreeBases?: ReadonlyMap<string, string | null>;
  /** What session worktrees changed, by workspace path, for the tree's colours. */
  gitStatus?: ReadonlyMap<string, ChangedFileDto["status"]>;
  /** A file to open, from a terminal link; acted on when the nonce changes. */
  openRequest?: FileOpenRequest;
  /** A journal heading the task timeline linked to; opened once, then cleared. */
  journalTarget?: string;
  onJournalTargetShown(): void;
  onError(message: string): void;
  onWorkspaceDocumentSaved(): void;
}

export function FilesView({
  client,
  workspace,
  theme,
  initialRoot,
  gitStatus,
  worktreeBases,
  openRequest,
  journalTarget,
  onJournalTargetShown,
  onError,
  onWorkspaceDocumentSaved,
}: FilesViewProps) {
  const [width, setWidth] = useState(storedWidth);
  const [activePath, setActivePath] = useState<string>();
  const browser = useRef<HTMLDivElement>(null);
  const tree = useRef<FileTreeHandle | null>(null);
  const editor = useRef<EditorAreaHandle | null>(null);
  // Requests made before the editor chunk has loaded wait here.
  const queued = useRef<Array<(handle: EditorAreaHandle) => void>>([]);
  const withEditor = useCallback(
    (request: (handle: EditorAreaHandle) => void) => {
      if (editor.current) request(editor.current);
      else queued.current.push(request);
    },
    [],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // The width is a convenience.
    }
  }, [width]);

  const open = useCallback(
    (...request: OpenRequest) =>
      withEditor((handle) => handle.open(...request)),
    [withEditor],
  );

  const editorRef = useCallback((handle: EditorAreaHandle | null) => {
    editor.current = handle;
    if (!handle) return;
    for (const request of queued.current.splice(0)) request(handle);
  }, []);

  useEffect(() => {
    if (!openRequest) return;
    const { diff } = openRequest;
    if (diff)
      withEditor((handle) =>
        handle.openDiff(diff, { pinned: openRequest.pinned ?? false }),
      );
    else
      open(openRequest.path, {
        pinned: openRequest.pinned ?? true,
        line: openRequest.line,
        column: openRequest.column,
      });
    // Only a new request opens anything; the same one seen again does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.nonce]);

  useEffect(() => {
    if (!journalTarget) return;
    open("JOURNAL.md", {
      pinned: true,
      mode: "preview",
      heading: journalTarget,
    });
    onJournalTargetShown();
  }, [journalTarget, onJournalTargetShown, open]);

  // The explorer's own border, separate from the shell's column resizer:
  // its maximum is whatever leaves the editor beside it usable.
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth =
      browser.current?.querySelector<HTMLElement>(".workspace-explorer")
        ?.offsetWidth ?? width;
    const available =
      (browser.current?.clientWidth ?? window.innerWidth) -
      EXPLORER_VIEWER_MIN_WIDTH -
      handle.offsetWidth;
    handle.classList.add("dragging");
    document.body.classList.add("resizing-column-panel");
    const move = (moveEvent: PointerEvent) =>
      setWidth(
        clampExplorerWidth(startWidth + moveEvent.clientX - startX, available),
      );
    const stop = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing-column-panel");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    <div
      className="workspace-browser"
      ref={browser}
      style={{ "--explorer-width": `${width}px` } as CSSProperties}
    >
      <aside className="workspace-explorer">
        <div className="workspace-explorer-heading">
          <div>
            <span>Explorer</span>
            <small>{workspace.name}</small>
          </div>
          <div className="workspace-explorer-actions">
            <button
              aria-label="New file"
              onClick={() => tree.current?.newEntry("file")}
              title="New File…"
              type="button"
            >
              <svg
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 16 16"
              >
                <path d="M3 1.5h6l4 4v9H3zM9 1.5v4h4M8 8v4M6 10h4" />
              </svg>
            </button>
            <button
              aria-label="New folder"
              onClick={() => tree.current?.newEntry("directory")}
              title="New Folder…"
              type="button"
            >
              <svg
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 16 16"
              >
                <path d="M1.5 3h5l1.5 2h6.5v8.5h-13zM9 7.5v4M7 9.5h4" />
              </svg>
            </button>
            <button
              aria-label="Collapse folders"
              onClick={() => tree.current?.collapseAll()}
              title="Collapse Folders in Explorer"
              type="button"
            >
              <svg
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 16 16"
              >
                <path d="M2.5 2.5h8v8h-8zM5.5 13.5h8v-8M4.5 6.5h4" />
              </svg>
            </button>
          </div>
        </div>
        <FileTree
          activePath={activePath}
          gitStatus={gitStatus}
          client={client}
          handleRef={tree}
          initialRoot={initialRoot}
          onError={onError}
          onMoved={(from, to) => editor.current?.moved(from, to)}
          onOpen={(path, options) => open(path, options)}
          onRemoved={(path) => editor.current?.removed(path)}
          workspaceId={workspace.id}
          workspacePath={workspace.path}
        />
      </aside>

      <div
        aria-label="Resize explorer"
        aria-orientation="vertical"
        aria-valuemax={EXPLORER_MAX_WIDTH}
        aria-valuemin={EXPLORER_MIN_WIDTH}
        aria-valuenow={width}
        className="column-resize-handle explorer-resize-handle"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setWidth((current) =>
            clampExplorerWidth(
              current + (event.key === "ArrowRight" ? PANEL_STEP : -PANEL_STEP),
              EXPLORER_MAX_WIDTH,
            ),
          );
        }}
        onPointerDown={startResize}
        role="separator"
        tabIndex={0}
      />

      <section className="workspace-viewer">
        <Suspense
          fallback={<div className="editor-loading">Loading the editor…</div>}
        >
          <EditorArea
            client={client}
            handleRef={editorRef}
            key={workspace.id}
            onActiveChange={setActivePath}
            onError={onError}
            onWorkspaceDocumentSaved={onWorkspaceDocumentSaved}
            theme={theme}
            workspaceId={workspace.id}
            worktreeBases={worktreeBases}
          />
        </Suspense>
      </section>
    </div>
  );
}

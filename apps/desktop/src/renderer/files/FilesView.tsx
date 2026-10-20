import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangedFileDto, WorkspaceFileEntryDto } from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import type { AppTheme } from "../theme";
import type {
  CenterPanelKind,
  DiffTarget,
  EditorAreaHandle,
} from "./EditorArea";
import { FileTree, type FileTreeHandle } from "./FileTree";

// Monaco and dockview are several megabytes the app needs only once someone
// opens a file, and neither can load outside a browser, which is where the
// render tests run.
const EditorArea = lazy(() => import("./EditorArea"));

export interface FileOpenRequest {
  /** The workspace the path is relative to. */
  workspaceId: string;
  path: string;
  line?: number;
  column?: number;
  /** Open the file's changes as a diff instead of the file itself. */
  diff?: DiffTarget;
  pinned?: boolean;
  /** A fresh value per request, so the same file can be asked for twice. */
  nonce: number;
}

type OpenRequest = Parameters<EditorAreaHandle["open"]>;

/**
 * What the explorer in the side panel and the editor in the center share.
 * They mount apart: the tree stays in the panel while the center shows a
 * session, so a file opened from it waits here until the editor exists.
 */
export interface FilesController {
  tree: React.MutableRefObject<FileTreeHandle | null>;
  editor: React.MutableRefObject<EditorAreaHandle | null>;
  editorRef(handle: EditorAreaHandle | null): void;
  withEditor(request: (handle: EditorAreaHandle) => void): void;
  open(...request: OpenRequest): void;
  activePath?: string;
  setActivePath(path: string | undefined): void;
}

export function useFilesController(): FilesController {
  const [activePath, setActivePath] = useState<string>();
  const tree = useRef<FileTreeHandle | null>(null);
  const editor = useRef<EditorAreaHandle | null>(null);
  // Requests made before the editor chunk has loaded, or while the center
  // shows something else, wait here.
  const queued = useRef<Array<(handle: EditorAreaHandle) => void>>([]);
  const withEditor = useCallback(
    (request: (handle: EditorAreaHandle) => void) => {
      if (editor.current) request(editor.current);
      else queued.current.push(request);
    },
    [],
  );
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
  return useMemo(
    () => ({
      tree,
      editor,
      editorRef,
      withEditor,
      open,
      activePath,
      setActivePath,
    }),
    [activePath, editorRef, open, withEditor],
  );
}

export interface FilesExplorerProps {
  client: DesktopClient;
  controller: FilesController;
  workspace: { id: string; name: string; path: string };
  /** The workspace root's entries, already loaded with the workspace content. */
  initialRoot?: WorkspaceFileEntryDto[];
  /** What session worktrees changed, by workspace path, for the tree's colours. */
  gitStatus?: ReadonlyMap<string, ChangedFileDto["status"]>;
  /** Called before a file opens, so the center can switch to the editor. */
  onOpenFile(): void;
  onError(message: string): void;
}

export function FilesExplorer({
  client,
  controller,
  workspace,
  initialRoot,
  gitStatus,
  onOpenFile,
  onError,
}: FilesExplorerProps) {
  const { tree, editor, open, activePath } = controller;
  return (
    <div className="workspace-explorer">
      <div className="workspace-explorer-heading">
        <div>
          <span>{workspace.name}</span>
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
        onOpen={(path, options) => {
          onOpenFile();
          open(path, options);
        }}
        onRemoved={(path) => editor.current?.removed(path)}
        workspaceId={workspace.id}
        workspacePath={workspace.path}
      />
    </div>
  );
}

export interface FilesEditorProps {
  client: DesktopClient;
  controller: FilesController;
  workspace: { id: string; name: string; path: string };
  theme: AppTheme;
  onActivePanel?(kind: CenterPanelKind | undefined): void;
  onAppPanelClosed?(kind: "session" | "task"): void;
  renderSession?(): React.ReactNode;
  sessionTitle?: string;
  renderTask?(): React.ReactNode;
  taskTitle?: string;
  renderEmpty?(): React.ReactNode;
  sessionIcon?: React.ReactNode;
  renderTerminal?(terminalId: string): React.ReactNode;
  onNewTerminal?(): void;
  onTerminalTabClosed?(terminalId: string): void;
  onOpenExternal?(url: string): void;
  /** What to show while the editor chunk loads: the tab that will be in front. */
  loadingContent?: React.ReactNode;
  /** Session worktree folders and the commit each branched from. */
  worktreeBases?: ReadonlyMap<string, string | null>;
  /** A file to open, from a terminal link; opened once, then cleared. */
  openRequest?: FileOpenRequest;
  onOpenRequestShown(): void;
  /** A journal heading the task timeline linked to; opened once, then cleared. */
  journalTarget?: string;
  onJournalTargetShown(): void;
  onError(message: string): void;
  onWorkspaceDocumentSaved(): void;
}

export function FilesEditor({
  client,
  controller,
  workspace,
  theme,
  worktreeBases,
  openRequest,
  onOpenRequestShown,
  journalTarget,
  onJournalTargetShown,
  onError,
  onWorkspaceDocumentSaved,
  loadingContent,
  ...center
}: FilesEditorProps) {
  const { editorRef, withEditor, open, setActivePath } = controller;

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
    onOpenRequestShown();
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

  return (
    <section className="workspace-viewer">
      <Suspense
        fallback={
          loadingContent ?? (
            <div className="editor-loading">Loading the editor…</div>
          )
        }
      >
        <EditorArea
          {...center}
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
  );
}

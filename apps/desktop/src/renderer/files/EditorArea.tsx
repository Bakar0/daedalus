import "dockview-react/dist/styles/dockview.css";
import {
  type DockviewApi,
  DockviewReact,
  type IDockviewPanel,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type IDockviewHeaderActionsProps,
  type ReactContextMenuItemConfig,
} from "dockview-react";
import type { WorkspaceFileDto } from "@daedalus/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DesktopClient } from "../client-types";
import { askConfirm } from "../dialogs";
import { MarkdownPreview } from "../markdown-preview";
import {
  closeDocument,
  documentsIn,
  documentsRevision,
  getDocument,
  isDirty,
  markSaved,
  type OpenDocument,
  openDocument,
  reloadDocument,
  renameDocument,
  subscribeDocuments,
} from "./documents";
import { workspaceBaseName } from "./explorer-state";
import { FileTypeIcon } from "./file-icons";
import { monaco } from "./monaco";
import { quickDiff } from "./quick-diff";

/** A changed file the Changes view asks to see as a diff. */
export interface DiffTarget {
  /** Workspace-relative path of the file as it is now. */
  path: string;
  /** The worktree folder, workspace-relative. */
  root: string;
  repositoryPath: string;
  originalRepositoryPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  /** A diff of one commit against its parent, instead of the work so far. */
  commit?: { sha: string; shortSha: string };
}

export interface OpenOptions {
  pinned: boolean;
  mode?: "edit" | "preview";
  heading?: string;
  /** Where to put the cursor, 1-based, as a terminal link names it. */
  line?: number;
  column?: number;
}

export interface EditorAreaHandle {
  open(path: string, options: OpenOptions): void;
  openDiff(target: DiffTarget, options: { pinned: boolean }): void;
  /** An entry moved from the tree. Open documents under it follow. */
  moved(from: string, to: string): void;
  removed(path: string): void;
}

export interface EditorAreaProps {
  client: DesktopClient;
  workspaceId: string;
  theme: "dark" | "light";
  onActiveChange(path: string | undefined): void;
  onError(message: string): void;
  /** BRIEF.md or JOURNAL.md was written; other views show their content. */
  onWorkspaceDocumentSaved(): void;
  handleRef: React.Ref<EditorAreaHandle>;
  /** Session worktree folders and the commit each branched from. */
  worktreeBases?: ReadonlyMap<string, string | null>;
}

interface FilePanelParams {
  path: string;
  preview?: boolean;
  mode?: "edit" | "preview";
  /** A journal heading to scroll to once, then forgotten. */
  heading?: string;
  /** Set on a diff tab: what to compare the file with. */
  diff?: DiffTarget;
}

const panelId = (path: string) => `file:${path}`;
const diffPanelId = (path: string, commit?: string) =>
  commit ? `commit:${commit}:${path}` : `diff:${path}`;
const layoutKey = (workspaceId: string) =>
  `daedalus.editor.layout.${workspaceId}`;

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
const isReadOnlyPath = (path: string) => path.startsWith("repos/");

interface EditorContextValue {
  client: DesktopClient;
  workspaceId: string;
  theme: "dark" | "light";
  load(path: string): Promise<OpenDocument | undefined>;
  save(doc: OpenDocument): Promise<void>;
  close(panel: IDockviewPanel): Promise<void>;
  pin(panel: IDockviewPanel): void;
  onError(message: string): void;
  onWorkspaceDocumentSaved(): void;
  /** A file's text where its worktree branched, or undefined outside one. */
  baseText(path: string): Promise<string | undefined> | undefined;
}

const EditorContext = createContext<EditorContextValue | null>(null);
const useEditorContext = () => {
  const context = useContext(EditorContext);
  if (!context) throw new Error("EditorContext is missing");
  return context;
};

/**
 * Who takes keyboard focus, as VS Code decides it: a single click in the tree
 * opens a preview and leaves focus in the tree; a double-click, Cmd+Down, a
 * new file or a click on the tab puts the cursor in the editor. A request
 * waits here when the editor it names has not mounted yet.
 */
interface FocusRequest {
  panel: string;
  line?: number;
  column?: number;
}
let pendingFocus: FocusRequest | undefined;
const focusListeners = new Set<(request: FocusRequest) => void>();
const requestFocus = (panel: string, line?: number, column?: number) => {
  pendingFocus = { panel, line, column };
  for (const listener of focusListeners) listener(pendingFocus);
};

/**
 * Hands an editor its focus requests: now when one is waiting for it, and
 * later as they come. With a line, the cursor goes there and the line is
 * centred, which is what following a link from a terminal wants.
 */
function listenForFocus(
  panel: string,
  editor: monaco.editor.ICodeEditor,
): () => void {
  const focus = (request: FocusRequest) => {
    if (request.panel !== panel) return;
    pendingFocus = undefined;
    // A frame later: activating the tab re-renders the panel, and a focus
    // taken during that render is dropped again.
    requestAnimationFrame(() => {
      if (request.line) {
        const position = {
          lineNumber: request.line,
          column: request.column ?? 1,
        };
        editor.setPosition(position);
        editor.revealPositionInCenter(position);
      }
      editor.focus();
    });
  };
  if (pendingFocus) focus(pendingFocus);
  focusListeners.add(focus);
  return () => {
    focusListeners.delete(focus);
  };
}

const useDocumentsRevision = () =>
  useSyncExternalStore(subscribeDocuments, documentsRevision);

export default function EditorArea({
  client,
  workspaceId,
  theme,
  onActiveChange,
  onError,
  onWorkspaceDocumentSaved,
  handleRef,
  worktreeBases,
}: EditorAreaProps) {
  // Base text by root, base commit and path. A new base (the worktree was
  // rebased, or main was fetched) is a new key, so the cache never goes stale.
  const baseCache = useRef(new Map<string, Promise<string | undefined>>());
  const baseText = (path: string) => {
    if (!worktreeBases) return undefined;
    for (const [root, base] of worktreeBases) {
      if (!path.startsWith(`${root}/`)) continue;
      const repositoryPath = path.slice(root.length + 1);
      const key = `${root}\u0000${base ?? "HEAD"}\u0000${repositoryPath}`;
      let text = baseCache.current.get(key);
      if (!text) {
        text = client.request
          .workspaceChangeOriginal({
            workspace: workspaceId,
            root,
            repositoryPath,
          })
          .then((response) =>
            response.ok && !response.data.binary
              ? response.data.content
              : undefined,
          )
          .catch(() => undefined);
        baseCache.current.set(key, text);
      }
      return text;
    }
    return undefined;
  };
  const apiRef = useRef<DockviewApi | undefined>(undefined);
  const loading = useRef(new Map<string, Promise<OpenDocument | undefined>>());
  const callbacks = useRef({
    onActiveChange,
    onError,
    onWorkspaceDocumentSaved,
  });
  callbacks.current = { onActiveChange, onError, onWorkspaceDocumentSaved };

  const load = useCallback(
    (path: string) => {
      const existing = getDocument(workspaceId, path);
      if (existing) return Promise.resolve(existing);
      const inFlight = loading.current.get(path);
      if (inFlight) return inFlight;
      const request = client.request
        .workspaceFileRead({ workspace: workspaceId, path })
        .then((response) => {
          loading.current.delete(path);
          if (!response.ok) {
            callbacks.current.onError(response.error.message);
            return undefined;
          }
          return openDocument(workspaceId, response.data);
        });
      loading.current.set(path, request);
      return request;
    },
    [client, workspaceId],
  );

  const save = useCallback(
    async (doc: OpenDocument) => {
      if (!isDirty(doc) || isReadOnlyPath(doc.path)) return;
      const content = doc.model.getValue();
      const version = doc.model.getAlternativeVersionId();
      const response = await client.request.workspaceFileWrite({
        workspace: workspaceId,
        path: doc.path,
        content,
        expectedContent: doc.file.content,
      });
      if (!response.ok) {
        callbacks.current.onError(response.error.message);
        return;
      }
      // Typing during the round trip leaves the document dirty against what
      // was written, which is the truth.
      markSaved(doc, response.data, version);
      if (doc.path === "BRIEF.md" || doc.path === "JOURNAL.md")
        callbacks.current.onWorkspaceDocumentSaved();
    },
    [client, workspaceId],
  );

  const close = useCallback(
    async (panel: IDockviewPanel) => {
      const params = panel.params as FilePanelParams | undefined;
      const path = params?.path;
      const doc = path ? getDocument(workspaceId, path) : undefined;
      if (doc && isDirty(doc)) {
        const discard = await askConfirm({
          title: "Unsaved changes",
          message: `${workspaceBaseName(doc.path)} has unsaved changes. Close it and discard them?`,
          confirmLabel: "Don't Save",
          danger: true,
        });
        if (!discard) return;
      }
      panel.api.close();
    },
    [workspaceId],
  );

  const pin = useCallback((panel: IDockviewPanel) => {
    const params = panel.params as FilePanelParams | undefined;
    if (params?.preview)
      panel.api.updateParameters({ ...params, preview: false });
  }, []);

  /**
   * Adds a tab, or shows the one there is. An unpinned tab is the group's
   * preview: the next one replaces it, as long as nobody has typed into it.
   */
  const place = useCallback(
    (
      id: string,
      component: "file" | "diff",
      params: FilePanelParams,
      pinned: boolean,
    ) => {
      const api = apiRef.current;
      if (!api) return;
      const existing = api.getPanel(id);
      if (existing) {
        const current = existing.params as FilePanelParams;
        existing.api.updateParameters({
          ...current,
          ...params,
          preview: pinned ? false : current.preview,
        });
        existing.api.setActive();
        return;
      }
      const group = api.activeGroup;
      const preview = group?.panels.find((panel) => {
        const current = panel.params as FilePanelParams | undefined;
        if (!current?.preview) return false;
        const doc = getDocument(workspaceId, current.path);
        return !doc || !isDirty(doc);
      });
      api.addPanel({
        id,
        component,
        tabComponent: "file",
        title: workspaceBaseName(params.path),
        params: { ...params, preview: !pinned },
        ...(preview
          ? { position: { referencePanel: preview.id, direction: "within" } }
          : group
            ? { position: { referenceGroup: group.id, direction: "within" } }
            : {}),
      });
      if (preview) preview.api.close();
    },
    [workspaceId],
  );

  const openDiff = useCallback(
    (target: DiffTarget, options: { pinned: boolean }) => {
      const id = diffPanelId(target.path, target.commit?.sha);
      place(id, "diff", { path: target.path, diff: target }, options.pinned);
      if (options.pinned) requestFocus(id);
    },
    [place],
  );

  const open = useCallback(
    (path: string, options: OpenOptions) => {
      const existing = apiRef.current?.getPanel(panelId(path));
      const current = existing?.params as FilePanelParams | undefined;
      place(
        panelId(path),
        "file",
        {
          path,
          mode: options.mode ?? current?.mode ?? "edit",
          heading: options.heading ?? current?.heading,
        },
        options.pinned,
      );
      if (options.pinned || options.line !== undefined)
        requestFocus(panelId(path), options.line, options.column);
    },
    [place],
  );

  // A request that arrives before dockview is ready (the editor chunk has
  // just loaded because a link or the workspace panel asked for a file) waits
  // here and runs once the layout is restored.
  const pending = useRef<Array<() => void>>([]);
  // What the last `onReady` ran. React's development StrictMode mounts
  // dockview twice and hands over a second instance; replaying these on it
  // keeps the request from landing on the instance that was thrown away.
  const delivered = useRef<Array<() => void>>([]);
  const whenReady = useCallback((request: () => void) => {
    if (apiRef.current) request();
    else pending.current.push(request);
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({
      open: (path, options) => whenReady(() => open(path, options)),
      openDiff: (target, options) => whenReady(() => openDiff(target, options)),
      moved(from, to) {
        const api = apiRef.current;
        for (const doc of documentsIn(workspaceId)) {
          if (doc.path !== from && !doc.path.startsWith(`${from}/`)) continue;
          const next = to + doc.path.slice(from.length);
          void client.request
            .workspaceFileRead({ workspace: workspaceId, path: next })
            .then((response) => {
              if (!response.ok) return;
              const panel = api?.getPanel(panelId(doc.path));
              const moved = renameDocument(doc, response.data);
              if (!panel || !api) return;
              const params = panel.params as FilePanelParams;
              api.addPanel({
                id: panelId(moved.path),
                component: "file",
                tabComponent: "file",
                title: workspaceBaseName(moved.path),
                params: { ...params, path: moved.path },
                position: { referencePanel: panel.id, direction: "within" },
                inactive: api.activePanel?.id !== panel.id,
              });
              panel.api.close();
            });
        }
      },
      removed(path) {
        const api = apiRef.current;
        for (const doc of documentsIn(workspaceId)) {
          if (doc.path !== path && !doc.path.startsWith(`${path}/`)) continue;
          api?.getPanel(panelId(doc.path))?.api.close();
          api?.getPanel(diffPanelId(doc.path))?.api.close();
          closeDocument(doc);
        }
      },
    }),
    [client, open, openDiff, whenReady, workspaceId],
  );

  // Files changed on disk: a clean document takes the new content, a deleted
  // one closes. A dirty document is never touched; the save reports the
  // conflict instead of anything being lost here.
  useEffect(
    () =>
      client.subscribeWorkspaceFiles(
        ({ workspaceId: changed, changes, overflow }) => {
          if (changed !== workspaceId) return;
          for (const doc of documentsIn(workspaceId)) {
            if (isDirty(doc)) continue;
            const change = changes.find((item) => item.path === doc.path);
            if (!overflow && !change) continue;
            void client.request
              .workspaceFileRead({ workspace: workspaceId, path: doc.path })
              .then((response) => {
                if (isDirty(doc)) return;
                if (response.ok) {
                  if (response.data.content !== doc.file.content)
                    reloadDocument(doc, response.data);
                  return;
                }
                if (change?.kind === "deleted" || overflow) {
                  apiRef.current?.getPanel(panelId(doc.path))?.api.close();
                  closeDocument(doc);
                }
              });
          }
        },
      ),
    [client, workspaceId],
  );

  // Cmd+S saves and Cmd+W closes the active tab; Cmd+Shift+[ and ] move
  // between tabs. Handled here rather than as Monaco commands so they also
  // work on a Markdown preview.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const api = apiRef.current;
      if (!api || !event.metaKey) return;
      const target = event.target as Node | null;
      const root = document.querySelector(".editor-area");
      if (!root || !target || !root.contains(target)) return;
      if (event.key === "s" && !event.shiftKey) {
        event.preventDefault();
        const params = api.activePanel?.params as FilePanelParams | undefined;
        const doc = params && getDocument(workspaceId, params.path);
        if (doc) void save(doc);
      } else if (event.key === "w" && !event.shiftKey) {
        event.preventDefault();
        if (api.activePanel) void close(api.activePanel);
      } else if (event.shiftKey && event.code === "BracketRight") {
        event.preventDefault();
        api.activateNext();
      } else if (event.shiftKey && event.code === "BracketLeft") {
        event.preventDefault();
        api.activatePrevious();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, save, workspaceId]);

  const onReady = useCallback(
    ({ api }: { api: DockviewApi }) => {
      apiRef.current = api;
      let restored = false;
      try {
        const raw = window.localStorage.getItem(layoutKey(workspaceId));
        if (raw) {
          api.fromJSON(JSON.parse(raw));
          restored = api.totalPanels > 0;
        }
      } catch {
        api.clear();
      }
      const queued = pending.current.splice(0);
      const waiting = queued.length > 0 ? queued : delivered.current;
      delivered.current = waiting;
      if (!restored && waiting.length === 0) open("BRIEF.md", { pinned: true });
      for (const request of waiting) request();
      const persist = () => {
        try {
          window.localStorage.setItem(
            layoutKey(workspaceId),
            JSON.stringify(api.toJSON()),
          );
        } catch {
          // A full or disabled store costs the layout on the next visit only.
        }
      };
      api.onDidLayoutChange(persist);
      api.onDidActivePanelChange((event) => {
        const params = event.panel?.params as FilePanelParams | undefined;
        callbacks.current.onActiveChange(params?.path);
      });
      api.onDidRemovePanel((panel) => {
        const params = panel.params as FilePanelParams | undefined;
        if (!params) return;
        // A tab dragged to another group is removed and added; only a real
        // close leaves no panel for the path.
        queueMicrotask(() => {
          if (
            api.getPanel(panelId(params.path)) ||
            api.getPanel(diffPanelId(params.path))
          )
            return;
          const doc = getDocument(workspaceId, params.path);
          if (doc && !isDirty(doc)) closeDocument(doc);
        });
      });
      const active = api.activePanel?.params as FilePanelParams | undefined;
      callbacks.current.onActiveChange(active?.path);
    },
    [open, workspaceId],
  );

  const context: EditorContextValue = {
    client,
    workspaceId,
    theme,
    load,
    save,
    close,
    pin,
    onError: (message) => callbacks.current.onError(message),
    onWorkspaceDocumentSaved: () =>
      callbacks.current.onWorkspaceDocumentSaved(),
    baseText,
  };

  return (
    <EditorContext.Provider value={context}>
      <div className="editor-area">
        <DockviewReact
          className={
            theme === "dark" ? "dockview-theme-dark" : "dockview-theme-light"
          }
          components={{ file: FilePanel, diff: DiffPanel }}
          dndStrategy="pointer"
          getTabContextMenuItems={({ panel, group, api }) =>
            tabMenu(panel, group.panels, api, close, pin)
          }
          onReady={onReady}
          rightHeaderActionsComponent={HeaderActions}
          tabComponents={{ file: FileTab }}
          watermarkComponent={Watermark}
        />
      </div>
    </EditorContext.Provider>
  );
}

function tabMenu(
  panel: IDockviewPanel,
  siblings: readonly IDockviewPanel[],
  api: DockviewApi,
  close: (panel: IDockviewPanel) => Promise<void>,
  pin: (panel: IDockviewPanel) => void,
): ReactContextMenuItemConfig[] {
  const closeEach = async (panels: readonly IDockviewPanel[]) => {
    for (const item of panels) await close(item);
  };
  const index = siblings.indexOf(panel);
  const params = panel.params as FilePanelParams | undefined;
  return [
    { label: "Close", action: () => void close(panel) },
    {
      label: "Close Others",
      action: () => void closeEach(siblings.filter((item) => item !== panel)),
    },
    {
      label: "Close to the Right",
      action: () => void closeEach(siblings.slice(index + 1)),
    },
    { label: "Close All", action: () => void closeEach([...siblings]) },
    {
      label: "Keep Open",
      disabled: !params?.preview,
      action: () => pin(panel),
    },
    {
      label: "Split Right",
      action: () =>
        panel.api.moveTo({
          group: api.addGroup({ referencePanel: panel.id, direction: "right" }),
        }),
    },
  ];
}

function FileTab({ api, params }: IDockviewPanelHeaderProps<FilePanelParams>) {
  const context = useEditorContext();
  useDocumentsRevision();
  const doc = getDocument(context.workspaceId, params.path);
  const dirty = doc ? isDirty(doc) : false;
  const [, setActive] = useState(api.isActive);
  useEffect(() => {
    const disposable = api.onDidActiveChange((event) =>
      setActive(event.isActive),
    );
    return () => disposable.dispose();
  }, [api]);
  const panel = api.group.panels.find((item) => item.api === api);
  return (
    <div
      className={`file-tab ${params.preview ? "preview" : ""} ${dirty ? "dirty" : ""}`}
      onClick={() =>
        requestFocus(
          params.diff
            ? diffPanelId(params.path, params.diff.commit?.sha)
            : panelId(params.path),
        )
      }
      onAuxClick={(event) => {
        if (event.button === 1 && panel) void context.close(panel);
      }}
      onDoubleClick={() => panel && context.pin(panel)}
      title={params.path}
    >
      <FileTypeIcon name={workspaceBaseName(params.path)} />
      <span className="file-tab-name">
        {workspaceBaseName(params.path)}
        {params.diff && (
          <small>
            {" "}
            ({params.diff.commit ? params.diff.commit.shortSha : "working tree"}
            )
          </small>
        )}
      </span>
      <button
        aria-label={`Close ${workspaceBaseName(params.path)}`}
        className="file-tab-close"
        onClick={(event) => {
          event.stopPropagation();
          if (panel) void context.close(panel);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        <span aria-hidden="true" className="file-tab-dot">
          ●
        </span>
        <span aria-hidden="true" className="file-tab-x">
          ×
        </span>
      </button>
    </div>
  );
}

function HeaderActions({ activePanel }: IDockviewHeaderActionsProps) {
  const context = useEditorContext();
  useDocumentsRevision();
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!activePanel) return;
    const disposable = activePanel.api.onDidParametersChange(() =>
      rerender((value) => value + 1),
    );
    return () => disposable.dispose();
  }, [activePanel]);
  const params = activePanel?.params as FilePanelParams | undefined;
  if (!activePanel || !params) return null;
  const doc = getDocument(context.workspaceId, params.path);
  return (
    <div className="editor-header-actions">
      {isReadOnlyPath(params.path) && (
        <span className="editor-header-note">Read-only</span>
      )}
      {isMarkdown(params.path) && (
        <button
          aria-pressed={params.mode === "preview"}
          className={params.mode === "preview" ? "active" : ""}
          onClick={() =>
            activePanel.api.updateParameters({
              ...params,
              preview: false,
              mode: params.mode === "preview" ? "edit" : "preview",
            })
          }
          title="Toggle Markdown preview"
          type="button"
        >
          {params.mode === "preview" ? "Edit" : "Preview"}
        </button>
      )}
      {doc && isDirty(doc) && !isReadOnlyPath(params.path) && (
        <button
          onClick={() => void context.save(doc)}
          title="Save (⌘S)"
          type="button"
        >
          Save
        </button>
      )}
    </div>
  );
}

function Watermark() {
  return (
    <div className="editor-watermark">
      <strong>No file open</strong>
      <span>Open a file from the explorer.</span>
    </div>
  );
}

function FilePanel({ api, params }: IDockviewPanelProps<FilePanelParams>) {
  const context = useEditorContext();
  const [doc, setDoc] = useState<OpenDocument | undefined>(() =>
    getDocument(context.workspaceId, params.path),
  );

  useEffect(() => {
    if (doc && doc.path === params.path && !doc.model.isDisposed()) return;
    let cancelled = false;
    void context.load(params.path).then((loaded) => {
      if (cancelled) return;
      if (loaded) setDoc(loaded);
      // A tab restored from the saved layout whose file is gone.
      else api.close();
    });
    return () => {
      cancelled = true;
    };
  }, [api, context, doc, params.path]);

  const clearHeading = useCallback(
    () => api.updateParameters({ ...params, heading: undefined }),
    [api, params],
  );

  if (!doc) return <div className="editor-loading">Opening…</div>;
  if (params.mode === "preview" && isMarkdown(params.path))
    return (
      <MarkdownPanel
        doc={doc}
        heading={params.heading}
        onHeadingShown={clearHeading}
      />
    );
  return (
    <MonacoPanel
      doc={doc}
      onEdit={() => {
        // Typing into a preview tab keeps it, as in VS Code.
        if (params.preview) api.updateParameters({ ...params, preview: false });
      }}
    />
  );
}

function MonacoPanel({ doc, onEdit }: { doc: OpenDocument; onEdit(): void }) {
  const context = useEditorContext();
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(
    undefined,
  );
  const editEvents = useRef(onEdit);
  editEvents.current = onEdit;

  useEffect(() => {
    const parent = container.current;
    if (!parent || doc.model.isDisposed()) return;
    const editor = monaco.editor.create(parent, {
      model: doc.model,
      automaticLayout: true,
      readOnly: isReadOnlyPath(doc.path),
      theme: context.theme === "dark" ? "daedalus-dark" : "daedalus-light",
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 13,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      wordWrap: isMarkdown(doc.path) ? "on" : "off",
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    if (doc.viewState) editor.restoreViewState(doc.viewState);
    const typing = editor.onDidChangeModelContent(() => editEvents.current());
    const stopListening = listenForFocus(panelId(doc.path), editor);
    return () => {
      stopListening();
      editorRef.current = undefined;
      doc.viewState = editor.saveViewState();
      typing.dispose();
      editor.dispose();
    };
  }, [context.theme, doc]);

  // Margin marks for what changed since the worktree branched, as VS Code
  // draws them: green for added lines, blue for changed ones, a red wedge
  // where lines were removed. Recomputed as the text changes.
  const baseRequest = context.baseText(doc.path);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !baseRequest) return;
    let cancelled = false;
    let base: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const decorations = editor.createDecorationsCollection();
    const paint = () => {
      if (base === undefined || doc.model.isDisposed()) return;
      decorations.set(
        quickDiff(base, doc.model.getValue()).map((range) => ({
          range: new monaco.Range(range.startLine, 1, range.endLine, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: `quick-diff quick-diff-${range.kind}`,
            overviewRuler: {
              color:
                range.kind === "added"
                  ? "#487e02"
                  : range.kind === "modified"
                    ? "#1b81a8"
                    : "#f14c4c",
              position: monaco.editor.OverviewRulerLane.Left,
            },
          },
        })),
      );
    };
    void baseRequest.then((text) => {
      if (cancelled) return;
      base = text;
      paint();
    });
    const changes = doc.model.onDidChangeContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(paint, 250);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      changes.dispose();
      decorations.clear();
    };
    // The editor is rebuilt when the theme changes, and the marks with it.
  }, [baseRequest, context.theme, doc]);

  return <div className="monaco-panel" ref={container} />;
}

/**
 * A changed file next to an earlier version of it, as VS Code's Source
 * Control shows it. For uncommitted work, the left side is HEAD and the
 * right side is the same document a normal tab edits, so typing
 * here marks it dirty and Cmd+S saves. For one commit, both sides come from
 * git and neither is editable. A deleted file has an empty right side.
 */
function DiffPanel({ params }: IDockviewPanelProps<FilePanelParams>) {
  const context = useEditorContext();
  const container = useRef<HTMLDivElement>(null);
  const diff = params.diff;
  const [loaded, setLoaded] = useState<
    | { original: string; modified: OpenDocument | string }
    | { message: string }
    | undefined
  >();

  useEffect(() => {
    if (!diff) return;
    let cancelled = false;
    setLoaded(undefined);
    const empty = { ok: true as const, data: { content: "", binary: false } };
    const read = (repositoryPath: string, ref?: string) =>
      context.client.request.workspaceChangeOriginal({
        workspace: context.workspaceId,
        root: diff.root,
        repositoryPath,
        ...(ref ? { ref } : {}),
      });
    const sha = diff.commit?.sha;
    void (async () => {
      const original =
        diff.status === "added" || diff.status === "untracked"
          ? empty
          : await read(
              diff.originalRepositoryPath ?? diff.repositoryPath,
              sha ? `${sha}^` : undefined,
            );
      const modified =
        diff.status === "deleted"
          ? ""
          : sha
            ? await read(diff.repositoryPath, sha)
            : await context.load(diff.path);
      if (cancelled) return;
      if (!original.ok) {
        setLoaded({ message: original.error.message });
        return;
      }
      if (modified === undefined) {
        setLoaded({ message: "This file can no longer be read." });
        return;
      }
      if (typeof modified === "object" && "ok" in modified) {
        if (!modified.ok) setLoaded({ message: modified.error.message });
        else if (modified.data.binary || original.data.binary)
          setLoaded({ message: "A binary file; there is no text to compare." });
        else
          setLoaded({
            original: original.data.content,
            modified: modified.data.content,
          });
        return;
      }
      if (original.data.binary)
        setLoaded({ message: "A binary file; there is no text to compare." });
      else setLoaded({ original: original.data.content, modified });
    })();
    return () => {
      cancelled = true;
    };
    // `context` is rebuilt on every render; what to load depends on the diff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    diff?.path,
    diff?.root,
    diff?.repositoryPath,
    diff?.status,
    diff?.commit?.sha,
  ]);

  useEffect(() => {
    const parent = container.current;
    if (!parent || !diff || !loaded || "message" in loaded) return;
    const sha = diff.commit?.sha;
    const uri = (scheme: string) =>
      monaco.Uri.from({
        scheme,
        path: `/${context.workspaceId}/${sha ?? "work"}/${diff.path}`,
      });
    const original = monaco.editor.createModel(
      loaded.original,
      undefined,
      uri("daedalus-original"),
    );
    // A commit's version, or a deleted file's empty side, is text of its own;
    // the work so far is the live document.
    const fixed =
      typeof loaded.modified === "string"
        ? monaco.editor.createModel(
            loaded.modified,
            undefined,
            uri("daedalus-commit"),
          )
        : undefined;
    const modified =
      typeof loaded.modified === "string" ? fixed! : loaded.modified.model;
    const editor = monaco.editor.createDiffEditor(parent, {
      automaticLayout: true,
      originalEditable: false,
      readOnly: Boolean(fixed) || isReadOnlyPath(diff.path),
      renderSideBySide: true,
      theme: context.theme === "dark" ? "daedalus-dark" : "daedalus-light",
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 13,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
    });
    editor.setModel({ original, modified });
    // Open at the first change, as VS Code does, once the diff is computed.
    const firstDiff = editor.onDidUpdateDiff(() => {
      firstDiff.dispose();
      editor.revealFirstDiff();
    });
    const stopListening = listenForFocus(
      diffPanelId(diff.path, sha),
      editor.getModifiedEditor(),
    );
    return () => {
      firstDiff.dispose();
      stopListening();
      editor.dispose();
      original.dispose();
      fixed?.dispose();
    };
  }, [context.theme, context.workspaceId, diff, loaded]);

  if (!diff) return null;
  if (!loaded) return <div className="editor-loading">Opening changes…</div>;
  if ("message" in loaded)
    return <div className="editor-loading">{loaded.message}</div>;
  return <div className="monaco-panel" ref={container} />;
}

function MarkdownPanel({
  doc,
  heading,
  onHeadingShown,
}: {
  doc: OpenDocument;
  heading?: string;
  onHeadingShown(): void;
}) {
  useDocumentsRevision();
  const context = useEditorContext();
  const root = useRef<HTMLDivElement>(null);
  const [journal, setJournal] = useState<{
    kind: string;
    summary: string;
  }>({ kind: "progress", summary: "" });

  useEffect(() => {
    if (!heading) return;
    const frame = requestAnimationFrame(() => {
      const target = [
        ...(root.current?.querySelectorAll<HTMLElement>("h2, h3") ?? []),
      ].find((element) => element.textContent?.trim() === heading);
      target?.classList.add("journal-target");
      target?.scrollIntoView({ block: "start" });
      onHeadingShown();
    });
    return () => cancelAnimationFrame(frame);
  }, [heading, onHeadingShown]);

  return (
    <div className="markdown-panel">
      <div className="workspace-viewer-content markdown" ref={root}>
        <MarkdownPreview source={doc.model.getValue()} />
      </div>
      {doc.path === "JOURNAL.md" && !isDirty(doc) && (
        <form
          className="journal-entry-form"
          onSubmit={(event) => {
            event.preventDefault();
            void context.client.request
              .workspaceJournalAppend({
                workspace: context.workspaceId,
                kind: journal.kind as
                  | "decision"
                  | "progress"
                  | "blocker"
                  | "question"
                  | "handoff"
                  | "completed",
                summary: journal.summary,
              })
              .then((response) => {
                if (!response.ok) {
                  context.onError(response.error.message);
                  return;
                }
                const file: WorkspaceFileDto = {
                  ...doc.file,
                  content: response.data.journal,
                };
                reloadDocument(doc, file);
                setJournal({ kind: "progress", summary: "" });
                context.onWorkspaceDocumentSaved();
              });
          }}
        >
          <select
            aria-label="Journal entry type"
            onChange={(event) =>
              setJournal({ ...journal, kind: event.target.value })
            }
            value={journal.kind}
          >
            {[
              "decision",
              "progress",
              "blocker",
              "question",
              "handoff",
              "completed",
            ].map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <input
            aria-label="Journal entry"
            onChange={(event) =>
              setJournal({ ...journal, summary: event.target.value })
            }
            placeholder="Record a meaningful update…"
            required
            value={journal.summary}
          />
          <button type="submit">Add</button>
        </form>
      )}
    </div>
  );
}

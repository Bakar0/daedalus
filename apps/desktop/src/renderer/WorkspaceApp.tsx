import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { basicSetup, EditorView } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentSessionDto,
  DesktopCommand,
  DesktopSnapshotDto,
  IntegratedTerminalDto,
  ProviderModelCatalogDto,
  SessionTelemetryDto,
  SessionWorktreeDto,
  RepositoryDiscoveryDto,
  RpcResult,
  TaskDto,
  TaskStatus,
  WorkspaceContentDto,
  WorkspaceFileDto,
  WorkspaceFileEntryDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { repositoryFuzzyScore } from "./repository-search";

const STATUSES: TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

export const PANEL_RAIL_WIDTH = 68;
export const TERMINAL_PANEL_MIN_HEIGHT = 120;
export const TERMINAL_FONT_SIZE = 13;
const PANEL_COMPACT_THRESHOLD = 132;
const PANEL_STEP = 24;

export const clampPanelSize = (size: number, maximum: number) =>
  Math.min(Math.max(PANEL_RAIL_WIDTH, Math.round(size)), maximum);

const storedPanelSize = (key: string, fallback: number) => {
  if (typeof window === "undefined") return fallback;
  const stored = Number(window.localStorage.getItem(key));
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
};

const lastSessionStorageKey = (workspaceId: string) =>
  `daedalus.session.last.${workspaceId}`;

export function preferredSessionId(
  sessions: AgentSessionDto[],
  currentId?: string,
  rememberedId?: string | null,
): string | undefined {
  if (currentId && sessions.some((session) => session.id === currentId))
    return currentId;
  if (rememberedId && sessions.some((session) => session.id === rememberedId))
    return rememberedId;
  return sessions[0]?.id;
}

export function agentMultilineSequence(
  event: Pick<
    KeyboardEvent,
    "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey" | "type"
  >,
  target: "agent" | "integrated",
): string | undefined {
  return target === "agent" &&
    event.type === "keydown" &&
    (event.key === "Enter" ||
      event.code === "Enter" ||
      event.code === "NumpadEnter") &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
    ? "\n"
    : undefined;
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export interface SessionLaunchState {
  key: string;
  sessionId?: string;
  workspaceId: string;
  taskId?: string;
  name: string;
  tool: "codex" | "claude" | "terminal";
  startedAt: string;
  status: "starting" | "error";
  error?: string;
}

export function launchMatchesSession(
  launch: SessionLaunchState,
  session: AgentSessionDto,
): boolean {
  if (launch.status !== "starting") return false;
  if (launch.workspaceId !== session.workspaceId) return false;
  if (launch.tool !== sessionTool(session)) return false;
  if ((launch.taskId ?? null) !== session.taskId) return false;
  if (launch.name.trim() && launch.name.trim() !== sessionName(session))
    return false;
  const elapsed = Date.parse(session.startedAt) - Date.parse(launch.startedAt);
  return Number.isFinite(elapsed) && elapsed >= -2_000 && elapsed <= 120_000;
}

const repositoryRemoteIdentity = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, "github.com/")
    .replace(/^https?:\/\/(www\.)?github\.com\//, "github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

const looksLikeRepositorySource = (value: string) => {
  const source = value.trim();
  return (
    source.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(source) ||
    source.startsWith("git@") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(source)
  );
};

const sessionName = (session: AgentSessionDto) =>
  session.name ||
  (session.kind === "terminal"
    ? "Terminal"
    : session.provider.slice(0, 1).toUpperCase() + session.provider.slice(1));

const terminalPathHint = (path: string, home?: string) => {
  if (home && path === home) return "Daedalus home";
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
};

const elapsedLabel = (
  startedAt: string,
  endedAt: string | null,
  now: number,
) => {
  const elapsed = Math.max(
    0,
    (endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt),
  );
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
};

const providerLabel = (provider: string) =>
  provider.slice(0, 1).toUpperCase() + provider.slice(1);

const compactTokenLabel = (tokens: number) =>
  tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);

const sessionConfiguredModel = (session?: AgentSessionDto) => {
  if (!session) return undefined;
  for (let index = session.args.length - 1; index >= 0; index -= 1) {
    const argument = session.args[index]!;
    if (argument.startsWith("--model=")) return argument.slice(8);
    if (argument === "--model") return session.args[index + 1];
  }
  return undefined;
};

const workspaceParentPath = (path: string) => {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
};

const sessionTool = (
  session: AgentSessionDto,
): "codex" | "claude" | "terminal" =>
  session.kind === "terminal" || session.provider === "custom"
    ? "terminal"
    : session.provider;

// Codex and Claude paths are bundled from @lobehub/icons-static-svg (MIT).
function ToolIcon({ tool }: { tool: "codex" | "claude" | "terminal" }) {
  if (tool === "codex")
    return (
      <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
        <path
          clipRule="evenodd"
          d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
          fillRule="evenodd"
        />
      </svg>
    );
  if (tool === "claude")
    return (
      <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
        <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
      </svg>
    );
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <rect height="18" rx="2.5" width="20" x="2" y="3" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}

function CreateButton({
  disabled,
  label,
  onClick,
}: {
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="create-button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <svg
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
        viewBox="0 0 16 16"
      >
        <path d="M8 3v10M3 8h10" />
      </svg>
      <span>New</span>
    </button>
  );
}

function PanelCollapseButton({
  collapsed,
  label,
  onClick,
  side,
}: {
  collapsed: boolean;
  label: string;
  onClick: () => void;
  side: "left" | "right";
}) {
  const direction = collapsed
    ? side === "left"
      ? "›"
      : "‹"
    : side === "left"
      ? "‹"
      : "›";
  const action = collapsed ? "Expand" : "Collapse";
  return (
    <button
      aria-label={`${action} ${label} panel`}
      className="quiet panel-collapse-button"
      onClick={onClick}
      title={`${action} ${label}`}
      type="button"
    >
      {direction}
    </button>
  );
}

function SessionLaunchIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 18 18"
    >
      <rect height="13" rx="2" width="16" x="1" y="2.5" />
      <path d="m5 7 2 2-2 2M9.5 11h3" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg
      aria-hidden="true"
      className="archive-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <rect height="5" rx="1.5" width="20" x="2" y="3" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.3V9.55h.1A1.7 1.7 0 0 0 4.1 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 3.7l.06.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.3h4.05v.1A1.7 1.7 0 0 0 15 4.1a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.5a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4.05h-.1A1.7 1.7 0 0 0 19.4 15Z" />
    </svg>
  );
}

// VS Code Codicons repo-pull glyph (MIT).
function RepositoryPullIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 16 16">
      <path d="M4.85 6.15A.49.49 0 0 0 4.5 6a.49.49 0 0 0-.35.15.49.49 0 0 0-.15.35c0 .127.05.255.15.35l3 3c.095.1.222.15.35.15a.49.49 0 0 0 .35-.15l3-3a.49.49 0 0 0 .15-.35.49.49 0 0 0-.15-.35.49.49 0 0 0-.35-.15.49.49 0 0 0-.35.15L8 8.29V1.5a.5.5 0 0 0-1 0v6.79L4.85 6.15Z" />
      <path
        clipRule="evenodd"
        d="M9.95 13h2.55a.5.5 0 0 1 0 1H9.95A2.5 2.5 0 0 1 5.05 14H2.5a.5.5 0 0 1 0-1h2.55a2.5 2.5 0 0 1 4.9 0ZM6.09 14A1.5 1.5 0 0 0 9 13.5 1.5 1.5 0 0 0 6 13.5c0 .18.03.34.09.5Z"
        fillRule="evenodd"
      />
    </svg>
  );
}

function repositoryStatusText(
  status: WorkspaceContentDto["repositories"][number]["gitStatus"],
) {
  if (!status || status.state === "unavailable") return "Status unavailable";
  if (status.state === "modified")
    return `${status.changedFiles} ${status.changedFiles === 1 ? "change" : "changes"}`;
  if (status.state === "diverged") return `↑${status.ahead} ↓${status.behind}`;
  if (status.state === "ahead") return `↑${status.ahead} ahead`;
  if (status.state === "behind") return `↓${status.behind} behind`;
  return "Clean";
}

const sessionIsLive = (session: AgentSessionDto) =>
  session.status === "running" || session.status === "starting";

// Lost sessions are today's attention signal. This predicate is the extension
// point for richer provider/developer attention states later.
const sessionNeedsAttention = (session: AgentSessionDto) =>
  session.status === "lost";

const taskExcerpt = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?```/g, "Code example")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+] |\d+\. )\s*/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function MarkdownPreview({ source }: { source: string }) {
  if (!source.trim())
    return (
      <div className="brief-placeholder">
        <strong>No task brief yet</strong>
        <span>Add goals, context, and acceptance criteria for the agent.</span>
      </div>
    );
  return (
    <div className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
    </div>
  );
}

function WorkspaceFileEditor({
  file,
  onChange,
  onSave,
  readOnly,
  theme,
}: {
  file: WorkspaceFileDto;
  onChange: (value: string) => void;
  onSave: () => void;
  readOnly: boolean;
  theme: "dark" | "light";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | undefined>(undefined);
  const changeRef = useRef(onChange);
  const saveRef = useRef(onSave);
  changeRef.current = onChange;
  saveRef.current = onSave;

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const editor = new EditorView({
      doc: file.content,
      parent,
      extensions: [
        basicSetup,
        EditorView.editable.of(!readOnly),
        EditorView.lineWrapping,
        ...(file.format === "markdown" ? [markdown()] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changeRef.current(update.state.doc.toString());
        }),
        EditorView.theme(
          {
            "&": {
              backgroundColor: "transparent",
              color: theme === "dark" ? "#dce5f5" : "#1d2738",
              height: "100%",
            },
            ".cm-content": {
              caretColor: theme === "dark" ? "#9fc5ff" : "#2563a9",
              fontFamily: '"SFMono-Regular", Menlo, monospace',
              fontSize: "12px",
              lineHeight: "1.6",
              padding: "12px 0 28px",
            },
            ".cm-cursor, .cm-dropCursor": {
              borderLeftColor: theme === "dark" ? "#9fc5ff" : "#2563a9",
            },
            ".cm-gutters": {
              backgroundColor: "transparent",
              border: "none",
              color: theme === "dark" ? "#56657d" : "#8b98aa",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: theme === "dark" ? "#ffffff08" : "#315d9510",
            },
            ".cm-scroller": { overflow: "auto" },
            "&.cm-focused": { outline: "none" },
          },
          { dark: theme === "dark" },
        ),
      ],
    });
    editorRef.current = editor;
    editor.focus();
    return () => {
      editorRef.current = undefined;
      editor.destroy();
    };
  }, [file.format, file.path, readOnly, theme]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.state.doc.toString() === file.content) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: file.content },
    });
  }, [file.content]);

  return (
    <div
      className="workspace-code-editor"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          saveRef.current();
        }
      }}
      ref={containerRef}
    />
  );
}

function Modal({
  title,
  onClose,
  wide = false,
  dismissible = true,
  children,
}: {
  children: React.ReactNode;
  dismissible?: boolean;
  onClose: () => void;
  title: string;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-label={title}
        aria-modal="true"
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
      >
        <div className="detail-title">
          <div>
            <span className="eyebrow">Daedalus</span>
            <h2>{title}</h2>
          </div>
          <button className="quiet" disabled={!dismissible} onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function TerminalSurface({
  focused,
  fitRevision,
  id,
  label,
  locationLabel,
  onOpenLink,
  status,
  session,
  telemetry,
  target,
  worktree,
}: {
  focused: boolean;
  fitRevision: number;
  id: string;
  label: string;
  locationLabel?: string;
  onOpenLink: (url: string) => void;
  status: AgentSessionDto["status"];
  session?: AgentSessionDto;
  telemetry?: SessionTelemetryDto;
  target: "agent" | "integrated";
  worktree?: SessionWorktreeDto;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => undefined);
  const focusRef = useRef<() => void>(() => undefined);
  const inputRef = useRef<(data: string) => void>(() => undefined);
  const [connection, setConnection] = useState("connecting");
  const [now, setNow] = useState(Date.now());
  const connectionIssue = ["connected", "reconnected"].includes(connection)
    ? undefined
    : connection;
  useEffect(() => {
    if (!session || session.endedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [session]);
  const captureAgentShortcut = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const sequence = agentMultilineSequence(event.nativeEvent, target);
    if (!sequence) return;
    event.preventDefault();
    event.stopPropagation();
    inputRef.current(sequence);
  };
  useEffect(() => {
    fitRef.current();
    if (focused) requestAnimationFrame(() => focusRef.current());
  }, [fitRevision, focused]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (status !== "running" && status !== "starting") {
      setConnection(status);
      return;
    }
    let disposed = false;
    let terminal: Terminal | undefined;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempts = 0;
    let ended = false;
    let frame: number | undefined;
    let layoutFrame: number | undefined;
    let layoutTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let windowResizeListener: (() => void) | undefined;
    let lastSentSize: string | undefined;
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const drain = () => {
      frame = undefined;
      const chunks = pending.splice(0);
      pendingBytes = 0;
      for (const chunk of chunks) terminal?.write(chunk);
    };
    const enqueue = (chunk: Uint8Array) => {
      if (chunk.byteLength >= 1024 * 1024) {
        pending.length = 0;
        pending.push(chunk.slice(chunk.byteLength - 1024 * 1024));
        pendingBytes = 1024 * 1024;
      } else {
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        while (pendingBytes > 1024 * 1024 && pending.length > 1) {
          const dropped = pending.shift();
          if (dropped) pendingBytes -= dropped.byteLength;
        }
      }
      if (frame === undefined) frame = requestAnimationFrame(drain);
    };

    void (async () => {
      if (disposed) return;
      terminal = new Terminal({
        cursorBlink: true,
        // Keep ordinary drag selection available while tmux owns mouse mode.
        // Holding Alt passes clicks and drags through to the terminal app;
        // wheel events continue to use tmux's native scrolling behavior.
        mouseEventsRequireAlt: true,
        // Shell prompts commonly use Nerd Font private-use glyphs. Prefer the
        // user's installed Nerd Font while retaining native monospace fallbacks.
        fontFamily: '"MesloLGS NF", "SF Mono", Menlo, monospace',
        fontSize: TERMINAL_FONT_SIZE,
        fastScrollSensitivity: 5,
        scrollback: 10_000,
        scrollSensitivity: 2.5,
        smoothScrollDuration: 90,
        theme: {
          background: "#11151d",
          foreground: "#dce5f2",
          cursor: "#8ed6c3",
          selectionBackground: "#38546b",
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(
        new WebLinksAddon((event, url) => {
          event.preventDefault();
          onOpenLink(url);
        }),
      );
      terminal.open(container);
      focusRef.current = () => terminal?.focus();
      inputRef.current = (data) => {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: "input", data }));
      };
      if (focused) requestAnimationFrame(() => terminal?.focus());
      const sendSize = () => {
        const cols = terminal?.cols ?? 0;
        const rows = terminal?.rows ?? 0;
        const size = `${cols}x${rows}`;
        if (
          cols >= 20 &&
          rows >= 5 &&
          size !== lastSentSize &&
          socket?.readyState === WebSocket.OPEN
        ) {
          socket.send(
            JSON.stringify({
              type: "resize",
              cols,
              rows,
            }),
          );
          lastSentSize = size;
        }
      };
      const fitAndSync = () => {
        layoutFrame = undefined;
        const currentTerminal = terminal;
        if (disposed || !currentTerminal) return;
        const dimensions = fitAddon.proposeDimensions();
        // tmux clamps clients to 20x5. Fitting xterm.js below that while a tab
        // is hidden or the window is minimized puts the two terminal grids out
        // of sync and leaves stale glyphs/cursors behind when it is restored.
        if (!dimensions || dimensions.cols < 20 || dimensions.rows < 5) return;
        if (
          currentTerminal.cols !== dimensions.cols ||
          currentTerminal.rows !== dimensions.rows
        ) {
          // FitAddon clears xterm's render service before resizing. That clear
          // is important in WKWebView, where the old canvas can otherwise stay
          // visible until this terminal is unmounted and selected again.
          fitAddon.fit();
        }
        currentTerminal.refresh(0, currentTerminal.rows - 1);
        container.dataset.terminalCols = String(currentTerminal.cols);
        container.dataset.terminalRows = String(currentTerminal.rows);
        sendSize();
      };
      const scheduleFit = () => {
        if (layoutFrame === undefined)
          layoutFrame = requestAnimationFrame(fitAndSync);
      };
      const scheduleSettledFit = () => {
        scheduleFit();
        if (layoutTimer) clearTimeout(layoutTimer);
        layoutTimer = setTimeout(scheduleFit, 180);
      };
      fitRef.current = scheduleSettledFit;
      windowResizeListener = scheduleSettledFit;
      resizeObserver = new ResizeObserver(scheduleSettledFit);
      resizeObserver.observe(container);
      window.addEventListener("resize", scheduleSettledFit);
      window.visualViewport?.addEventListener("resize", scheduleSettledFit);
      scheduleSettledFit();
      const endpoint = new URLSearchParams(window.location.search).get(
        "terminal",
      );
      if (!endpoint) {
        setConnection("available in Electrobun");
        return;
      }
      const connect = () => {
        if (disposed || ended) return;
        fitAndSync();
        const url = new URL(endpoint);
        url.searchParams.set(target, id);
        if ((terminal?.cols ?? 0) >= 20 && (terminal?.rows ?? 0) >= 5) {
          url.searchParams.set("cols", String(terminal?.cols));
          url.searchParams.set("rows", String(terminal?.rows));
        }
        socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          reconnectAttempts = 0;
          lastSentSize = undefined;
          setConnection("connected");
          scheduleSettledFit();
        };
        socket.onclose = () => {
          if (disposed || ended) return;
          setConnection("reconnecting");
          reconnectTimer = setTimeout(
            connect,
            Math.min(4_000, 250 * 2 ** reconnectAttempts++),
          );
        };
        socket.onerror = () => setConnection("connection error");
        socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            enqueue(new Uint8Array(event.data));
            return;
          }
          const value = JSON.parse(String(event.data)) as {
            type: string;
            status?: string;
            message?: string;
            droppedBytes?: number;
          };
          if (value.type === "status" && value.status) {
            setConnection(value.status);
            if (value.status === "exited" || value.status === "lost")
              ended = true;
          }
          if (value.type === "overflow" && value.droppedBytes)
            terminal?.writeln(
              `\r\n\u001b[33m[Daedalus skipped ${value.droppedBytes.toLocaleString()} buffered bytes]\u001b[0m`,
            );
          if (value.type === "error" && value.message) {
            ended = true;
            setConnection("unavailable");
            terminal?.writeln(`\r\n\u001b[31m${value.message}\u001b[0m`);
          }
        };
      };
      terminal.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: "input", data }));
      });
      terminal.onResize(sendSize);
      connect();
    })();
    return () => {
      disposed = true;
      fitRef.current = () => undefined;
      focusRef.current = () => undefined;
      inputRef.current = () => undefined;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
      if (layoutTimer) clearTimeout(layoutTimer);
      resizeObserver?.disconnect();
      if (windowResizeListener) {
        window.removeEventListener("resize", windowResizeListener);
        window.visualViewport?.removeEventListener(
          "resize",
          windowResizeListener,
        );
      }
      socket?.close();
      terminal?.dispose();
    };
  }, [id, status, target]);

  return (
    <section className="agent-terminal-shell">
      {target === "integrated" && (
        <div className="terminal-status">
          <span className={`agent-dot ${status}`} />
          <span>{label}</span>
          <small>
            {connection} · {id.slice(0, 8)}
          </small>
        </div>
      )}
      <div
        aria-label={`Terminal for ${label} ${id.slice(0, 8)}`}
        className="terminal"
        onKeyDownCapture={captureAgentShortcut}
        ref={containerRef}
      />
      {target === "agent" && session && (
        <div className="agent-session-status" aria-label="Session status">
          <div className="agent-session-status-primary">
            <span className={`agent-dot ${status}`} />
            <strong>{providerLabel(session.provider)}</strong>
            {telemetry?.model && (
              <span className="agent-session-status-model">
                {telemetry.model}
              </span>
            )}
            {locationLabel && (
              <span
                className="agent-session-status-path"
                title={session.workingDirectory}
              >
                {locationLabel}
              </span>
            )}
            {worktree?.branchName && (
              <span className="agent-session-status-branch">
                {worktree.branchName}
              </span>
            )}
            <span>{elapsedLabel(session.startedAt, session.endedAt, now)}</span>
            {connectionIssue && <small>{connectionIssue}</small>}
          </div>
          {telemetry?.context && (
            <div className="agent-session-context">
              <span>
                Context {compactTokenLabel(telemetry.context.usedTokens)}
                {telemetry.context.totalTokens
                  ? `/${compactTokenLabel(telemetry.context.totalTokens)}`
                  : ""}
              </span>
              {telemetry.context.usedPercent !== undefined && (
                <>
                  <span
                    className="agent-session-context-track"
                    aria-hidden="true"
                  >
                    <span
                      style={{
                        width: `${Math.min(100, Math.max(0, telemetry.context.usedPercent))}%`,
                      }}
                    />
                  </span>
                  <strong>{Math.round(telemetry.context.usedPercent)}%</strong>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function IntegratedTerminalSurface({
  active,
  fitRevision,
  mountRevision,
  onOpenLink,
  terminal,
}: {
  active: boolean;
  fitRevision: number;
  mountRevision: number;
  onOpenLink: (url: string) => void;
  terminal: IntegratedTerminalDto;
}) {
  const [activated, setActivated] = useState(active);

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  return (
    <div
      aria-hidden={!active}
      className={`integrated-terminal-surface ${active ? "active" : "hidden"}`}
    >
      {activated && (
        <TerminalSurface
          focused={active}
          fitRevision={fitRevision}
          id={terminal.id}
          key={`${terminal.id}:${mountRevision}`}
          label={terminal.name}
          onOpenLink={onOpenLink}
          status={terminal.status}
          target="integrated"
        />
      )}
    </div>
  );
}

export function WorkspaceApp({
  injectedClient,
  initialSnapshot,
  initialSelectedTaskId,
  initialActiveAgentId,
  initialActiveTerminalId,
  initialTerminalPanelOpen = false,
  initialWorkspaceView = "board",
  initialWorkspaceContent,
  initialModal,
  initialSessionLaunches = [],
}: {
  injectedClient?: DesktopClient;
  initialSnapshot?: DesktopSnapshotDto;
  initialSelectedTaskId?: string;
  initialActiveAgentId?: string;
  initialActiveTerminalId?: string;
  initialTerminalPanelOpen?: boolean;
  initialDetailView?: "brief" | "terminal";
  initialWorkspaceView?: "board" | "sessions" | "workspace";
  initialWorkspaceContent?: WorkspaceContentDto;
  initialModal?: "workspace" | "task" | "session" | "repository" | "settings";
  initialSessionLaunches?: SessionLaunchState[];
} = {}) {
  const clientRef = useRef(injectedClient);
  if (!clientRef.current)
    throw new Error("The desktop RPC client was not provided");
  const client = clientRef.current;
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [terminalFitRevision, setTerminalFitRevision] = useState(0);
  const [terminalMountRevision, setTerminalMountRevision] = useState(0);
  const terminalLayoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [workspaceId, setWorkspaceId] = useState(
    initialSnapshot?.workspaces.find((item) => !item.archivedAt)?.id,
  );
  const [selectedTaskId, setSelectedTaskId] = useState(initialSelectedTaskId);
  const [activeSessionId, setActiveSessionId] = useState(initialActiveAgentId);
  const [view, setView] = useState<"board" | "sessions" | "workspace">(
    initialWorkspaceView,
  );
  const [workspaceContent, setWorkspaceContent] = useState(
    initialWorkspaceContent,
  );
  const [workspaceDirectories, setWorkspaceDirectories] = useState<
    Record<string, WorkspaceFileEntryDto[]>
  >(() =>
    initialWorkspaceContent
      ? { "": initialWorkspaceContent.files }
      : ({} as Record<string, WorkspaceFileEntryDto[]>),
  );
  const [expandedWorkspaceDirectories, setExpandedWorkspaceDirectories] =
    useState<ReadonlySet<string>>(() => new Set());
  const [selectedWorkspaceFile, setSelectedWorkspaceFile] =
    useState<WorkspaceFileDto | null>(() =>
      initialWorkspaceContent
        ? {
            name: "BRIEF.md",
            path: "BRIEF.md",
            content: initialWorkspaceContent.brief,
            format: "markdown",
          }
        : null,
    );
  const [workspaceDraft, setWorkspaceDraft] = useState(
    initialWorkspaceContent?.brief ?? "",
  );
  const [workspaceFileMode, setWorkspaceFileMode] = useState<
    "edit" | "preview"
  >("edit");
  const [selectedWorkspaceDirectory, setSelectedWorkspaceDirectory] =
    useState("");
  const [newWorkspaceEntry, setNewWorkspaceEntry] = useState<{
    kind: "file" | "directory";
    name: string;
  }>();
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const [modal, setModal] = useState<
    "workspace" | "task" | "session" | "repository" | "settings" | undefined
  >(initialModal);
  const [editingTask, setEditingTask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [workspaceForm, setWorkspaceForm] = useState({
    name: "",
    slug: "",
    path: "",
  });
  const [taskForm, setTaskForm] = useState({ title: "", description: "" });
  const [sessionType, setSessionType] = useState("codex");
  const [sessionModel, setSessionModel] = useState("");
  const [modelCatalogs, setModelCatalogs] = useState<
    Partial<Record<"codex" | "claude", ProviderModelCatalogDto>>
  >({});
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string>();
  const [sessionForm, setSessionForm] = useState<{
    name: string;
    taskId?: string;
  }>({ name: "" });
  const [sessionLaunches, setSessionLaunches] = useState<SessionLaunchState[]>(
    initialSessionLaunches,
  );
  const [repositoryForm, setRepositoryForm] = useState<{
    remoteUrl: string;
    search: string;
  }>({ remoteUrl: "", search: "" });
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [selectedGitHubRepositories, setSelectedGitHubRepositories] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [repositoryDiscovery, setRepositoryDiscovery] =
    useState<RepositoryDiscoveryDto>();
  const [repositoryDiscoveryLoading, setRepositoryDiscoveryLoading] =
    useState(false);
  const [activeRepositoryResult, setActiveRepositoryResult] = useState(0);
  const [repositoryOperations, setRepositoryOperations] = useState<
    Array<{
      key: string;
      name: string;
      detail: string;
      status: "queued" | "cloning" | "attaching" | "done" | "error";
      error?: string;
    }>
  >([]);
  const [syncingRepositoryIds, setSyncingRepositoryIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [journalForm, setJournalForm] = useState<{
    kind:
      | "decision"
      | "progress"
      | "blocker"
      | "question"
      | "handoff"
      | "completed";
    summary: string;
  }>({
    kind: "progress",
    summary: "",
  });
  const [sessionAction, setSessionAction] = useState<{
    session: AgentSessionDto;
  }>();
  const [workspaceAction, setWorkspaceAction] = useState<WorkspaceDto>();
  const [archivingWorkspaceIds, setArchivingWorkspaceIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(
    initialTerminalPanelOpen,
  );
  const [terminalPanelHeight, setTerminalPanelHeight] = useState(() =>
    typeof window === "undefined" ? 300 : Math.round(window.innerHeight * 0.38),
  );
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(() =>
    storedPanelSize("daedalus.panel.workspace-width", 210),
  );
  const [boardDetailPanelWidth, setBoardDetailPanelWidth] = useState(() =>
    storedPanelSize("daedalus.panel.board-detail-width", 340),
  );
  const [sessionsPanelWidth, setSessionsPanelWidth] = useState(() =>
    storedPanelSize("daedalus.panel.sessions-width", 320),
  );
  const workspaceExpandedWidth = useRef(
    workspacePanelWidth >= PANEL_COMPACT_THRESHOLD ? workspacePanelWidth : 210,
  );
  const boardDetailExpandedWidth = useRef(
    boardDetailPanelWidth >= PANEL_COMPACT_THRESHOLD
      ? boardDetailPanelWidth
      : 340,
  );
  const sessionsExpandedWidth = useRef(
    sessionsPanelWidth >= PANEL_COMPACT_THRESHOLD ? sessionsPanelWidth : 320,
  );
  const [activeTerminalId, setActiveTerminalId] = useState(
    initialActiveTerminalId,
  );

  const terminalLayoutChanged = useCallback(() => {
    // Every layout mutation shares the same terminal repair path: update the
    // live grid immediately, then recreate only xterm after layout settles.
    setTerminalFitRevision((revision) => revision + 1);
    if (terminalLayoutTimer.current) clearTimeout(terminalLayoutTimer.current);
    terminalLayoutTimer.current = setTimeout(
      () => setTerminalMountRevision((revision) => revision + 1),
      120,
    );
  }, []);

  const openTerminalLink = useCallback(
    (url: string) => {
      void client.request.openExternal({ url }).then((response) => {
        if (!response.ok) setError(response.error.message);
        else if (!response.data.opened)
          setError("The link could not be opened in the default browser");
      });
    },
    [client],
  );

  const clampTerminalPanelHeight = useCallback(
    (height: number) =>
      Math.min(
        Math.max(TERMINAL_PANEL_MIN_HEIGHT, height),
        Math.max(TERMINAL_PANEL_MIN_HEIGHT, window.innerHeight - 280),
      ),
    [],
  );
  const startTerminalPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const panel = event.currentTarget.closest(".integrated-terminal-panel");
      const startHeight = panel?.getBoundingClientRect().height ?? 300;
      document.body.classList.add("resizing-terminal-panel");

      const move = (moveEvent: PointerEvent) => {
        setTerminalPanelHeight(
          clampTerminalPanelHeight(startHeight + startY - moveEvent.clientY),
        );
      };
      const stop = () => {
        document.body.classList.remove("resizing-terminal-panel");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [clampTerminalPanelHeight],
  );

  const startColumnResize = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      panel: "workspace" | "secondary",
    ) => {
      event.preventDefault();
      const shell = event.currentTarget.closest(".workspace-shell");
      if (!(shell instanceof HTMLElement)) return;
      const startX = event.clientX;
      const workspaceWidth =
        shell.querySelector<HTMLElement>(".workspace-column")?.offsetWidth ??
        workspacePanelWidth;
      const secondaryElement =
        view === "board"
          ? shell.querySelector<HTMLElement>(".board-detail-column")
          : shell.querySelector<HTMLElement>(".session-navigator");
      const secondaryWidth =
        secondaryElement?.offsetWidth ??
        (view === "board" ? boardDetailPanelWidth : sessionsPanelWidth);
      const mainMinimum = 320;
      const handlesWidth = view === "workspace" ? 6 : 12;
      const workspaceMaximum = Math.max(
        PANEL_RAIL_WIDTH,
        shell.clientWidth -
          (view === "workspace" ? 0 : secondaryWidth) -
          mainMinimum -
          handlesWidth,
      );
      const secondaryMaximum = Math.max(
        PANEL_RAIL_WIDTH,
        shell.clientWidth - workspaceWidth - mainMinimum - handlesWidth,
      );

      const handle = event.currentTarget;
      handle.classList.add("dragging");
      document.body.classList.add("resizing-column-panel");
      const move = (moveEvent: PointerEvent) => {
        const movement = moveEvent.clientX - startX;
        if (panel === "workspace")
          setWorkspacePanelWidth(
            clampPanelSize(workspaceWidth + movement, workspaceMaximum),
          );
        else if (view === "board")
          setBoardDetailPanelWidth(
            clampPanelSize(secondaryWidth - movement, secondaryMaximum),
          );
        else
          setSessionsPanelWidth(
            clampPanelSize(secondaryWidth + movement, secondaryMaximum),
          );
      };
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
    },
    [boardDetailPanelWidth, sessionsPanelWidth, view, workspacePanelWidth],
  );

  const toggleWorkspacePanel = useCallback(() => {
    setWorkspacePanelWidth((width) => {
      if (width < PANEL_COMPACT_THRESHOLD)
        return workspaceExpandedWidth.current;
      workspaceExpandedWidth.current = width;
      return PANEL_RAIL_WIDTH;
    });
  }, []);
  const toggleBoardDetailPanel = useCallback(() => {
    setBoardDetailPanelWidth((width) => {
      if (width < PANEL_COMPACT_THRESHOLD)
        return boardDetailExpandedWidth.current;
      boardDetailExpandedWidth.current = width;
      return PANEL_RAIL_WIDTH;
    });
  }, []);
  const toggleSessionsPanel = useCallback(() => {
    setSessionsPanelWidth((width) => {
      if (width < PANEL_COMPACT_THRESHOLD) return sessionsExpandedWidth.current;
      sessionsExpandedWidth.current = width;
      return PANEL_RAIL_WIDTH;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await client.request.snapshot({});
      if (!response.ok) throw new Error(response.error.message);
      setSnapshot(response.data);
      setError(undefined);
      setWorkspaceId((current) =>
        response.data.workspaces.some(
          (item) => item.id === current && !item.archivedAt,
        )
          ? current
          : response.data.workspaces.find((item) => !item.archivedAt)?.id,
      );
      setSelectedTaskId((current) =>
        response.data.tasks.some((item) => item.id === current)
          ? current
          : undefined,
      );
      setActiveSessionId((current) =>
        response.data.agents.some((item) => item.id === current)
          ? current
          : undefined,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    return client.subscribe(() => void refresh());
  }, [client, refresh]);
  const runDesktopCommand = useCallback(
    (command: DesktopCommand) => {
      if (command === "view-board") setView("board");
      else if (command === "view-sessions" && workspaceId) setView("sessions");
      else if (command === "view-workspace" && workspaceId)
        setView("workspace");
      else if (command === "toggle-terminal")
        setTerminalPanelOpen((current) => !current);
    },
    [workspaceId],
  );
  useEffect(
    () => client.subscribeCommands(runDesktopCommand),
    [client, runDesktopCommand],
  );
  useEffect(() => {
    const unsubscribe = client.subscribeWindowResize(terminalLayoutChanged);
    window.addEventListener("resize", terminalLayoutChanged);
    return () => {
      unsubscribe();
      window.removeEventListener("resize", terminalLayoutChanged);
      if (terminalLayoutTimer.current)
        clearTimeout(terminalLayoutTimer.current);
    };
  }, [client, terminalLayoutChanged]);
  useEffect(() => {
    terminalLayoutChanged();
  }, [
    boardDetailPanelWidth,
    sessionsPanelWidth,
    terminalLayoutChanged,
    terminalPanelHeight,
    terminalPanelOpen,
    workspacePanelWidth,
  ]);
  useEffect(() => {
    if (view !== "workspace" || !workspaceId) return;
    let cancelled = false;
    void client.request
      .workspaceContentGet({ workspace: workspaceId })
      .then((response) => {
        if (cancelled) return;
        if (response.ok) {
          setWorkspaceContent(response.data);
          setWorkspaceDirectories({ "": response.data.files });
          setExpandedWorkspaceDirectories(new Set());
          setSelectedWorkspaceFile({
            name: "BRIEF.md",
            path: "BRIEF.md",
            content: response.data.brief,
            format: "markdown",
          });
          setWorkspaceDraft(response.data.brief);
          setWorkspaceFileMode("edit");
          setSelectedWorkspaceDirectory("");
          setNewWorkspaceEntry(undefined);
          setError(undefined);
        } else setError(response.error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [client, view, workspaceId]);
  useEffect(() => {
    const stored = window.localStorage.getItem("daedalus.theme");
    if (stored === "dark" || stored === "light") setTheme(stored);
  }, []);
  useEffect(() => {
    if (workspacePanelWidth >= PANEL_COMPACT_THRESHOLD)
      workspaceExpandedWidth.current = workspacePanelWidth;
    window.localStorage.setItem(
      "daedalus.panel.workspace-width",
      String(workspacePanelWidth),
    );
  }, [workspacePanelWidth]);
  useEffect(() => {
    if (boardDetailPanelWidth >= PANEL_COMPACT_THRESHOLD)
      boardDetailExpandedWidth.current = boardDetailPanelWidth;
    window.localStorage.setItem(
      "daedalus.panel.board-detail-width",
      String(boardDetailPanelWidth),
    );
  }, [boardDetailPanelWidth]);
  useEffect(() => {
    if (sessionsPanelWidth >= PANEL_COMPACT_THRESHOLD)
      sessionsExpandedWidth.current = sessionsPanelWidth;
    window.localStorage.setItem(
      "daedalus.panel.sessions-width",
      String(sessionsPanelWidth),
    );
  }, [sessionsPanelWidth]);
  useEffect(() => {
    if (!snapshot || sessionType === "terminal") return;
    const selected = snapshot.settings.providers.find(
      (item) => item.name === sessionType,
    );
    if (!selected?.available) {
      const available = snapshot.settings.providers.find(
        (item) => item.available,
      );
      setSessionType(available?.name ?? "terminal");
    }
  }, [sessionType, snapshot]);
  useEffect(() => {
    if (
      (sessionType !== "codex" && sessionType !== "claude") ||
      modelCatalogs[sessionType]
    )
      return;
    let cancelled = false;
    setModelCatalogLoading(true);
    setModelCatalogError(undefined);
    void client.request
      .agentModels({ provider: sessionType })
      .then((response) => {
        if (cancelled) return;
        if (response.ok)
          setModelCatalogs((current) => ({
            ...current,
            [sessionType]: response.data,
          }));
        else setModelCatalogError(response.error.message);
      })
      .catch((cause) => {
        if (!cancelled) setModelCatalogError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setModelCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, modelCatalogs, sessionType]);

  async function perform<T>(operation: Promise<RpcResult<T>>) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await operation;
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      await refresh();
      return response.data;
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const activeWorkspaces = (snapshot?.workspaces ?? []).filter(
    (item) => !item.archivedAt && !archivingWorkspaceIds.has(item.id),
  );
  const archivedWorkspaces = (snapshot?.workspaces ?? []).filter(
    (item) => item.archivedAt,
  );
  const workspace = activeWorkspaces.find((item) => item.id === workspaceId);
  const allTasks = (snapshot?.tasks ?? []).filter(
    (item) => item.workspaceId === workspaceId,
  );
  const tasks = allTasks.filter(
    (item) => filter === "all" || item.status === filter,
  );
  const workspaceSessions = (snapshot?.agents ?? [])
    .filter((item) => item.workspaceId === workspaceId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const sessions = workspaceSessions.filter((item) => !item.archivedAt);
  const workspaceSessionLaunches = sessionLaunches.filter(
    (item) => item.workspaceId === workspaceId,
  );
  const pendingSessionLaunches = workspaceSessionLaunches.filter(
    (launch) =>
      !sessions.some(
        (session) =>
          session.id === launch.sessionId ||
          launchMatchesSession(launch, session),
      ),
  );
  const sessionStartupErrors = new Map(
    workspaceSessionLaunches.flatMap((launch) =>
      launch.sessionId && launch.error
        ? [[launch.sessionId, launch.error] as const]
        : [],
    ),
  );
  const archivedSessions = workspaceSessions.filter((item) => item.archivedAt);
  const selectedTask = snapshot?.tasks.find(
    (item) => item.id === selectedTaskId,
  );
  const activeSession = sessions.find((item) => item.id === activeSessionId);
  const activeSessionTelemetry = snapshot?.sessionTelemetry.find(
    (item) => item.sessionId === activeSession?.id,
  );
  const activeSessionWorktree = workspaceContent?.worktrees.find(
    (item) => item.sessionId === activeSession?.id,
  );
  const activeSessionRepository = workspaceContent?.repositories.find(
    (item) => item.id === activeSessionWorktree?.repositoryId,
  );
  const activeSessionModel =
    activeSessionTelemetry?.model ?? sessionConfiguredModel(activeSession);
  const sessionModelCatalog =
    sessionType === "codex" || sessionType === "claude"
      ? modelCatalogs[sessionType]
      : undefined;
  const sessionDefaultModel = sessionModelCatalog?.models.find(
    (model) => model.id === sessionModelCatalog.defaultModel,
  );
  const selectedSessionModel = sessionModelCatalog?.models.find(
    (model) => model.id === sessionModel,
  );
  const sessionModelCatalogPending =
    sessionType !== "terminal" && !sessionModelCatalog && !modelCatalogError;
  const integratedTerminals = snapshot?.terminals ?? [];
  const activeIntegratedTerminal =
    integratedTerminals.find((item) => item.id === activeTerminalId) ??
    integratedTerminals.at(-1);

  useEffect(() => {
    if (view !== "sessions" || !workspaceId) return;
    const remembered = window.localStorage.getItem(
      lastSessionStorageKey(workspaceId),
    );
    const preferred = preferredSessionId(sessions, activeSessionId, remembered);
    if (preferred !== activeSessionId) setActiveSessionId(preferred);
  }, [activeSessionId, sessions, view, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !activeSessionId) return;
    if (!sessions.some((session) => session.id === activeSessionId)) return;
    window.localStorage.setItem(
      lastSessionStorageKey(workspaceId),
      activeSessionId,
    );
  }, [activeSessionId, sessions, workspaceId]);
  const attachedLibraryRepositoryIds = new Set(
    (workspaceContent?.repositories ?? [])
      .map((item) => item.libraryRepositoryId)
      .filter((item): item is string => Boolean(item)),
  );
  const repositorySearch = repositoryForm.search.trim();
  const libraryRemoteIdentities = new Set(
    (snapshot?.repositories ?? []).map((item) =>
      repositoryRemoteIdentity(item.remoteUrl),
    ),
  );
  const repositoryCandidates = [
    ...(snapshot?.repositories ?? []).flatMap((repository, order) => {
      const score = repositoryFuzzyScore(
        repositorySearch,
        repository.name,
        repository.remoteUrl,
      );
      return score === undefined
        ? []
        : [{ kind: "library" as const, repository, score, order }];
    }),
    ...(repositoryDiscovery?.repositories ?? []).flatMap(
      (repository, order) => {
        if (
          libraryRemoteIdentities.has(
            repositoryRemoteIdentity(repository.remoteUrl),
          )
        )
          return [];
        const score = repositoryFuzzyScore(
          repositorySearch,
          repository.name,
          `${repository.nameWithOwner} ${repository.remoteUrl}`,
        );
        return score === undefined
          ? []
          : [{ kind: "github" as const, repository, score, order }];
      },
    ),
  ].sort((left, right) => {
    if (repositorySearch) {
      const scoreDifference = right.score - left.score;
      if (scoreDifference) return scoreDifference;
    }
    if (left.kind !== right.kind) return left.kind === "library" ? -1 : 1;
    return left.order - right.order;
  });
  const workspaceSelectionReadOnly =
    selectedWorkspaceDirectory === "repos" ||
    selectedWorkspaceDirectory.startsWith("repos/");
  const selectedWorkspaceFileReadOnly =
    selectedWorkspaceFile?.path.startsWith("repos/") ?? false;
  const selectedRepositoryCount =
    [...selectedRepositoryIds].filter(
      (id) => !attachedLibraryRepositoryIds.has(id),
    ).length + selectedGitHubRepositories.size;
  const completedRepositoryOperations = repositoryOperations.filter(
    (operation) => operation.status === "done",
  ).length;
  const failedRepositoryOperations = repositoryOperations.filter(
    (operation) => operation.status === "error",
  ).length;
  const repositoryOperationFinished =
    repositoryOperations.length > 0 &&
    repositoryOperations.every(
      (operation) =>
        operation.status === "done" || operation.status === "error",
    );
  const activeRepositoryOperation = repositoryOperations.find(
    (operation) =>
      operation.status === "cloning" || operation.status === "attaching",
  );

  useEffect(() => {
    setActiveRepositoryResult(0);
  }, [repositorySearch, repositoryDiscoveryLoading]);

  function toggleRepositoryCandidate(index: number) {
    const candidate = repositoryCandidates[index];
    if (!candidate) return;
    if (candidate.kind === "library") {
      if (attachedLibraryRepositoryIds.has(candidate.repository.id)) return;
      setSelectedRepositoryIds((current) => {
        const next = new Set(current);
        if (next.has(candidate.repository.id))
          next.delete(candidate.repository.id);
        else next.add(candidate.repository.id);
        return next;
      });
      return;
    }
    setSelectedGitHubRepositories((current) => {
      const next = new Set(current);
      if (next.has(candidate.repository.nameWithOwner))
        next.delete(candidate.repository.nameWithOwner);
      else next.add(candidate.repository.nameWithOwner);
      return next;
    });
  }

  async function loadRepositoryDiscovery() {
    setRepositoryDiscoveryLoading(true);
    try {
      const response = await client.request.repositoryDiscovery({});
      if (response.ok) setRepositoryDiscovery(response.data);
      else
        setRepositoryDiscovery({
          githubCliAvailable: true,
          authenticated: false,
          repositories: [],
          error: response.error.message,
        });
    } catch (cause) {
      setRepositoryDiscovery({
        githubCliAvailable: true,
        authenticated: false,
        repositories: [],
        error: `GitHub discovery failed: ${errorMessage(cause)}`,
      });
    } finally {
      setRepositoryDiscoveryLoading(false);
    }
  }

  function openSessionModal(task?: TaskDto) {
    setSessionForm({ name: task?.title ?? "", taskId: task?.id });
    setSessionModel("");
    setModelCatalogError(undefined);
    setModal("session");
  }

  function openRepositoryModal() {
    setSelectedRepositoryIds(new Set());
    setSelectedGitHubRepositories(new Set());
    setRepositoryDiscovery(undefined);
    setRepositoryOperations([]);
    setRepositoryForm({ remoteUrl: "", search: "" });
    setModal("repository");
    void loadRepositoryDiscovery();
  }

  function closeRepositoryModal() {
    if (busy) return;
    setRepositoryOperations([]);
    setModal(undefined);
  }

  function closeSessionModal() {
    setSessionForm({ name: "" });
    setSessionModel("");
    setModal(undefined);
  }

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    const created = await perform(
      client.request.workspaceCreate({
        name: workspaceForm.name,
        slug: workspaceForm.slug || undefined,
        path: workspaceForm.path || undefined,
      }),
    );
    if (created) {
      setWorkspaceId(created.id);
      setWorkspaceForm({ name: "", slug: "", path: "" });
      setModal(undefined);
    }
  }

  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace) return;
    const created = await perform(
      client.request.taskCreate({
        workspace: workspace.id,
        title: taskForm.title,
        description: taskForm.description,
      }),
    );
    if (created) {
      setSelectedTaskId(created.id);
      setTaskForm({ title: "", description: "" });
      setModal(undefined);
    }
  }

  async function createSession(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace) return;
    const isTerminal = sessionType === "terminal";
    const launch: SessionLaunchState = {
      key: crypto.randomUUID(),
      workspaceId: workspace.id,
      taskId: sessionForm.taskId,
      name: sessionForm.name,
      tool: isTerminal ? "terminal" : (sessionType as "codex" | "claude"),
      startedAt: new Date().toISOString(),
      status: "starting",
    };
    setSessionLaunches((current) => [launch, ...current]);
    setSessionForm({ name: "" });
    setModal(undefined);
    setView("sessions");
    try {
      const response = await client.request.agentSpawn({
        workspace: workspace.id,
        taskId: launch.taskId,
        name: launch.name,
        terminal: isTerminal || undefined,
        provider: isTerminal ? undefined : (sessionType as "codex" | "claude"),
        model: isTerminal || !sessionModel ? undefined : sessionModel,
      });
      if (response.ok) {
        setSessionLaunches((current) =>
          current.filter((item) => item.key !== launch.key),
        );
        await refresh();
        setActiveSessionId(response.data.id);
        return;
      }
      const sessionId =
        typeof response.error.details?.sessionId === "string"
          ? response.error.details.sessionId
          : undefined;
      setSessionLaunches((current) =>
        current.map((item) =>
          item.key === launch.key
            ? {
                ...item,
                sessionId,
                status: "error",
                error: response.error.message,
              }
            : item,
        ),
      );
      await refresh();
      if (sessionId) setActiveSessionId(sessionId);
    } catch (cause) {
      setSessionLaunches((current) =>
        current.map((item) =>
          item.key === launch.key
            ? { ...item, status: "error", error: errorMessage(cause) }
            : item,
        ),
      );
    }
  }

  async function attachSelectedRepositories() {
    if (!workspace) return;
    const pending = [...selectedRepositoryIds].filter(
      (id) => !attachedLibraryRepositoryIds.has(id),
    );
    const pendingGitHub = (repositoryDiscovery?.repositories ?? []).filter(
      (item) => selectedGitHubRepositories.has(item.nameWithOwner),
    );
    if (pending.length === 0 && pendingGitHub.length === 0) return;
    const localById = new Map(
      (snapshot?.repositories ?? []).map((repository) => [
        repository.id,
        repository,
      ]),
    );
    setRepositoryOperations([
      ...pendingGitHub.map((repository) => ({
        key: `github:${repository.nameWithOwner}`,
        name: repository.name,
        detail: repository.nameWithOwner,
        status: "queued" as const,
      })),
      ...pending.map((id) => ({
        key: `library:${id}`,
        name: localById.get(id)?.name ?? "Repository",
        detail: "Daedalus library",
        status: "queued" as const,
      })),
    ]);
    setBusy(true);
    setError(undefined);
    const updateOperation = (
      key: string,
      update: {
        status: "cloning" | "attaching" | "done" | "error";
        error?: string;
      },
    ) =>
      setRepositoryOperations((current) =>
        current.map((operation) =>
          operation.key === key ? { ...operation, ...update } : operation,
        ),
      );
    try {
      for (const repository of pendingGitHub) {
        const key = `github:${repository.nameWithOwner}`;
        try {
          updateOperation(key, { status: "cloning" });
          const response = await client.request.repositoryLibraryAdd({
            remoteUrl: repository.remoteUrl,
            githubNameWithOwner: repository.nameWithOwner,
          });
          if (!response.ok) throw new Error(response.error.message);
          updateOperation(key, { status: "attaching" });
          const attached = await client.request.workspaceRepositoryAttach({
            workspace: workspace.id,
            libraryRepositoryId: response.data.id,
          });
          if (!attached.ok) throw new Error(attached.error.message);
          updateOperation(key, { status: "done" });
          setSelectedGitHubRepositories((current) => {
            const next = new Set(current);
            next.delete(repository.nameWithOwner);
            return next;
          });
        } catch (cause) {
          updateOperation(key, {
            status: "error",
            error: errorMessage(cause),
          });
        }
      }
      for (const libraryRepositoryId of pending) {
        const key = `library:${libraryRepositoryId}`;
        try {
          updateOperation(key, { status: "attaching" });
          const response = await client.request.workspaceRepositoryAttach({
            workspace: workspace.id,
            libraryRepositoryId,
          });
          if (!response.ok) throw new Error(response.error.message);
          updateOperation(key, { status: "done" });
          setSelectedRepositoryIds((current) => {
            const next = new Set(current);
            next.delete(libraryRepositoryId);
            return next;
          });
        } catch (cause) {
          updateOperation(key, {
            status: "error",
            error: errorMessage(cause),
          });
        }
      }
      await refresh();
      const content = await client.request.workspaceContentGet({
        workspace: workspace.id,
      });
      if (content.ok) {
        setWorkspaceContent(content.data);
        setWorkspaceDirectories((current) => ({
          ...current,
          "": content.data.files,
        }));
      } else throw new Error(content.error.message);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function syncWorkspaceRepository(repositoryId: string) {
    if (!workspace) return;
    setSyncingRepositoryIds((current) => new Set(current).add(repositoryId));
    setError(undefined);
    try {
      const response = await client.request.workspaceRepositorySync({
        id: repositoryId,
      });
      if (!response.ok) throw new Error(response.error.message);
      const content = await client.request.workspaceContentGet({
        workspace: workspace.id,
      });
      if (!content.ok) throw new Error(content.error.message);
      setWorkspaceContent(content.data);
      setWorkspaceDirectories((current) => ({
        ...current,
        "": content.data.files,
      }));
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSyncingRepositoryIds((current) => {
        const next = new Set(current);
        next.delete(repositoryId);
        return next;
      });
    }
  }

  async function addRemoteRepository(event: React.FormEvent) {
    event.preventDefault();
    if (!looksLikeRepositorySource(repositoryForm.search)) return;
    const repository = await perform(
      client.request.repositoryLibraryAdd({
        remoteUrl: repositoryForm.search,
      }),
    );
    if (repository) {
      setSelectedRepositoryIds((current) =>
        new Set(current).add(repository.id),
      );
      setRepositoryForm({ remoteUrl: "", search: "" });
    }
  }

  async function appendJournal(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace) return;
    const content = await perform(
      client.request.workspaceJournalAppend({
        workspace: workspace.id,
        kind: journalForm.kind,
        summary: journalForm.summary,
      }),
    );
    if (content) {
      setWorkspaceContent(content);
      setWorkspaceDirectories((current) => ({ ...current, "": content.files }));
      if (selectedWorkspaceFile?.path === "JOURNAL.md")
        setSelectedWorkspaceFile({
          name: "JOURNAL.md",
          path: "JOURNAL.md",
          content: content.journal,
          format: "markdown",
        });
      if (selectedWorkspaceFile?.path === "JOURNAL.md")
        setWorkspaceDraft(content.journal);
      setJournalForm({ kind: "progress", summary: "" });
    }
  }

  async function openWorkspaceFile(path: string) {
    if (!workspace) return;
    if (
      selectedWorkspaceFile &&
      workspaceDraft !== selectedWorkspaceFile.content &&
      !window.confirm("Discard the unsaved changes in the current file?")
    )
      return;
    const response = await client.request.workspaceFileRead({
      workspace: workspace.id,
      path,
    });
    if (response.ok) {
      setSelectedWorkspaceFile(response.data);
      setWorkspaceDraft(response.data.content);
      setWorkspaceFileMode("edit");
      setSelectedWorkspaceDirectory(workspaceParentPath(response.data.path));
      setError(undefined);
    } else setError(response.error.message);
  }

  async function saveWorkspaceFile() {
    if (
      !workspace ||
      !selectedWorkspaceFile ||
      workspaceDraft === selectedWorkspaceFile.content
    )
      return;
    const saved = await perform(
      client.request.workspaceFileWrite({
        workspace: workspace.id,
        path: selectedWorkspaceFile.path,
        content: workspaceDraft,
        expectedContent: selectedWorkspaceFile.content,
      }),
    );
    if (!saved) return;
    setSelectedWorkspaceFile(saved);
    setWorkspaceDraft(saved.content);
    if (saved.path === "BRIEF.md")
      setWorkspaceContent((current) =>
        current ? { ...current, brief: saved.content } : current,
      );
    if (saved.path === "JOURNAL.md")
      setWorkspaceContent((current) =>
        current ? { ...current, journal: saved.content } : current,
      );
  }

  async function createWorkspaceEntry(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace || !newWorkspaceEntry) return;
    if (
      selectedWorkspaceFile &&
      workspaceDraft !== selectedWorkspaceFile.content &&
      !window.confirm("Discard the unsaved changes in the current file?")
    )
      return;
    const created = await perform(
      client.request.workspaceEntryCreate({
        workspace: workspace.id,
        parentPath: selectedWorkspaceDirectory || undefined,
        name: newWorkspaceEntry.name,
        kind: newWorkspaceEntry.kind,
      }),
    );
    if (!created) return;
    const listing = await client.request.workspaceDirectoryList({
      workspace: workspace.id,
      path: selectedWorkspaceDirectory || undefined,
    });
    if (listing.ok)
      setWorkspaceDirectories((current) => ({
        ...current,
        [selectedWorkspaceDirectory]: listing.data,
        ...(created.kind === "directory" ? { [created.path]: [] } : {}),
      }));
    setNewWorkspaceEntry(undefined);
    if (created.kind === "directory") {
      setSelectedWorkspaceDirectory(created.path);
      setExpandedWorkspaceDirectories((current) =>
        new Set(current).add(selectedWorkspaceDirectory).add(created.path),
      );
    } else {
      const opened = await client.request.workspaceFileRead({
        workspace: workspace.id,
        path: created.path,
      });
      if (opened.ok) {
        setSelectedWorkspaceFile(opened.data);
        setWorkspaceDraft(opened.data.content);
        setWorkspaceFileMode("edit");
        setSelectedWorkspaceDirectory(workspaceParentPath(opened.data.path));
      } else setError(opened.error.message);
    }
  }

  async function toggleWorkspaceDirectory(path: string) {
    if (!workspace) return;
    const isExpanded = expandedWorkspaceDirectories.has(path);
    if (isExpanded) {
      setExpandedWorkspaceDirectories((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    if (!workspaceDirectories[path]) {
      const response = await client.request.workspaceDirectoryList({
        workspace: workspace.id,
        path,
      });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setWorkspaceDirectories((current) => ({
        ...current,
        [path]: response.data,
      }));
    }
    setExpandedWorkspaceDirectories((current) => new Set(current).add(path));
  }

  async function updateTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTask) return;
    const data = new FormData(event.currentTarget);
    const updated = await perform(
      client.request.taskUpdate({
        id: selectedTask.id,
        title: String(data.get("title") ?? ""),
        description: String(data.get("description") ?? ""),
      }),
    );
    if (updated) setEditingTask(false);
  }

  async function archiveSession(session: AgentSessionDto) {
    const archived = await perform(
      client.request.agentArchive({ id: session.id, force: false }),
    );
    if (archived) {
      if (activeSessionId === session.id) setActiveSessionId(undefined);
      setSessionAction(undefined);
    }
  }

  async function restoreSession(session: AgentSessionDto) {
    const restored = await perform(
      client.request.agentRestore({ id: session.id }),
    );
    if (restored) setActiveSessionId(restored.id);
  }

  async function archiveWorkspace(item: WorkspaceDto) {
    const wasSelected = workspaceId === item.id;
    setWorkspaceAction(undefined);
    setArchivingWorkspaceIds((current) => new Set(current).add(item.id));
    if (wasSelected) {
      setWorkspaceId(
        activeWorkspaces.find((workspace) => workspace.id !== item.id)?.id,
      );
      setSelectedTaskId(undefined);
      setActiveSessionId(undefined);
    }
    const archived = await perform(
      client.request.workspaceArchive({ reference: item.id }),
    );
    setArchivingWorkspaceIds((current) => {
      const next = new Set(current);
      next.delete(item.id);
      return next;
    });
    if (!archived && wasSelected) setWorkspaceId(item.id);
  }

  async function restoreWorkspace(item: WorkspaceDto) {
    const restored = await perform(
      client.request.workspaceRestore({ reference: item.id }),
    );
    if (restored) setWorkspaceId(restored.id);
  }

  async function createIntegratedTerminal(workspace?: WorkspaceDto) {
    setTerminalPanelOpen(true);
    const created = await perform(
      client.request.terminalCreate({
        workspace: workspace?.id,
        name: workspace?.name,
      }),
    );
    if (created) setActiveTerminalId(created.id);
  }

  async function closeIntegratedTerminal(terminal: IntegratedTerminalDto) {
    const index = integratedTerminals.findIndex(
      (item) => item.id === terminal.id,
    );
    const next =
      integratedTerminals[index + 1] ?? integratedTerminals[index - 1];
    const closed = await perform(
      client.request.terminalClose({ id: terminal.id }),
    );
    if (closed && activeIntegratedTerminal?.id === terminal.id)
      setActiveTerminalId(next?.id);
  }

  function selectWorkspace(id: string) {
    setWorkspaceId(id);
    setSelectedTaskId(undefined);
    setActiveSessionId(undefined);
    setView("board");
  }

  const taskInspector = !selectedTask ? (
    <div className="empty large">
      <strong>Select a task</strong>
      <span>Its brief will appear here.</span>
    </div>
  ) : editingTask ? (
    <form className="task-editor brief-editor" onSubmit={updateTask}>
      <label>
        Title
        <input name="title" defaultValue={selectedTask.title} required />
      </label>
      <label>
        <span className="field-heading">
          Markdown <small>⌘↵ to save</small>
        </span>
        <textarea
          name="description"
          defaultValue={selectedTask.description}
          rows={16}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
              event.currentTarget.form?.requestSubmit();
          }}
        />
      </label>
      <div className="editor-actions">
        <button
          className="quiet"
          onClick={() => setEditingTask(false)}
          type="button"
        >
          Cancel
        </button>
        <button disabled={busy} type="submit">
          Save brief
        </button>
      </div>
    </form>
  ) : (
    <div className="task-brief">
      <div className="brief-modal-toolbar">
        <select
          aria-label="Task status"
          value={selectedTask.status}
          onChange={(event) =>
            void perform(
              client.request.taskSetStatus({
                id: selectedTask.id,
                status: event.target.value as TaskStatus,
              }),
            )
          }
        >
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {status.replace("_", " ")}
            </option>
          ))}
        </select>
      </div>
      <h2>
        #{selectedTask.number} {selectedTask.title}
      </h2>
      <MarkdownPreview source={selectedTask.description} />
      <button
        className="danger-link brief-delete"
        onClick={() =>
          void (async () => {
            if (
              !window.confirm(
                `Permanently delete task “${selectedTask.title}”?`,
              )
            )
              return;
            await perform(
              client.request.taskRemove({ id: selectedTask.id, force: true }),
            );
            setSelectedTaskId(undefined);
          })()
        }
      >
        Delete task
      </button>
    </div>
  );

  const renderWorkspaceDirectory = (
    directory = "",
    depth = 0,
  ): React.ReactNode =>
    (workspaceDirectories[directory] ?? []).map((entry) => {
      const expanded = expandedWorkspaceDirectories.has(entry.path);
      const selected =
        entry.kind === "directory"
          ? selectedWorkspaceDirectory === entry.path
          : selectedWorkspaceFile?.path === entry.path;
      return (
        <div className="workspace-tree-entry" key={entry.path}>
          <button
            aria-expanded={entry.kind === "directory" ? expanded : undefined}
            className={selected ? "selected" : ""}
            disabled={entry.kind === "symlink"}
            onClick={() => {
              if (entry.kind === "directory") {
                setSelectedWorkspaceDirectory(entry.path);
                void toggleWorkspaceDirectory(entry.path);
              } else if (entry.kind === "file")
                void openWorkspaceFile(entry.path);
            }}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            title={entry.path}
            type="button"
          >
            <span
              className={`workspace-tree-icon ${entry.kind}`}
              aria-hidden="true"
            >
              {entry.kind === "directory"
                ? expanded
                  ? "⌄"
                  : "›"
                : entry.kind === "symlink"
                  ? "↗"
                  : ""}
            </span>
            <span>{entry.name}</span>
          </button>
          {entry.kind === "directory" && expanded && (
            <div>{renderWorkspaceDirectory(entry.path, depth + 1)}</div>
          )}
        </div>
      );
    });

  return (
    <main
      className={`app ${terminalPanelOpen ? "terminal-panel-open" : ""}`}
      data-theme={theme}
      style={
        {
          "--terminal-panel-height": `${terminalPanelHeight}px`,
          "--workspace-panel-width": `${workspacePanelWidth}px`,
          "--board-detail-panel-width": `${boardDetailPanelWidth}px`,
          "--sessions-panel-width": `${sessionsPanelWidth}px`,
        } as CSSProperties
      }
    >
      <header className="topbar">
        <div className="brand">
          <span aria-hidden="true" className="brand-mark">
            D
          </span>
          <span className="brand-copy">
            <strong>Daedalus</strong>
            <small>Agent workspace</small>
          </span>
        </div>
        <nav className="app-mode-switcher" aria-label="Workspace mode">
          <button
            aria-current={view === "board" ? "page" : undefined}
            className={view === "board" ? "active" : ""}
            disabled={!workspace}
            onClick={() => setView("board")}
          >
            Board
          </button>
          <button
            aria-current={view === "sessions" ? "page" : undefined}
            className={view === "sessions" ? "active" : ""}
            disabled={!workspace}
            onClick={() => setView("sessions")}
          >
            Sessions
          </button>
          <button
            aria-current={view === "workspace" ? "page" : undefined}
            className={view === "workspace" ? "active" : ""}
            disabled={!workspace}
            onClick={() => setView("workspace")}
          >
            Workspace
          </button>
        </nav>
        <div className="top-actions">
          {busy && <span className="syncing">Working…</span>}
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(undefined)}>Dismiss</button>
        </div>
      )}

      <div className={`workspace-shell mode-${view}`}>
        <aside
          className={`workspace-column ${workspacePanelWidth < PANEL_COMPACT_THRESHOLD ? "panel-compact" : ""}`}
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">Projects</span>
              <h1>Workspaces</h1>
            </div>
            <div className="panel-heading-actions">
              <CreateButton
                label="Create workspace"
                onClick={() => setModal("workspace")}
              />
              <PanelCollapseButton
                collapsed={workspacePanelWidth < PANEL_COMPACT_THRESHOLD}
                label="workspace"
                onClick={toggleWorkspacePanel}
                side="left"
              />
            </div>
          </div>
          <nav aria-label="Workspaces" className="item-list">
            {!snapshot && !error && (
              <div className="empty">Loading workspaces…</div>
            )}
            {activeWorkspaces.length === 0 &&
              archivedWorkspaces.length === 0 && (
                <div className="empty large">
                  <strong>No workspaces yet</strong>
                  <span>Use New to create one.</span>
                </div>
              )}
            {activeWorkspaces.map((item) => {
              const itemSessions = (snapshot?.agents ?? []).filter(
                (session) =>
                  session.workspaceId === item.id && !session.archivedAt,
              );
              const liveCount = itemSessions.filter(sessionIsLive).length;
              const attentionCount = itemSessions.filter(
                sessionNeedsAttention,
              ).length;
              const sessionLabel = `${itemSessions.length} ${itemSessions.length === 1 ? "session" : "sessions"}`;
              const insightLabel = `${sessionLabel} in ${item.name}: ${liveCount} live, ${attentionCount} need attention`;

              return (
                <div
                  className={`workspace-card ${item.id === workspaceId ? "selected" : ""}`}
                  key={item.id}
                >
                  <button
                    className="workspace-item"
                    onClick={() => selectWorkspace(item.id)}
                  >
                    <span className="workspace-icon">
                      {item.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="workspace-card-content">
                      <strong>{item.name}</strong>
                      <small>
                        {item.available
                          ? item.slug
                          : `${item.slug} · folder missing`}
                      </small>
                      <span
                        aria-label={insightLabel}
                        className="workspace-session-insights"
                      >
                        <span className="workspace-session-icons">
                          {itemSessions.slice(0, 5).map((session) => {
                            const tool = sessionTool(session);
                            return (
                              <span
                                className={`workspace-session-indicator tool-${tool}`}
                                data-attention={
                                  sessionNeedsAttention(session)
                                    ? "true"
                                    : undefined
                                }
                                key={session.id}
                                title={`${sessionName(session)} · ${session.status}`}
                              >
                                <ToolIcon tool={tool} />
                                <span
                                  className={`agent-dot ${session.status}`}
                                />
                              </span>
                            );
                          })}
                          {itemSessions.length > 5 && (
                            <small>+{itemSessions.length - 5}</small>
                          )}
                        </span>
                        <small
                          className={
                            attentionCount > 0
                              ? "workspace-insight-copy needs-attention"
                              : "workspace-insight-copy"
                          }
                        >
                          {attentionCount > 0
                            ? `${attentionCount} need attention`
                            : itemSessions.length > 0
                              ? `${liveCount} live · ${sessionLabel}`
                              : "No sessions"}
                        </small>
                      </span>
                    </span>
                  </button>
                  <span className="workspace-card-actions">
                    <button
                      aria-label={`Open ${item.name} in integrated terminal`}
                      className="session-card-action workspace-terminal-action"
                      disabled={!item.available || busy}
                      onClick={() => void createIntegratedTerminal(item)}
                      title="Open in integrated terminal"
                      type="button"
                    >
                      <SessionLaunchIcon />
                    </button>
                    <button
                      aria-label={`Archive ${item.name} workspace`}
                      className="session-card-action workspace-card-archive"
                      onClick={() => setWorkspaceAction(item)}
                      title="Archive workspace"
                      type="button"
                    >
                      <ArchiveIcon />
                    </button>
                  </span>
                </div>
              );
            })}
          </nav>
          {archivedWorkspaces.length > 0 && (
            <details className="archive-list workspace-archive-list">
              <summary>
                Archived workspaces ({archivedWorkspaces.length})
              </summary>
              <div className="item-list">
                {archivedWorkspaces.map((item) => (
                  <div className="archived-item" key={item.id}>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.slug}</small>
                    </span>
                    <button onClick={() => void restoreWorkspace(item)}>
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </aside>

        <div
          aria-label="Resize workspace panel"
          aria-orientation="vertical"
          aria-valuemax={480}
          aria-valuemin={PANEL_RAIL_WIDTH}
          aria-valuenow={workspacePanelWidth}
          className="column-resize-handle workspace-panel-resize-handle"
          onDoubleClick={toggleWorkspacePanel}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setWorkspacePanelWidth((width) =>
              clampPanelSize(
                width + (event.key === "ArrowRight" ? PANEL_STEP : -PANEL_STEP),
                480,
              ),
            );
          }}
          onPointerDown={(event) => startColumnResize(event, "workspace")}
          role="separator"
          tabIndex={0}
        />

        <section
          className={`workspace-main ${view === "board" ? "board-column" : view === "sessions" ? `session-navigator ${sessionsPanelWidth < PANEL_COMPACT_THRESHOLD ? "panel-compact" : ""}` : "workspace-content-column"}`}
        >
          <div className="workspace-main-header">
            <div>
              <span className="eyebrow">
                {workspace?.slug ?? "Select a workspace"}
              </span>
              <h1>{workspace?.name ?? "Workspace"}</h1>
            </div>
          </div>
          {!workspace ? (
            <div className="empty large">
              <strong>Choose a workspace</strong>
              <span>Its board, sessions, and files will appear here.</span>
            </div>
          ) : view === "workspace" ? (
            <>
              <div className="workspace-content-toolbar">
                <div>
                  <strong>Workspace files</strong>
                  <small>{workspace.path}</small>
                </div>
              </div>
              {!workspaceContent ||
              workspaceContent.workspaceId !== workspace.id ? (
                <div className="empty large">Loading workspace content…</div>
              ) : (
                <div className="workspace-browser">
                  <aside className="workspace-explorer">
                    <div className="workspace-explorer-heading">
                      <div>
                        <span>Explorer</span>
                        <small>{workspace.name}</small>
                      </div>
                      <div className="workspace-explorer-actions">
                        <button
                          aria-label="New file"
                          disabled={workspaceSelectionReadOnly}
                          onClick={() =>
                            setNewWorkspaceEntry({ kind: "file", name: "" })
                          }
                          title="New file"
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
                          disabled={workspaceSelectionReadOnly}
                          onClick={() =>
                            setNewWorkspaceEntry({
                              kind: "directory",
                              name: "",
                            })
                          }
                          title="New folder"
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
                      </div>
                    </div>
                    {newWorkspaceEntry && (
                      <form
                        className="workspace-new-entry"
                        onSubmit={createWorkspaceEntry}
                      >
                        <small title={selectedWorkspaceDirectory || "/"}>
                          {selectedWorkspaceDirectory || "/"}
                        </small>
                        <input
                          aria-label={`New ${newWorkspaceEntry.kind} name`}
                          autoFocus
                          onBlur={() => {
                            if (!newWorkspaceEntry.name)
                              setNewWorkspaceEntry(undefined);
                          }}
                          onChange={(event) =>
                            setNewWorkspaceEntry({
                              ...newWorkspaceEntry,
                              name: event.target.value,
                            })
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Escape")
                              setNewWorkspaceEntry(undefined);
                          }}
                          placeholder={
                            newWorkspaceEntry.kind === "file"
                              ? "filename.md"
                              : "folder name"
                          }
                          required
                          value={newWorkspaceEntry.name}
                        />
                      </form>
                    )}
                    <nav
                      aria-label="Workspace files"
                      className="workspace-tree"
                    >
                      {renderWorkspaceDirectory()}
                    </nav>
                    <div className="workspace-explorer-secondary">
                      <details>
                        <summary>
                          <span>Repositories</span>
                          <small>{workspaceContent.repositories.length}</small>
                          <button
                            aria-label="Add repository"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              openRepositoryModal();
                            }}
                            title="Add repository"
                            type="button"
                          >
                            +
                          </button>
                        </summary>
                        <div className="workspace-resource-list">
                          {workspaceContent.repositories.length === 0 && (
                            <div className="empty">
                              No attached repositories
                            </div>
                          )}
                          {workspaceContent.repositories.map((repository) => (
                            <div
                              className={`workspace-resource-row repository-status-${repository.gitStatus?.state ?? "unavailable"}`}
                              key={repository.id}
                            >
                              <span>
                                <strong>{repository.name}</strong>
                                <small
                                  title={
                                    repository.referencePath ??
                                    repository.canonicalPath
                                  }
                                >
                                  {repository.baseBranch ?? "Local"}
                                  {" · "}
                                  <span className="repository-git-status">
                                    <i aria-hidden="true" />
                                    {repositoryStatusText(repository.gitStatus)}
                                  </span>
                                </small>
                              </span>
                              <button
                                aria-label={`Fetch and update ${repository.name}`}
                                className={`quiet workspace-repository-sync ${syncingRepositoryIds.has(repository.id) ? "syncing" : ""}`}
                                disabled={syncingRepositoryIds.has(
                                  repository.id,
                                )}
                                onClick={() =>
                                  void syncWorkspaceRepository(repository.id)
                                }
                                title={`Fetch and fast-forward from ${repository.baseBranch ?? "the remote default branch"}`}
                                type="button"
                              >
                                <RepositoryPullIcon />
                              </button>
                            </div>
                          ))}
                        </div>
                      </details>
                      <details>
                        <summary>
                          <span>Working trees</span>
                          <small>{workspaceContent.worktrees.length}</small>
                        </summary>
                        <div className="workspace-resource-list">
                          {workspaceContent.worktrees.length === 0 && (
                            <div className="empty">No session worktrees</div>
                          )}
                          {workspaceContent.worktrees.map((worktree) => {
                            const repository =
                              workspaceContent.repositories.find(
                                (item) => item.id === worktree.repositoryId,
                              );
                            const session = workspaceSessions.find(
                              (item) => item.id === worktree.sessionId,
                            );
                            return (
                              <div
                                className="workspace-resource-row"
                                key={`${worktree.sessionId}-${worktree.repositoryId}`}
                              >
                                <span>
                                  <strong>
                                    {repository?.name ?? "Repository"}
                                  </strong>
                                  <small title={worktree.path}>
                                    {session?.name ??
                                      worktree.sessionId.slice(0, 8)}
                                  </small>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    </div>
                  </aside>

                  <section className="workspace-viewer">
                    <div className="workspace-viewer-tabbar">
                      {selectedWorkspaceFile ? (
                        <span className="workspace-viewer-tab">
                          <span aria-hidden="true">
                            {selectedWorkspaceFile.format === "markdown"
                              ? "M↓"
                              : "≡"}
                          </span>
                          <strong>{selectedWorkspaceFile.name}</strong>
                        </span>
                      ) : (
                        <span className="workspace-viewer-tab muted">
                          No file selected
                        </span>
                      )}
                      {selectedWorkspaceFile && (
                        <div className="workspace-viewer-actions">
                          {selectedWorkspaceFileReadOnly && (
                            <span>Reference checkout · read-only</span>
                          )}
                          {workspaceDraft !== selectedWorkspaceFile.content && (
                            <span>Unsaved</span>
                          )}
                          {selectedWorkspaceFile.format === "markdown" && (
                            <button
                              aria-pressed={workspaceFileMode === "preview"}
                              className={
                                workspaceFileMode === "preview" ? "active" : ""
                              }
                              onClick={() =>
                                setWorkspaceFileMode((current) =>
                                  current === "edit" ? "preview" : "edit",
                                )
                              }
                              type="button"
                            >
                              {workspaceFileMode === "edit"
                                ? "Preview"
                                : "Edit"}
                            </button>
                          )}
                          <button
                            disabled={
                              busy ||
                              selectedWorkspaceFileReadOnly ||
                              workspaceDraft === selectedWorkspaceFile.content
                            }
                            onClick={() => void saveWorkspaceFile()}
                            title="Save (⌘S)"
                            type="button"
                          >
                            Save
                          </button>
                        </div>
                      )}
                    </div>
                    {selectedWorkspaceFile ? (
                      <>
                        <div className="workspace-viewer-breadcrumb">
                          {selectedWorkspaceFile.path.split("/").join("  ›  ")}
                        </div>
                        {selectedWorkspaceFile.format === "markdown" &&
                        workspaceFileMode === "preview" ? (
                          <div className="workspace-viewer-content markdown">
                            <MarkdownPreview source={workspaceDraft} />
                          </div>
                        ) : (
                          <WorkspaceFileEditor
                            file={{
                              ...selectedWorkspaceFile,
                              content: workspaceDraft,
                            }}
                            onChange={setWorkspaceDraft}
                            onSave={() => void saveWorkspaceFile()}
                            readOnly={selectedWorkspaceFileReadOnly}
                            theme={theme}
                          />
                        )}
                        {selectedWorkspaceFile.path === "JOURNAL.md" &&
                          workspaceDraft === selectedWorkspaceFile.content && (
                            <form
                              className="journal-entry-form"
                              onSubmit={appendJournal}
                            >
                              <select
                                aria-label="Journal entry type"
                                value={journalForm.kind}
                                onChange={(event) =>
                                  setJournalForm({
                                    ...journalForm,
                                    kind: event.target
                                      .value as typeof journalForm.kind,
                                  })
                                }
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
                                placeholder="Record a meaningful update…"
                                required
                                value={journalForm.summary}
                                onChange={(event) =>
                                  setJournalForm({
                                    ...journalForm,
                                    summary: event.target.value,
                                  })
                                }
                              />
                              <button disabled={busy} type="submit">
                                Add
                              </button>
                            </form>
                          )}
                      </>
                    ) : (
                      <div className="workspace-viewer-empty">
                        <strong>Select a file</strong>
                        <span>
                          Choose a text or Markdown file from the explorer.
                        </span>
                      </div>
                    )}
                  </section>
                </div>
              )}
            </>
          ) : view === "board" ? (
            <>
              <div className="board-toolbar">
                <div>
                  <strong>Tasks</strong>
                  <span className="count-badge">{tasks.length}</span>
                </div>
                <div className="heading-actions">
                  <select
                    aria-label="Filter tasks by status"
                    value={filter}
                    onChange={(event) =>
                      setFilter(event.target.value as TaskStatus | "all")
                    }
                  >
                    <option value="all">All statuses</option>
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                  <CreateButton
                    label="Create task"
                    onClick={() => setModal("task")}
                  />
                </div>
              </div>
              <div className="board-grid">
                {tasks.length === 0 && (
                  <div className="empty large">
                    <strong>No matching tasks</strong>
                    <span>Use New to create a task.</span>
                  </div>
                )}
                {tasks.map((task) => {
                  const linked = sessions.filter(
                    (item) => item.taskId === task.id,
                  );
                  return (
                    <article
                      className={`task-item status-card-${task.status} ${task.id === selectedTaskId ? "selected" : ""}`}
                      key={task.id}
                      onClick={() => {
                        setSelectedTaskId(task.id);
                        setEditingTask(false);
                      }}
                    >
                      <div className="task-card-top">
                        <span className={`pill status-${task.status}`}>
                          {task.status.replace("_", " ")}
                        </span>
                        <small>
                          #{task.number} ·{" "}
                          {new Date(task.updatedAt).toLocaleDateString()}
                        </small>
                      </div>
                      <strong>{task.title}</strong>
                      <p>{taskExcerpt(task.description) || "No task brief"}</p>
                      <div className="task-card-footer">
                        <div
                          aria-label={`Sessions for ${task.title}`}
                          className="task-session-links"
                        >
                          {linked.length === 0 && (
                            <span className="task-session-empty">
                              No sessions
                            </span>
                          )}
                          {linked.map((session) => {
                            const tool = sessionTool(session);
                            return (
                              <button
                                aria-label={`Open ${sessionName(session)} session`}
                                className={`task-session-link tool-${tool} ${session.status}`}
                                key={session.id}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setActiveSessionId(session.id);
                                  setView("sessions");
                                }}
                                title={`${sessionName(session)} · ${session.status}`}
                                type="button"
                              >
                                <ToolIcon tool={tool} />
                              </button>
                            );
                          })}
                        </div>
                        <button
                          aria-label={`Create session for ${task.title}`}
                          className="task-session-create"
                          disabled={!snapshot?.settings.tmuxAvailable}
                          onClick={(event) => {
                            event.stopPropagation();
                            openSessionModal(task);
                          }}
                          type="button"
                        >
                          <SessionLaunchIcon />
                          <span>Start session…</span>
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="sessions-toolbar">
                <div>
                  <strong>Sessions</strong>
                  <span className="count-badge">
                    {sessions.length + pendingSessionLaunches.length}
                  </span>
                </div>
                <div className="panel-heading-actions">
                  <CreateButton
                    disabled={!snapshot?.settings.tmuxAvailable}
                    label="Create session"
                    onClick={() => openSessionModal()}
                  />
                  <PanelCollapseButton
                    collapsed={sessionsPanelWidth < PANEL_COMPACT_THRESHOLD}
                    label="sessions"
                    onClick={toggleSessionsPanel}
                    side="left"
                  />
                </div>
              </div>
              <div className="session-grid item-list">
                {sessions.length === 0 &&
                  pendingSessionLaunches.length === 0 && (
                    <div className="empty large">
                      <strong>No sessions yet</strong>
                      <span>Create an agent or free terminal.</span>
                    </div>
                  )}
                {pendingSessionLaunches.map((launch) => (
                  <div
                    aria-busy={launch.status === "starting"}
                    className={`session-card session-card-${launch.status}`}
                    key={launch.key}
                  >
                    <div className="session-card-main">
                      <span className={`session-kind-icon tool-${launch.tool}`}>
                        {launch.status === "starting" ? (
                          <span
                            aria-hidden="true"
                            className="session-launch-spinner"
                          />
                        ) : (
                          <ToolIcon tool={launch.tool} />
                        )}
                      </span>
                      <span>
                        <strong>{launch.name}</strong>
                        <small>
                          {launch.status === "starting"
                            ? `Starting ${launch.tool}…`
                            : "Failed to start"}
                        </small>
                        {launch.error && (
                          <em className="session-startup-error" role="alert">
                            {launch.error}
                          </em>
                        )}
                        <time dateTime={launch.startedAt}>
                          Requested ·{" "}
                          {new Date(launch.startedAt).toLocaleString()}
                        </time>
                      </span>
                    </div>
                  </div>
                ))}
                {sessions.map((session) => {
                  const task = allTasks.find(
                    (item) => item.id === session.taskId,
                  );
                  const tool = sessionTool(session);
                  const timestamp = session.endedAt ?? session.startedAt;
                  const startupError = sessionStartupErrors.get(session.id);
                  return (
                    <div
                      className={`session-card ${session.id === activeSessionId ? "selected" : ""}`}
                      key={session.id}
                    >
                      <button
                        className="session-card-main"
                        data-provider={session.provider}
                        data-session-id={session.id}
                        onClick={() => setActiveSessionId(session.id)}
                      >
                        <span className={`session-kind-icon tool-${tool}`}>
                          <ToolIcon tool={tool} />
                        </span>
                        <span>
                          <strong>{sessionName(session)}</strong>
                          <small>{task?.title ?? "Workspace session"}</small>
                          <em>
                            <span className={`agent-dot ${session.status}`} />
                            {startupError
                              ? "failed to start"
                              : session.status}{" "}
                            · {session.id.slice(0, 6)}
                          </em>
                          {startupError && (
                            <em className="session-startup-error" role="alert">
                              {startupError}
                            </em>
                          )}
                          <time dateTime={timestamp}>
                            {session.endedAt ? "Ended" : "Started"} ·{" "}
                            {new Date(timestamp).toLocaleString()}
                          </time>
                        </span>
                      </button>
                      <button
                        aria-label={`Archive ${sessionName(session)} session`}
                        className="session-card-action"
                        onClick={() => setSessionAction({ session })}
                        title="Archive session"
                      >
                        <ArchiveIcon />
                      </button>
                    </div>
                  );
                })}
              </div>
              {archivedSessions.length > 0 && (
                <details className="archive-list session-archive-list">
                  <summary>
                    Archived sessions ({archivedSessions.length})
                  </summary>
                  <div className="item-list">
                    {archivedSessions.map((session) => (
                      <div className="archived-item" key={session.id}>
                        <span>
                          <strong>{sessionName(session)}</strong>
                          <small>
                            {session.provider} · archived{" "}
                            {new Date(session.archivedAt!).toLocaleDateString()}
                          </small>
                        </span>
                        <button
                          disabled={busy}
                          onClick={() => void restoreSession(session)}
                        >
                          Restore &amp; resume
                        </button>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </section>

        {workspace && (view === "board" || view === "sessions") && (
          <div
            aria-label={`Resize ${view === "board" ? "task inspector" : "sessions"} panel`}
            aria-orientation="vertical"
            aria-valuemax={720}
            aria-valuemin={PANEL_RAIL_WIDTH}
            aria-valuenow={
              view === "board" ? boardDetailPanelWidth : sessionsPanelWidth
            }
            className="column-resize-handle secondary-panel-resize-handle"
            onDoubleClick={
              view === "board" ? toggleBoardDetailPanel : toggleSessionsPanel
            }
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                return;
              event.preventDefault();
              const movement =
                event.key === "ArrowRight" ? PANEL_STEP : -PANEL_STEP;
              if (view === "board")
                setBoardDetailPanelWidth((width) =>
                  clampPanelSize(width - movement, 720),
                );
              else
                setSessionsPanelWidth((width) =>
                  clampPanelSize(width + movement, 720),
                );
            }}
            onPointerDown={(event) => startColumnResize(event, "secondary")}
            role="separator"
            tabIndex={0}
          />
        )}

        {view === "board" && workspace && (
          <aside
            className={`board-detail-column ${boardDetailPanelWidth < PANEL_COMPACT_THRESHOLD ? "panel-compact" : ""}`}
          >
            <div className="section-heading">
              <div>
                <span className="eyebrow">Inspector</span>
                <h1>Task brief</h1>
              </div>
              <div className="panel-heading-actions">
                {selectedTask && (
                  <button
                    className="quiet"
                    onClick={() => setEditingTask((current) => !current)}
                  >
                    {editingTask ? "Cancel" : "Edit"}
                  </button>
                )}
                <PanelCollapseButton
                  collapsed={boardDetailPanelWidth < PANEL_COMPACT_THRESHOLD}
                  label="task inspector"
                  onClick={toggleBoardDetailPanel}
                  side="right"
                />
              </div>
            </div>
            {taskInspector}
          </aside>
        )}

        {view === "sessions" && workspace && (
          <section className="terminal-column">
            <div className="terminal-heading">
              <div>
                <span className="eyebrow">Terminal</span>
                <h1>
                  {activeSession ? (
                    <>
                      {sessionName(activeSession)}
                      {activeSessionModel && (
                        <small className="terminal-heading-model">
                          {activeSessionModel}
                        </small>
                      )}
                    </>
                  ) : (
                    "No session selected"
                  )}
                </h1>
              </div>
              {activeSession && <small>{activeSession.status}</small>}
            </div>
            {activeSession ? (
              <TerminalSurface
                focused
                fitRevision={terminalFitRevision}
                id={activeSession.id}
                key={`${activeSession.id}:${terminalMountRevision}`}
                label={sessionName(activeSession)}
                locationLabel={activeSessionRepository?.name ?? workspace.name}
                onOpenLink={openTerminalLink}
                session={activeSession}
                status={activeSession.status}
                target="agent"
                telemetry={activeSessionTelemetry}
                worktree={activeSessionWorktree}
              />
            ) : (
              <div className="terminal-empty">
                <strong>Select a session</strong>
                <span>
                  Choose a card or create a new agent or free terminal.
                </span>
              </div>
            )}
          </section>
        )}
      </div>

      <section
        aria-label="Integrated terminal"
        className={`integrated-terminal-panel ${terminalPanelOpen ? "open" : "collapsed"}`}
      >
        {terminalPanelOpen && (
          <div
            aria-label="Resize integrated terminal"
            aria-orientation="horizontal"
            aria-valuemax={
              typeof window === "undefined"
                ? 720
                : Math.max(TERMINAL_PANEL_MIN_HEIGHT, window.innerHeight - 280)
            }
            aria-valuemin={TERMINAL_PANEL_MIN_HEIGHT}
            aria-valuenow={terminalPanelHeight}
            className="integrated-terminal-resize-handle"
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              setTerminalPanelHeight((height) =>
                clampTerminalPanelHeight(
                  height + (event.key === "ArrowUp" ? 24 : -24),
                ),
              );
            }}
            onPointerDown={startTerminalPanelResize}
            role="separator"
            tabIndex={0}
          />
        )}
        <div className="integrated-terminal-header">
          <button
            aria-label="Open settings"
            className="quiet settings-corner-button"
            onClick={() => setModal("settings")}
            title="Settings"
            type="button"
          >
            <SettingsIcon />
          </button>
          <button
            aria-expanded={terminalPanelOpen}
            className="integrated-terminal-toggle"
            onClick={() => setTerminalPanelOpen((current) => !current)}
            type="button"
          >
            <SessionLaunchIcon />
            <strong>Terminal</strong>
            <span className="count-badge">{integratedTerminals.length}</span>
          </button>
          {(snapshot?.providerUsage.length ?? 0) > 0 && (
            <div className="provider-usage" aria-label="Provider usage">
              {snapshot!.providerUsage.map((usage) => (
                <span
                  className="provider-usage-item"
                  data-provider={usage.provider}
                  key={usage.provider}
                >
                  <strong>{providerLabel(usage.provider)}</strong>
                  {usage.windows.map((window, index) => (
                    <span key={window.label}>
                      {index > 0 && (
                        <span className="provider-usage-dot">·</span>
                      )}
                      {window.label} {Math.round(window.usedPercent)}%
                    </span>
                  ))}
                </span>
              ))}
            </div>
          )}
          <div className="integrated-terminal-actions">
            <button
              aria-label="New terminal in Daedalus home"
              className="quiet"
              disabled={busy || !snapshot?.settings.tmuxAvailable}
              onClick={() => void createIntegratedTerminal()}
              title={`New terminal in ${snapshot?.settings.home ?? "Daedalus home"}`}
              type="button"
            >
              +
            </button>
            {terminalPanelOpen && (
              <button
                aria-label="Collapse integrated terminal"
                className="quiet"
                onClick={() => setTerminalPanelOpen(false)}
                title="Collapse terminal"
                type="button"
              >
                ⌄
              </button>
            )}
          </div>
        </div>
        <div className="integrated-terminal-body">
          <div className="integrated-terminal-stage">
            {activeIntegratedTerminal
              ? integratedTerminals.map((terminal) => (
                  <IntegratedTerminalSurface
                    active={
                      terminalPanelOpen &&
                      terminal.id === activeIntegratedTerminal.id
                    }
                    fitRevision={terminalFitRevision}
                    key={terminal.id}
                    mountRevision={terminalMountRevision}
                    onOpenLink={openTerminalLink}
                    terminal={terminal}
                  />
                ))
              : terminalPanelOpen && (
                  <div className="terminal-empty integrated-terminal-empty">
                    <strong>No terminals open</strong>
                    <span>
                      Create one in the Daedalus home or from a workspace card.
                    </span>
                  </div>
                )}
          </div>
          {terminalPanelOpen && integratedTerminals.length > 0 && (
            <div
              aria-label="Terminal tabs"
              className="integrated-terminal-tabs"
              role="tablist"
            >
              {integratedTerminals.map((terminal) => (
                <div
                  className={`integrated-terminal-tab ${terminal.id === activeIntegratedTerminal?.id ? "active" : ""}`}
                  key={terminal.id}
                >
                  <button
                    aria-label={`${terminal.name}, ${terminal.workingDirectory}`}
                    aria-selected={terminal.id === activeIntegratedTerminal?.id}
                    onClick={() => setActiveTerminalId(terminal.id)}
                    role="tab"
                    title={terminal.workingDirectory}
                    type="button"
                  >
                    <span className={`agent-dot ${terminal.status}`} />
                    <span className="integrated-terminal-tab-copy">
                      <strong>{terminal.name}</strong>
                      <small>
                        {terminalPathHint(
                          terminal.workingDirectory,
                          snapshot?.settings.home,
                        )}
                      </small>
                    </span>
                  </button>
                  <button
                    aria-label={`Close ${terminal.name} terminal`}
                    className="integrated-terminal-close"
                    disabled={busy}
                    onClick={() => void closeIntegratedTerminal(terminal)}
                    title="Close terminal"
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {modal === "workspace" && (
        <Modal onClose={() => setModal(undefined)} title="Create workspace">
          <form className="modal-form" onSubmit={createWorkspace}>
            <label>
              Name
              <input
                autoFocus
                required
                value={workspaceForm.name}
                onChange={(event) =>
                  setWorkspaceForm({
                    ...workspaceForm,
                    name: event.target.value,
                  })
                }
                placeholder="My project"
              />
            </label>
            <label>
              Slug <small>optional</small>
              <input
                value={workspaceForm.slug}
                onChange={(event) =>
                  setWorkspaceForm({
                    ...workspaceForm,
                    slug: event.target.value,
                  })
                }
                placeholder="my-project"
              />
            </label>
            <label>
              Custom path <small>optional</small>
              <input
                value={workspaceForm.path}
                onChange={(event) =>
                  setWorkspaceForm({
                    ...workspaceForm,
                    path: event.target.value,
                  })
                }
                placeholder={snapshot?.settings.workspaceRoot}
              />
            </label>
            <div className="modal-actions">
              <button
                className="quiet"
                onClick={() => setModal(undefined)}
                type="button"
              >
                Cancel
              </button>
              <button disabled={busy} type="submit">
                Create workspace
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === "task" && workspace && (
        <Modal onClose={() => setModal(undefined)} title="Create task">
          <form className="modal-form" onSubmit={createTask}>
            <label>
              Title
              <input
                autoFocus
                required
                value={taskForm.title}
                onChange={(event) =>
                  setTaskForm({ ...taskForm, title: event.target.value })
                }
                placeholder="What needs to be done?"
              />
            </label>
            <label>
              Task brief <small>Markdown</small>
              <textarea
                value={taskForm.description}
                onChange={(event) =>
                  setTaskForm({ ...taskForm, description: event.target.value })
                }
                rows={7}
              />
            </label>
            <div className="modal-actions">
              <button
                className="quiet"
                onClick={() => setModal(undefined)}
                type="button"
              >
                Cancel
              </button>
              <button disabled={busy} type="submit">
                Create task
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === "repository" && workspace && (
        <Modal
          dismissible={!busy}
          onClose={closeRepositoryModal}
          title={
            repositoryOperations.length
              ? "Adding repositories"
              : "Add repositories"
          }
          wide
        >
          <form className="repository-picker" onSubmit={addRemoteRepository}>
            {repositoryOperations.length ? (
              <section
                aria-busy={busy}
                className="repository-add-progress"
                aria-label="Repository progress"
              >
                <div className="repository-progress-summary" role="status">
                  <strong>
                    {repositoryOperationFinished
                      ? failedRepositoryOperations
                        ? `${completedRepositoryOperations} added, ${failedRepositoryOperations} failed`
                        : `${completedRepositoryOperations} ${completedRepositoryOperations === 1 ? "repository" : "repositories"} added`
                      : activeRepositoryOperation
                        ? `${activeRepositoryOperation.status === "cloning" ? "Cloning" : "Adding"} ${activeRepositoryOperation.name}`
                        : "Preparing repositories…"}
                  </strong>
                  <span>
                    {repositoryOperationFinished
                      ? failedRepositoryOperations
                        ? "Review the errors below, then retry the failed repositories."
                        : "Everything is ready in this workspace."
                      : `${completedRepositoryOperations + failedRepositoryOperations} of ${repositoryOperations.length} complete`}
                  </span>
                </div>
                <div
                  aria-label={`${completedRepositoryOperations + failedRepositoryOperations} of ${repositoryOperations.length} repositories complete`}
                  aria-valuemax={repositoryOperations.length}
                  aria-valuemin={0}
                  aria-valuenow={
                    completedRepositoryOperations + failedRepositoryOperations
                  }
                  className="repository-progress-track"
                  role="progressbar"
                >
                  <span
                    style={{
                      width: `${((completedRepositoryOperations + failedRepositoryOperations) / repositoryOperations.length) * 100}%`,
                    }}
                  />
                </div>
                <div className="repository-operation-list">
                  {repositoryOperations.map((operation) => (
                    <div
                      className={`repository-operation ${operation.status}`}
                      key={operation.key}
                    >
                      <span
                        aria-hidden="true"
                        className="repository-operation-indicator"
                      >
                        {operation.status === "done"
                          ? "✓"
                          : operation.status === "error"
                            ? "!"
                            : operation.status === "queued"
                              ? "·"
                              : ""}
                      </span>
                      <span>
                        <strong>{operation.name}</strong>
                        <small>{operation.error ?? operation.detail}</small>
                      </span>
                      <small className="repository-operation-status">
                        {operation.status === "cloning"
                          ? "Cloning…"
                          : operation.status === "attaching"
                            ? "Adding…"
                            : operation.status === "done"
                              ? "Added"
                              : operation.status === "error"
                                ? "Failed"
                                : "Waiting"}
                      </small>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <>
                <p className="repository-picker-intro">
                  Select repositories already in Daedalus, discover them through
                  GitHub, or clone from a URL or full local path.
                </p>
                <label className="repository-unified-search">
                  Repository
                  <div className="repository-clone-row">
                    <input
                      autoFocus
                      aria-label="Search repositories or enter a Git URL or absolute local repository path"
                      placeholder="Search repositories, paste a Git URL, or enter /full/path"
                      value={repositoryForm.search}
                      onChange={(event) =>
                        setRepositoryForm({
                          remoteUrl: event.target.value,
                          search: event.target.value,
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          setActiveRepositoryResult((current) =>
                            Math.min(
                              current + 1,
                              repositoryCandidates.length - 1,
                            ),
                          );
                        } else if (event.key === "ArrowUp") {
                          event.preventDefault();
                          setActiveRepositoryResult((current) =>
                            Math.max(current - 1, 0),
                          );
                        } else if (
                          event.key === "Enter" &&
                          !looksLikeRepositorySource(repositoryForm.search)
                        ) {
                          event.preventDefault();
                          toggleRepositoryCandidate(activeRepositoryResult);
                        }
                      }}
                    />
                    <button
                      className="quiet"
                      disabled={
                        busy ||
                        !looksLikeRepositorySource(repositoryForm.search)
                      }
                      type="submit"
                    >
                      Clone URL/path
                    </button>
                  </div>
                </label>

                <div className="repository-picker-results repository-unified-results">
                  <div className="repository-result-summary">
                    <span>
                      {repositorySearch ? "Best matches" : "All repositories"}
                    </span>
                    <small>
                      {repositoryCandidates.length}
                      {repositoryDiscoveryLoading
                        ? " + discovering GitHub…"
                        : ""}
                    </small>
                  </div>
                  {repositoryCandidates.map((candidate, index) => {
                    if (candidate.kind === "library") {
                      const repository = candidate.repository;
                      return (
                        <button
                          aria-checked={
                            attachedLibraryRepositoryIds.has(repository.id) ||
                            selectedRepositoryIds.has(repository.id)
                          }
                          className={`${selectedRepositoryIds.has(repository.id) ? "selected" : ""} ${attachedLibraryRepositoryIds.has(repository.id) ? "attached" : ""} ${activeRepositoryResult === index ? "active" : ""}`}
                          disabled={
                            busy ||
                            attachedLibraryRepositoryIds.has(repository.id)
                          }
                          key={repository.id}
                          onClick={() => toggleRepositoryCandidate(index)}
                          onMouseEnter={() => setActiveRepositoryResult(index)}
                          role="checkbox"
                          type="button"
                        >
                          <span
                            aria-hidden="true"
                            className="repository-picker-check"
                          >
                            {attachedLibraryRepositoryIds.has(repository.id) ||
                            selectedRepositoryIds.has(repository.id)
                              ? "✓"
                              : ""}
                          </span>
                          <span>
                            <strong>{repository.name}</strong>
                            <small>{repository.remoteUrl}</small>
                          </span>
                          <span>
                            <strong>
                              {attachedLibraryRepositoryIds.has(repository.id)
                                ? "Added"
                                : repository.defaultBranch}
                            </strong>
                            <small>Local</small>
                          </span>
                        </button>
                      );
                    }
                    const repository = candidate.repository;
                    return (
                      <button
                        aria-checked={selectedGitHubRepositories.has(
                          repository.nameWithOwner,
                        )}
                        className={`${selectedGitHubRepositories.has(repository.nameWithOwner) ? "selected" : ""} ${activeRepositoryResult === index ? "active" : ""}`}
                        disabled={busy}
                        key={`github:${repository.nameWithOwner}`}
                        onClick={() => toggleRepositoryCandidate(index)}
                        onMouseEnter={() => setActiveRepositoryResult(index)}
                        role="checkbox"
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className="repository-picker-check"
                        >
                          {selectedGitHubRepositories.has(
                            repository.nameWithOwner,
                          )
                            ? "✓"
                            : ""}
                        </span>
                        <span>
                          <strong>{repository.name}</strong>
                          <small>{repository.nameWithOwner}</small>
                        </span>
                        <span>
                          <strong>GitHub</strong>
                          <small>Will clone</small>
                        </span>
                      </button>
                    );
                  })}
                  {repositoryDiscoveryLoading ? (
                    <div className="empty">Discovering repositories…</div>
                  ) : repositoryDiscovery?.authenticated &&
                    !repositoryDiscovery.error ? (
                    repositoryCandidates.length === 0 ? (
                      <div className="empty">
                        {repositorySearch
                          ? "No matching repositories"
                          : "No repositories available"}
                      </div>
                    ) : null
                  ) : (
                    <div className="repository-discovery-message">
                      {repositoryDiscovery?.error &&
                      repositoryDiscovery.authenticated ? (
                        <>
                          <strong>GitHub discovery unavailable</strong>
                          <span>{repositoryDiscovery.error}</span>
                        </>
                      ) : !repositoryDiscovery?.githubCliAvailable ? (
                        <>
                          <strong>GitHub CLI not found</strong>
                          <span>
                            Install `gh` to discover repositories you can access
                            automatically.
                          </span>
                        </>
                      ) : (
                        <>
                          <strong>GitHub sign-in required</strong>
                          <span>
                            Run `gh auth login`, then reopen this picker.
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <small className="repository-clone-destination">
                  New clones are stored once in{" "}
                  {snapshot?.settings.repositoryRoot}.
                </small>
              </>
            )}
            <div className="modal-actions">
              {repositoryOperations.length ? (
                <span className="repository-selection-count">
                  {busy
                    ? "Keep this window open while repositories are prepared."
                    : failedRepositoryOperations
                      ? "Completed repositories will not be repeated."
                      : "Repository setup complete."}
                </span>
              ) : (
                <span className="repository-selection-count">
                  {selectedRepositoryCount
                    ? `${selectedRepositoryCount} selected`
                    : "Select one or more repositories"}
                </span>
              )}
              {(!repositoryOperations.length ||
                (repositoryOperationFinished &&
                  failedRepositoryOperations > 0)) && (
                <button
                  className="quiet"
                  onClick={closeRepositoryModal}
                  type="button"
                >
                  {repositoryOperations.length ? "Close" : "Cancel"}
                </button>
              )}
              {repositoryOperations.length ? (
                failedRepositoryOperations > 0 && !busy ? (
                  <button
                    disabled={selectedRepositoryCount === 0}
                    onClick={() => void attachSelectedRepositories()}
                    type="button"
                  >
                    Retry failed
                  </button>
                ) : repositoryOperationFinished ? (
                  <button onClick={closeRepositoryModal} type="button">
                    Done
                  </button>
                ) : null
              ) : (
                <button
                  disabled={busy || selectedRepositoryCount === 0}
                  onClick={() => void attachSelectedRepositories()}
                  type="button"
                >
                  {selectedRepositoryCount === 1
                    ? "Add repository"
                    : selectedRepositoryCount > 1
                      ? `Add ${selectedRepositoryCount} repositories`
                      : "Add selected"}
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}

      {modal === "session" && workspace && snapshot && (
        <Modal dismissible onClose={closeSessionModal} title="Create session">
          <form className="modal-form" onSubmit={createSession}>
            <label>
              Session name
              <input
                autoFocus
                maxLength={240}
                onChange={(event) =>
                  setSessionForm({ ...sessionForm, name: event.target.value })
                }
                placeholder="What is this session for?"
                required
                value={sessionForm.name}
              />
            </label>
            <fieldset className="session-tool-picker">
              <legend>Choose a tool</legend>
              <div
                aria-label="Session tool"
                className="session-tool-row"
                role="radiogroup"
              >
                {(
                  [
                    { id: "codex", label: "Codex" },
                    { id: "claude", label: "Claude" },
                    { id: "terminal", label: "Terminal" },
                  ] as const
                ).map((tool) => {
                  const available =
                    tool.id === "terminal" ||
                    Boolean(
                      snapshot.settings.providers.find(
                        (item) => item.name === tool.id,
                      )?.available,
                    );
                  return (
                    <button
                      aria-checked={sessionType === tool.id}
                      className={`session-tool ${sessionType === tool.id ? "selected" : ""}`}
                      disabled={!available}
                      key={tool.id}
                      onClick={() => {
                        setSessionType(tool.id);
                        setSessionModel("");
                        setModelCatalogError(undefined);
                      }}
                      role="radio"
                      type="button"
                    >
                      <span className={`session-tool-icon tool-${tool.id}`}>
                        <ToolIcon tool={tool.id} />
                      </span>
                      <strong>{tool.label}</strong>
                      <small>{available ? "Available" : "Unavailable"}</small>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            {sessionType !== "terminal" && (
              <label className="session-model-picker">
                <span>
                  <strong>Model</strong>
                  <small>
                    {sessionModelCatalogPending || modelCatalogLoading
                      ? `Loading ${sessionType === "claude" ? "Claude" : "Codex"} models…`
                      : sessionType === "codex"
                        ? "Available to your Codex account"
                        : "Available to your Claude account"}
                  </small>
                </span>
                <select
                  disabled={sessionModelCatalogPending || modelCatalogLoading}
                  onChange={(event) => setSessionModel(event.target.value)}
                  value={sessionModel}
                >
                  {sessionModelCatalogPending || modelCatalogLoading ? (
                    <option value="">Loading models…</option>
                  ) : (
                    <option value="">
                      Provider default
                      {sessionModelCatalog?.defaultModel
                        ? ` · ${sessionDefaultModel?.label ?? sessionModelCatalog.defaultModel}`
                        : " · Automatic"}
                    </option>
                  )}
                  {sessionModelCatalog?.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                      {model.resolvedModel ? ` · ${model.resolvedModel}` : ""}
                    </option>
                  ))}
                </select>
                <small className="session-model-description">
                  {sessionModelCatalogPending || modelCatalogLoading
                    ? "Reading the models available to your account"
                    : (selectedSessionModel?.description ??
                      (sessionModel
                        ? `Use ${sessionModel} for this session`
                        : sessionModelCatalog?.defaultModel
                          ? "Follows your provider configuration"
                          : "The provider chooses its current default"))}
                </small>
                {modelCatalogError && (
                  <small className="session-model-error">
                    Model list unavailable: {modelCatalogError}
                  </small>
                )}
              </label>
            )}
            <div className="session-workspace-note">
              <span className="workspace-icon">
                {workspace.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{workspace.name}</strong>
                <small>Opens in {workspace.path}</small>
              </span>
            </div>
            <div className="modal-actions">
              <button
                className="quiet"
                onClick={closeSessionModal}
                type="button"
              >
                Cancel
              </button>
              <button disabled={busy} type="submit">
                Create session
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === "settings" && snapshot && (
        <Modal onClose={() => setModal(undefined)} title="Settings">
          <dl className="settings-list">
            <dt>Daedalus home</dt>
            <dd>{snapshot.settings.home}</dd>
            <dt>Workspace root</dt>
            <dd>{snapshot.settings.workspaceRoot}</dd>
            <dt>Database</dt>
            <dd>{snapshot.settings.databasePath}</dd>
            <dt>tmux</dt>
            <dd>{snapshot.settings.tmuxVersion ?? "Not found"}</dd>
            <dt>Theme</dt>
            <dd>
              <select
                aria-label="Theme"
                value={theme}
                onChange={(event) => {
                  const value = event.target.value as "dark" | "light";
                  setTheme(value);
                  window.localStorage.setItem("daedalus.theme", value);
                }}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </dd>
            <dt>Agent context</dt>
            <dd>
              <label className="settings-toggle">
                <input
                  checked={snapshot.settings.workspaceInstructionFilesEnabled}
                  disabled={busy}
                  onChange={(event) =>
                    void perform(
                      client.request.workspaceInstructionFilesSet({
                        enabled: event.target.checked,
                      }),
                    )
                  }
                  type="checkbox"
                />
                <span>
                  <strong>Create workspace agent guidance</strong>
                  <small>
                    Keep Daedalus-managed AGENTS.md, CLAUDE.md, and the
                    daedalus-control skill links in workspace roots.
                  </small>
                </span>
              </label>
            </dd>
          </dl>
          <h3>Agent executables</h3>
          <div className="provider-grid">
            {snapshot.settings.providers.map((item) => (
              <div key={item.name}>
                <span
                  className={`agent-dot ${item.available ? "running" : "lost"}`}
                />
                <strong>{item.name}</strong>
                <code>{item.executable}</code>
                <small>
                  {item.available ? "Available" : "Not found on PATH"}
                </small>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {sessionAction && (
        <Modal
          onClose={() => setSessionAction(undefined)}
          title="Archive session"
        >
          <div className="confirmation-content">
            <p>
              Archive <strong>{sessionName(sessionAction.session)}</strong>?
              Running work will stop, but its conversation can be restored and
              resumed later.
            </p>
            <div className="modal-actions">
              <button
                className="quiet"
                onClick={() => setSessionAction(undefined)}
                type="button"
              >
                Cancel
              </button>
              <button
                autoFocus
                className="danger-action"
                disabled={busy}
                onClick={() => void archiveSession(sessionAction.session)}
                type="button"
              >
                Archive session
              </button>
            </div>
          </div>
        </Modal>
      )}

      {workspaceAction && (
        <Modal
          onClose={() => setWorkspaceAction(undefined)}
          title="Archive workspace"
        >
          <form
            className="confirmation-content"
            onSubmit={(event) => {
              event.preventDefault();
              void archiveWorkspace(workspaceAction);
            }}
          >
            <p>
              Archive <strong>{workspaceAction.name}</strong>? All sessions in
              this workspace will stop and move to their archived list. You can
              restore the workspace and resume its sessions later.
            </p>
            <div className="modal-actions">
              <button
                className="quiet"
                onClick={() => setWorkspaceAction(undefined)}
                type="button"
              >
                Cancel
              </button>
              <button
                autoFocus
                className="danger-action"
                disabled={busy}
                type="submit"
              >
                Archive workspace
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}

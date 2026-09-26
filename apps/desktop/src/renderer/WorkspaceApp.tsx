import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { basicSetup, EditorView } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  TaskTimelineDto,
  AgentActivity,
  AgentActivityDto,
  AgentSessionDto,
  AttentionReasonDto,
  DesktopCommand,
  DesktopSnapshotDto,
  GitStatusDto,
  IntegratedTerminalDto,
  ProviderModelCatalogDto,
  SessionTelemetryDto,
  SessionWorktreeDto,
  QuitChoice,
  RepositoryDiscoveryDto,
  RpcResult,
  SessionAttentionDto,
  ShutdownPlanDto,
  TaskDto,
  WorkspaceContentDto,
  WorkspaceFileChangeDto,
  WorkspaceFileDto,
  WorkspaceFileEntryDto,
  WorkspaceDto,
  ToastDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { SettingsModal, type SettingsSection } from "./SettingsModal";
import { runWithConcurrency } from "./concurrency";
import { repositoryFuzzyScore } from "./repository-search";
import { useListReorder } from "./use-list-reorder";
import { BoardView, TaskRelationsBlock, type BoardProvider } from "./BoardView";
import { laneFor } from "./board-lanes";
import { taskActions } from "./task-actions";
import { TaskCostLine, TaskTimeline } from "./TaskTimeline";
import { TaskActionBar } from "./TaskActionBar";
import { TaskPriorityMenu, TaskStatusMenu } from "./TaskStatusMenu";
import {
  AgentStatusDot,
  compactTokenLabel,
  lifecycleTone,
  CreateButton,
  providerLabel,
  SessionLaunchIcon,
  sessionConfiguredModel,
  sessionIsLive,
  sessionName,
  sessionStatusView,
  sessionTool,
  statusAriaLabel,
  ToolIcon,
  waitingLabel,
  type SessionStatusView,
} from "./session-view";

// The indicator vocabulary moved to `session-view.tsx`; these stay importable
// from here because the tests and harnesses have always found them here.
export {
  lifecycleTone,
  sessionStatusView,
  statusAriaLabel,
  waitingLabel,
  type SessionStatusView,
  type SessionTone,
} from "./session-view";

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

export const EXPLORER_MIN_WIDTH = 170;
export const EXPLORER_MAX_WIDTH = 560;
export const EXPLORER_DEFAULT_WIDTH = 255;
// The file viewer next to the explorer stops being a viewer below this.
const EXPLORER_VIEWER_MIN_WIDTH = 300;

export const clampExplorerWidth = (width: number, available: number) =>
  Math.min(
    Math.max(EXPLORER_MIN_WIDTH, Math.round(width)),
    Math.max(EXPLORER_MIN_WIDTH, Math.min(EXPLORER_MAX_WIDTH, available)),
  );

const lastSessionStorageKey = (workspaceId: string) =>
  `daedalus.session.last.${workspaceId}`;

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

const rememberedExpandedDirectories = (workspaceId: string) => {
  if (typeof window === "undefined") return [];
  try {
    return parseRememberedDirectories(
      window.localStorage.getItem(expandedDirectoriesStorageKey(workspaceId)),
    );
  } catch {
    return [];
  }
};

const rememberExpandedDirectories = (
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

const lastViewStorageKey = (workspaceId: string) =>
  `daedalus.view.last.${workspaceId}`;

export type WorkspaceView = "board" | "sessions" | "workspace";

/**
 * What the main column shows: one workspace, or every active workspace at
 * once (#35). The board and the Sessions list read the same snapshot either
 * way; "all" only stops filtering it. Files, repositories and settings stay
 * per workspace, because none of them has a meaning across several.
 */
export type WorkspaceScope = "workspace" | "all";

/**
 * The key remembered views and sessions are filed under when every workspace
 * is showing. A real id can never collide with it: ids are UUIDs.
 */
export const ALL_WORKSPACES_SCOPE_KEY = "all";

/** The views that exist when every workspace is showing. */
export function preferredScopeView(
  scope: WorkspaceScope,
  rememberedView?: string | null,
): WorkspaceView {
  const preferred = preferredWorkspaceView(rememberedView);
  return scope === "all" && preferred === "workspace" ? "board" : preferred;
}

export function preferredWorkspaceView(
  rememberedView?: string | null,
): WorkspaceView {
  // Board first, and first by default. The board is where a dispatcher starts
  // the day, and since #27 it also holds the repositories and the add button,
  // so a workspace with nothing attached yet is fixed from here too.
  return rememberedView === "sessions" || rememberedView === "workspace"
    ? rememberedView
    : "board";
}

const rememberedWorkspaceView = (workspaceId?: string) => {
  if (!workspaceId || typeof window === "undefined") return undefined;
  return window.localStorage.getItem(lastViewStorageKey(workspaceId));
};

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

// Selecting a session and focusing its terminal are different things. A
// session becomes active for many reasons Daedalus decides on its own —
// startup restore, `preferredSessionId`, a session spawned from the CLI — and
// none of those may take the keyboard away from what the user is doing. Focus
// is granted only to the session the user just opened in this window, and only
// until the caret lands there. The one thing that may ask on the user's behalf
// is a remount of a terminal that was holding the caret already, which is
// giving something back rather than taking it.
export function shouldFocusSession(
  focusRequestId: string | undefined,
  activeSessionId: string | undefined,
): boolean {
  return Boolean(
    focusRequestId && activeSessionId && focusRequestId === activeSessionId,
  );
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

// A launch card stands in for a session that does not exist yet. Once the
// launch has produced a session row it is that row's job to represent it —
// including after the row is archived, which is how a user clears a session
// that failed to start. Matching only live sessions resurrected the launch
// card the moment its session was archived, leaving a "Failed to start" card
// that nothing in the UI could remove.
export function pendingSessionLaunches(
  launches: SessionLaunchState[],
  workspaceSessions: AgentSessionDto[],
): SessionLaunchState[] {
  const liveSessions = workspaceSessions.filter(
    (session) => !session.archivedAt,
  );
  return launches.filter(
    (launch) =>
      !workspaceSessions.some((session) => session.id === launch.sessionId) &&
      !liveSessions.some((session) => launchMatchesSession(launch, session)),
  );
}

// Bounded so a multi-repository add is not N serial clones, without opening
// every network and disk stream at once either.
const REPOSITORY_ADD_CONCURRENCY = 4;

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

const workspaceParentPath = (path: string) => {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
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

/** A baton passing forward: the work continues with someone new. */
function HandoffIcon() {
  return (
    <svg
      aria-hidden="true"
      className="handoff-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <path d="M3 12h9" />
      <path d="M9 8l4 4-4 4" />
      <rect height="14" rx="2.5" width="6" x="15" y="5" />
    </svg>
  );
}

/** Four tiles: every workspace at once. */
function AllWorkspacesIcon() {
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
      <rect height="7" rx="1.5" width="7" x="3" y="3" />
      <rect height="7" rx="1.5" width="7" x="14" y="3" />
      <rect height="7" rx="1.5" width="7" x="3" y="14" />
      <rect height="7" rx="1.5" width="7" x="14" y="14" />
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

function DismissIcon() {
  return (
    <svg
      aria-hidden="true"
      className="dismiss-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <path d="M6 6l12 12M18 6L6 18" />
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

// VS Code Codicons sync glyph (MIT).
function RepositoryFetchIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 16 16">
      <path d="M2.006 8.267 0 9.098l3.622 3.856.348-.153 4.006-1.657-2.8-.687a5.028 5.028 0 0 1 3.97-5.797 5 5 0 0 1 4.516 1.61l.847-.847a6.19 6.19 0 0 0-5.582-1.985A6.22 6.22 0 0 0 4.11 9.142l-2.104-.875Zm11.988-.534L16 6.902 12.378 3.05l-.348.153-4.006 1.657 2.8.687a5.03 5.03 0 0 1-3.97 5.797 5 5 0 0 1-4.516-1.61l-.847.847a6.19 6.19 0 0 0 5.582 1.985 6.22 6.22 0 0 0 4.817-6.704l2.104.871Z" />
    </svg>
  );
}

// VS Code Codicons repo-push glyph (MIT).
function RepositoryPushIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 16 16">
      <path d="M7.65 1.15A.49.49 0 0 1 8 1c.128 0 .255.05.35.15l3 3a.49.49 0 0 1 .15.35.49.49 0 0 1-.15.35.49.49 0 0 1-.35.15.49.49 0 0 1-.35-.15L8.5 2.71V9.5a.5.5 0 0 1-1 0V2.71L5.35 4.85a.49.49 0 0 1-.35.15.49.49 0 0 1-.35-.15.49.49 0 0 1-.15-.35c0-.127.05-.255.15-.35l3-3Z" />
      <path
        clipRule="evenodd"
        d="M9.95 13h2.55a.5.5 0 0 1 0 1H9.95A2.5 2.5 0 0 1 5.05 14H2.5a.5.5 0 0 1 0-1h2.55a2.5 2.5 0 0 1 4.9 0ZM6.09 14A1.5 1.5 0 0 0 9 13.5 1.5 1.5 0 0 0 6 13.5c0 .18.03.34.09.5Z"
        fillRule="evenodd"
      />
    </svg>
  );
}

// VS Code Codicons terminal glyph (MIT).
function TerminalIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 16 16">
      <path d="M1.5 2h13l.5.5v11l-.5.5h-13l-.5-.5v-11l.5-.5ZM2 13h12V3H2v10Zm3.56-3.05L7.5 8 5.56 6.05l.7-.7 2.3 2.3v.7l-2.3 2.3-.7-.7ZM8 10h4v1H8v-1Z" />
    </svg>
  );
}

function repositoryStatusText(
  status: WorkspaceContentDto["repositories"][number]["gitStatus"],
) {
  // Not measured yet is not the same as cannot be measured. The listing no
  // longer waits for git, so an unmeasured row says nothing for a moment
  // rather than claiming its status is unavailable and then correcting itself.
  if (!status) return "…";
  if (status.state === "unavailable") return "Status unavailable";
  if (status.state === "modified")
    return `${status.changedFiles} ${status.changedFiles === 1 ? "change" : "changes"}`;
  if (status.state === "diverged") return `↑${status.ahead} ↓${status.behind}`;
  if (status.state === "ahead") return `↑${status.ahead} ahead`;
  if (status.state === "behind") return `↓${status.behind} behind`;
  return "Clean";
}

// The diff shape, in the order it reads: what is uncommitted here, then how
// far this tree has moved from the branch it started on.
function gitStatusParts(status: GitStatusDto | undefined) {
  if (!status || status.state === "unavailable") return [];
  const parts: Array<{ key: string; tone: string; text: string }> = [];
  if (status.changedFiles)
    parts.push({
      key: "changed",
      tone: "modified",
      text: `~${status.changedFiles}`,
    });
  if (status.ahead)
    parts.push({ key: "ahead", tone: "ahead", text: `↑${status.ahead}` });
  if (status.behind)
    parts.push({ key: "behind", tone: "behind", text: `↓${status.behind}` });
  if (parts.length === 0)
    parts.push({ key: "clean", tone: "clean", text: "clean" });
  return parts;
}

const sessionNeedsAttention = (view: SessionStatusView) => view.attention;

/**
 * Three, not five. Both Sonner's default and the UX literature land on the
 * same number: past three, a stack stops being read and starts being
 * dismissed unread.
 */
export const MAX_VISIBLE_TOASTS = 3;

/** Long enough to read a title and a line; Sonner uses four. */
const TOAST_DURATION_MS = 5_000;

/** How far each receding layer drops, and how much it shrinks. */
export const TOAST_LIFT = 14;
const TOAST_SCALE_STEP = 0.05;

/** Space between toasts once the deck is fanned out. */
const TOAST_GAP = 10;

/**
 * Ephemeral by contract: a toast is for something worth seeing but not worth
 * chasing. Anything the user must come back to is a badge, so a toast that
 * times out has lost nothing.
 *
 * They are drawn as a *deck* rather than a list. Three separate cards stacked
 * down the corner cover the thing the user is trying to read, which is how a
 * notification turns into an obstacle; collapsed, the whole stack costs the
 * height of one card plus a sliver per toast behind it. Pointing at it fans
 * the deck out and pauses every countdown, so reading them is never a race.
 */
function ToastStack({
  onDismiss,
  onOpen,
  toasts,
}: {
  onDismiss: (ids: string[]) => void;
  onOpen: (toast: ToastDto) => void;
  toasts: ToastDto[];
}) {
  const visible = toasts.slice(0, MAX_VISIBLE_TOASTS);
  const key = visible.map((toast) => toast.id).join(",");
  const [expanded, setExpanded] = useState(false);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const deadlines = useRef(new Map<string, number>());
  const pausedAt = useRef<number | null>(null);

  // Measured rather than assumed: a wrapped title makes one card taller than
  // its neighbours, and the fanned-out offsets have to account for it.
  useLayoutEffect(() => {
    const measured: Record<string, number> = {};
    for (const [id, node] of nodes.current)
      if (node.isConnected) measured[id] = node.offsetHeight;
    setHeights((previous) => {
      const ids = Object.keys(measured);
      const same =
        ids.length === Object.keys(previous).length &&
        ids.every((id) => previous[id] === measured[id]);
      return same ? previous : measured;
    });
  }, [key, expanded]);

  // A countdown belongs to its own toast. Dismissing the whole set on one
  // timer cuts short whichever toast happened to arrive last.
  useEffect(() => {
    const now = Date.now();
    for (const toast of visible)
      if (!deadlines.current.has(toast.id))
        deadlines.current.set(toast.id, now + TOAST_DURATION_MS);
    for (const id of [...deadlines.current.keys()])
      if (!visible.some((toast) => toast.id === id))
        deadlines.current.delete(id);
  }, [key]);

  useEffect(() => {
    if (expanded) return;
    const timers = visible.map((toast) =>
      setTimeout(
        () => onDismiss([toast.id]),
        Math.max(0, (deadlines.current.get(toast.id) ?? 0) - Date.now()),
      ),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [expanded, key, onDismiss]);

  const pause = () => {
    if (pausedAt.current === null) pausedAt.current = Date.now();
    setExpanded(true);
  };
  const resume = () => {
    // Countdowns resume with the time that was left, not from the top.
    const elapsed = Date.now() - (pausedAt.current ?? Date.now());
    for (const [id, at] of deadlines.current)
      deadlines.current.set(id, at + elapsed);
    pausedAt.current = null;
    setExpanded(false);
  };

  if (visible.length === 0) return null;

  const offsetFor = (index: number) => {
    if (!expanded) return index * TOAST_LIFT;
    let offset = 0;
    for (let before = 0; before < index; before += 1)
      offset += (heights[visible[before]!.id] ?? 0) + TOAST_GAP;
    return offset;
  };
  const deckHeight = expanded
    ? offsetFor(visible.length - 1) +
      (heights[visible[visible.length - 1]!.id] ?? 0)
    : (heights[visible[0]!.id] ?? 0) + (visible.length - 1) * TOAST_LIFT;

  return (
    <div
      aria-live="polite"
      className="toast-stack"
      data-expanded={expanded}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          resume();
      }}
      onFocus={pause}
      onMouseEnter={pause}
      onMouseLeave={resume}
      style={{ height: deckHeight }}
    >
      {visible.map((toast, index) => (
        <div
          className={`toast level-${toast.level}`}
          key={toast.id}
          ref={(node) => {
            if (node) nodes.current.set(toast.id, node);
            else nodes.current.delete(toast.id);
          }}
          style={
            {
              "--toast-offset": `${offsetFor(index)}px`,
              "--toast-scale": expanded ? 1 : 1 - index * TOAST_SCALE_STEP,
              // Collapsed, every card takes the front card's height. A taller
              // one behind would jut out and break the stack into a ledge.
              ...(expanded || index === 0
                ? {}
                : { height: heights[visible[0]!.id] }),
              zIndex: visible.length - index,
            } as CSSProperties
          }
        >
          <span aria-hidden="true" className="toast-level" />
          <button
            className="quiet toast-body"
            onClick={() => {
              onOpen(toast);
              onDismiss([toast.id]);
            }}
            type="button"
          >
            <strong>{toast.title}</strong>
            <span>{toast.body}</span>
          </button>
          <button
            aria-label={`Dismiss notification: ${toast.title}`}
            className="quiet toast-dismiss"
            onClick={() => onDismiss([toast.id])}
            type="button"
          >
            <DismissIcon />
          </button>
        </div>
      ))}
      {visible.length > 1 && (
        <button
          className="quiet toast-clear-all"
          onClick={() => onDismiss(visible.map((toast) => toast.id))}
          style={
            { "--toast-offset": `${deckHeight + TOAST_GAP}px` } as CSSProperties
          }
          type="button"
        >
          Clear all {visible.length}
        </button>
      )}
    </div>
  );
}

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

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The one sentence the quit dialog says.
 *
 * Exported and pure because the sentence is the whole dialog. It confirms and
 * nothing else — quitting never ends a session, so there is no choice to lay
 * out, only a count to get right.
 */
export function quitDisclosure(plan: ShutdownPlanDto): string {
  const parts = [
    ...(plan.sessions.length ? [plural(plan.sessions.length, "session")] : []),
    ...(plan.terminals.length
      ? [plural(plan.terminals.length, "terminal")]
      : []),
  ];
  return parts.length
    ? `${parts.join(" and ")} will keep running.`
    : "Nothing is running.";
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

/**
 * Whether the caret is inside this terminal right now. xterm parks it in a
 * hidden textarea, so "focused" is a containment question rather than an
 * identity one.
 */
const holdsCaret = (container: HTMLElement | null) =>
  Boolean(
    container &&
    document.activeElement &&
    container.contains(document.activeElement),
  );

function TerminalSurface({
  activity,
  attention,
  focused,
  fitRevision,
  id,
  terminalEndpoint,
  label,
  locationLabel,
  onClearAttention,
  onFocused,
  onOpenLink,
  status,
  session,
  telemetry,
  target,
  worktree,
}: {
  activity?: AgentActivityDto;
  attention?: SessionAttentionDto;
  focused: boolean;
  fitRevision: number;
  id: string;
  terminalEndpoint?: string;
  label: string;
  locationLabel?: string;
  onClearAttention?: () => void;
  onFocused?: () => void;
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
  const view = session
    ? sessionStatusView(session, activity, attention)
    : undefined;
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
  const focusDeliveredRef = useRef(onFocused);
  focusDeliveredRef.current = onFocused;
  /**
   * Rebuilding xterm in place — the session going `starting` → `running`, the
   * endpoint arriving — disposes the textarea the caret is sitting in. That is
   * an implementation detail of this component and must not cost the user
   * their place, so the caret is remembered across the rebuild and handed to
   * the terminal that replaces it. A new session is always `starting` first,
   * so without this every new session took the keyboard and lost it again the
   * moment it finished starting.
   */
  const heldCaretRef = useRef(false);
  useEffect(() => {
    fitRef.current();
    if (!focused) return;
    requestAnimationFrame(() => {
      focusRef.current();
      focusDeliveredRef.current?.();
    });
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
      if (focused)
        requestAnimationFrame(() => {
          terminal?.focus();
          focusDeliveredRef.current?.();
        });
      else if (heldCaretRef.current)
        requestAnimationFrame(() => terminal?.focus());
      heldCaretRef.current = false;
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
      const endpoint = terminalEndpoint;
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
      // Read before the dispose below removes the textarea from the document
      // and the browser hands focus back to the body.
      heldCaretRef.current = holdsCaret(containerRef.current);
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
  }, [id, status, target, terminalEndpoint]);

  return (
    <section className="agent-terminal-shell">
      {target === "integrated" && (
        <div className="terminal-status">
          <span className={`agent-dot tone-${lifecycleTone(status)}`} />
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
      {target === "agent" && session && view && (
        <div className="agent-session-status" aria-label="Session status">
          {/*
            There is deliberately no reason panel here. This surface only ever
            renders for the session the user is currently watching, so a panel
            restating why it is blocked can never tell them anything the
            terminal above it has not already said — it just costs rows and
            repeats the agent back to itself. The badge still exists for every
            surface where the session is *not* on screen: the session list, the
            workspace roll-up, and the notification.

            What does not survive being scrolled past is the wait and the way
            out, so those fold into the status line instead.
          */}
          <div className="agent-session-status-primary">
            <AgentStatusDot
              count={view.reasons.length}
              label={statusAriaLabel(session, view, now)}
              view={view}
            />
            <strong>{providerLabel(session.provider)}</strong>
            <span className="agent-session-activity">
              {view.label}
              {view.unconfirmed ? " (unconfirmed)" : ""}
            </span>
            {view.attention && view.since && (
              <span className="agent-session-activity-waiting">
                waiting {waitingLabel(view.since, now)}
              </span>
            )}
            {view.detail && (
              <span
                className="agent-session-activity-detail"
                title={view.detail}
              >
                {view.detail}
              </span>
            )}
            {view.attention && onClearAttention && (
              <button
                className="quiet agent-session-attention-clear"
                onClick={onClearAttention}
                type="button"
              >
                Clear
              </button>
            )}
            {telemetry?.model && (
              <span className="agent-session-status-model">
                {telemetry.model}
              </span>
            )}
            {telemetry?.permissionMode && (
              <span
                className="agent-session-status-permission"
                title="Permission mode, as of this session's latest turn. Change it with /permissions."
              >
                {telemetry.permissionMode}
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
  terminalEndpoint,
}: {
  active: boolean;
  fitRevision: number;
  mountRevision: number;
  onOpenLink: (url: string) => void;
  terminal: IntegratedTerminalDto;
  terminalEndpoint?: string;
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
          terminalEndpoint={terminalEndpoint}
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
  initialWorkspaceView,
  initialWorkspaceContent,
  initialModal,
  initialSessionLaunches = [],
  initialScope = "workspace",
}: {
  injectedClient?: DesktopClient;
  initialSnapshot?: DesktopSnapshotDto;
  initialSelectedTaskId?: string;
  initialActiveAgentId?: string;
  initialActiveTerminalId?: string;
  initialTerminalPanelOpen?: boolean;
  initialDetailView?: "brief" | "terminal";
  initialWorkspaceView?: WorkspaceView;
  initialScope?: WorkspaceScope;
  initialWorkspaceContent?: WorkspaceContentDto;
  initialModal?: "workspace" | "task" | "session" | "repository" | "settings";
  initialSessionLaunches?: SessionLaunchState[];
} = {}) {
  const clientRef = useRef(injectedClient);
  if (!clientRef.current)
    throw new Error("The desktop RPC client was not provided");
  const client = clientRef.current;
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  // The terminal socket carries a per-launch token and the `views://`
  // handler cannot accept URL parameters, so the endpoint is fetched once
  // over RPC instead of being read off `window.location`.
  const [terminalEndpoint, setTerminalEndpoint] = useState<string>();
  // Elapsed labels are formatting, not state: the clock ticks here so a
  // session that has been waiting four minutes says so, and nothing in the
  // renderer ever decides what state a session is in.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [terminalFitRevision, setTerminalFitRevision] = useState(0);
  const [terminalMountRevision, setTerminalMountRevision] = useState(0);
  const terminalLayoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [workspaceId, setWorkspaceId] = useState(
    initialSnapshot?.workspaces.find((item) => !item.archivedAt)?.id,
  );
  // "all" shows every workspace's tasks and sessions in the main column.
  // `workspaceId` stays set underneath it: it is the workspace the session
  // dialog, the terminal heading and the content loaders fall back to, and
  // the one the column returns to when a card is clicked.
  const [scope, setScope] = useState<WorkspaceScope>(initialScope);
  const showingAll = scope === "all";
  // Remembered views and sessions are filed per workspace, and once more for
  // the all-workspaces scope, so leaving it and coming back restores it.
  const scopeKey = showingAll ? ALL_WORKSPACES_SCOPE_KEY : workspaceId;
  const [selectedTaskId, setSelectedTaskId] = useState(initialSelectedTaskId);
  const [activeSessionId, setActiveSessionId] = useState(initialActiveAgentId);
  // Keyboard focus follows explicit intent, never mere selection. Only a
  // session the user opened from this window claims the caret; sessions that
  // become active on their own — restored from storage at startup, picked by
  // `preferredSessionId`, or created from the CLI — leave focus alone. A
  // remount caused by a layout change asks again, but only on behalf of a
  // terminal that already had the caret: see `terminalLayoutChanged`.
  const [focusedSessionId, setFocusedSessionId] = useState<string>();
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const openSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setFocusedSessionId(id);
  }, []);
  // The request is consumed once the caret actually lands, so a later remount
  // from a panel resize does not silently take focus back.
  const clearSessionFocusRequest = useCallback(
    () => setFocusedSessionId(undefined),
    [],
  );
  // A launch that failed never became a session, so there is nothing to
  // archive and nothing on the server to clean up — dismissing it is purely
  // local, and without it the card has no way off the list.
  const dismissSessionLaunch = useCallback(
    (key: string) =>
      setSessionLaunches((current) =>
        current.filter((launch) => launch.key !== key),
      ),
    [],
  );
  const [view, setView] = useState<WorkspaceView>(
    () =>
      initialWorkspaceView ??
      preferredScopeView(scope, rememberedWorkspaceView(scopeKey)),
  );
  const viewWorkspaceId = useRef(scopeKey);
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
  // The filesystem subscription is established once per workspace and must not
  // be torn down and rebuilt every time a listing lands, so it reads the cache
  // and the open file through refs rather than closing over them.
  const workspaceDirectoriesRef = useRef(workspaceDirectories);
  workspaceDirectoriesRef.current = workspaceDirectories;
  const selectedWorkspaceFileRef = useRef(selectedWorkspaceFile);
  selectedWorkspaceFileRef.current = selectedWorkspaceFile;
  const workspaceDraftRef = useRef(workspaceDraft);
  workspaceDraftRef.current = workspaceDraft;
  /**
   * What a change on disk does to the file the viewer has open.
   *
   * An unsaved draft is never touched. Someone typing into the editor while an
   * agent writes the same file would lose their work, and a stale draft the
   * user can still see and save is strictly better than a silent overwrite —
   * `workspaceFileWrite` compares against `expectedContent`, so the conflict
   * is caught at save time and reported rather than lost here.
   */
  const reconcileOpenFile = useCallback(
    async (changes: readonly WorkspaceFileChangeDto[], overflow: boolean) => {
      const open = selectedWorkspaceFileRef.current;
      if (!open || !workspaceId) return;
      if (workspaceDraftRef.current !== open.content) return;
      const touched = overflow
        ? undefined
        : changes.find((change) => change.path === open.path);
      if (!overflow && !touched) return;
      if (touched?.kind === "deleted") {
        setSelectedWorkspaceFile(null);
        setWorkspaceDraft("");
        return;
      }
      const reread = await client.request.workspaceFileRead({
        workspace: workspaceId,
        path: open.path,
      });
      // Still the same file, and still unedited — checked again because the
      // read was a round trip and the user may have started typing during it.
      if (
        selectedWorkspaceFileRef.current?.path !== open.path ||
        workspaceDraftRef.current !== open.content
      )
        return;
      if (!reread.ok) {
        // An overflow says nothing about this file in particular, so a read
        // that fails under one is the only evidence that it is gone.
        if (overflow) {
          setSelectedWorkspaceFile(null);
          setWorkspaceDraft("");
        }
        return;
      }
      if (reread.data.content === open.content) return;
      setSelectedWorkspaceFile(reread.data);
      setWorkspaceDraft(reread.data.content);
    },
    [client, workspaceId],
  );
  const [selectedWorkspaceDirectory, setSelectedWorkspaceDirectory] =
    useState("");
  const [newWorkspaceEntry, setNewWorkspaceEntry] = useState<{
    kind: "file" | "directory";
    name: string;
  }>();
  // The context menu is positioned at the pointer rather than anchored to the
  // row, which is what every file explorer does and what makes it reachable
  // for a row scrolled to the edge of the tree.
  const [entryMenu, setEntryMenu] = useState<{
    entry: WorkspaceFileEntryDto;
    x: number;
    y: number;
  }>();
  const [renamingEntry, setRenamingEntry] = useState<{
    path: string;
    name: string;
  }>();
  const [sessionFilter, setSessionFilter] = useState<"all" | "needs-me">("all");
  const [modal, setModal] = useState<
    "workspace" | "task" | "session" | "repository" | "settings" | undefined
  >(initialModal);
  // Which settings category is open. Kept here rather than inside the dialog
  // so reopening Settings returns to where the user was.
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [editingTask, setEditingTask] = useState(false);
  const [taskTimeline, setTaskTimeline] = useState<TaskTimelineDto>();
  const [taskTimelineLoading, setTaskTimelineLoading] = useState(false);
  // A journal heading the workspace view should scroll to once it has opened
  // JOURNAL.md. Read through a ref by the view's loader, which must not
  // re-run just because a link was followed.
  const [journalTarget, setJournalTarget] = useState<string>();
  const journalTargetRef = useRef(journalTarget);
  journalTargetRef.current = journalTarget;
  // The quit dialog is driven entirely by the host: it arrives with the plan
  // already computed, and every button answers back over `quitDecision`.
  const [quitRequest, setQuitRequest] = useState<ShutdownPlanDto>();
  const [quitting, setQuitting] = useState<QuitChoice>();
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
  const [rememberSessionModel, setRememberSessionModel] = useState(false);
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
  const [pendingRepositoryActions, setPendingRepositoryActions] = useState<
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
  const [worktreeAction, setWorktreeAction] = useState<{
    worktree: SessionWorktreeDto;
    repositoryName: string;
    sessionLabel: string;
  }>();
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
  const [explorerWidth, setExplorerWidth] = useState(() =>
    storedPanelSize("daedalus.panel.explorer-width", EXPLORER_DEFAULT_WIDTH),
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
    terminalLayoutTimer.current = setTimeout(() => {
      // Recreating xterm throws away the textarea the caret lives in, and this
      // is Daedalus repairing its own layout rather than the user going
      // anywhere, so the caret has to be asked for again on the other side.
      //
      // This is what stood between opening a session and being able to type in
      // it. A settle lands within a frame or two of the click that opened the
      // session, so the terminal took the keyboard, was rebuilt, and dropped it
      // on the floor — and the only sign of it was having to click a second
      // time.
      if (document.activeElement?.closest(".terminal-column"))
        setFocusedSessionId(activeSessionIdRef.current);
      setTerminalMountRevision((revision) => revision + 1);
    }, 120);
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

  // The explorer's own two borders. They are deliberately not the column
  // resizer above: that one divides the whole shell, and the maxima here are
  // the file viewer beside the explorer and the file tree above the
  // repositories, neither of which the shell knows about.
  const startExplorerWidthResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const browser = event.currentTarget.closest(".workspace-browser");
      if (!(browser instanceof HTMLElement)) return;
      const startX = event.clientX;
      const aside = browser.querySelector<HTMLElement>(".workspace-explorer");
      const startWidth = aside?.offsetWidth ?? explorerWidth;
      const available =
        browser.clientWidth -
        EXPLORER_VIEWER_MIN_WIDTH -
        event.currentTarget.offsetWidth;

      const handle = event.currentTarget;
      handle.classList.add("dragging");
      document.body.classList.add("resizing-column-panel");
      const move = (moveEvent: PointerEvent) => {
        setExplorerWidth(
          clampExplorerWidth(
            startWidth + moveEvent.clientX - startX,
            available,
          ),
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
    [explorerWidth],
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

  useEffect(() => {
    let cancelled = false;
    void client.request.terminalEndpoint({}).then((response) => {
      if (!cancelled && response.ok)
        setTerminalEndpoint(response.data.endpoint);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const [dataRevision, setDataRevision] = useState(0);

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
    return client.subscribe(() => {
      void refresh();
      setDataRevision((current) => current + 1);
    });
  }, [client, refresh]);

  // Repositories live in the workspace content, not in the snapshot, so
  // refreshing the snapshot alone left a repository that finished preparing in
  // the background spinning on screen until something unrelated happened to
  // refetch. This is deliberately separate from the effect that loads the view:
  // that one also picks the open file and seeds the editor draft, and must not
  // run again underneath someone who is typing.
  useEffect(() => {
    if (dataRevision === 0 || view !== "workspace" || !workspaceId) return;
    let cancelled = false;
    void client.request
      .workspaceContentGet({ workspace: workspaceId })
      .then((response) => {
        if (cancelled || !response.ok) return;
        setWorkspaceContent(response.data);
        setWorkspaceDirectories((current) => ({
          ...current,
          "": response.data.files,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [client, dataRevision, view, workspaceId]);

  // The repository chips in the header show on every tab, and outside the
  // Workspace tab there is no editor to protect, so one effect loads the
  // content when the tab opens and again whenever the data moves. The files
  // come along and seed the explorer's root for later.
  useEffect(() => {
    if (view === "workspace" || !workspaceId) return;
    let cancelled = false;
    void client.request
      .workspaceContentGet({ workspace: workspaceId })
      .then((response) => {
        if (cancelled || !response.ok) return;
        setWorkspaceContent(response.data);
        setWorkspaceDirectories((current) => ({
          ...current,
          "": response.data.files,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [client, dataRevision, view, workspaceId]);

  // Escape, or a press anywhere outside the drawer, closes the task drawer,
  // unless it is being edited (an unsaved brief is not lost to a stray click)
  // or a dialog is on top of it. A press on a card leaves it open, because
  // the card's own click swaps the drawer to that task.
  useEffect(() => {
    if (view !== "board" || !selectedTaskId || editingTask || modal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      setSelectedTaskId(undefined);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target?.isConnected) return;
      if (target.closest(".task-drawer, .board-card, .modal-backdrop")) return;
      setSelectedTaskId(undefined);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [editingTask, modal, selectedTaskId, view]);

  const clearAttention = useCallback(
    async (sessionId: string) => {
      const response = await client.request.attentionClear({ sessionId });
      if (!response.ok) setError(response.error.message);
      await refresh();
    },
    [client, refresh],
  );

  // The timeline reads the journal and the history tables, so it is asked for
  // when a task is selected and again whenever the data moves, never carried
  // on the snapshot.
  useEffect(() => {
    if (!selectedTaskId || view !== "board") {
      setTaskTimeline(undefined);
      return;
    }
    let cancelled = false;
    setTaskTimelineLoading(true);
    void client.request
      .taskTimeline?.({ id: selectedTaskId })
      .then((response) => {
        if (cancelled) return;
        setTaskTimeline(response.ok ? response.data : undefined);
      })
      .catch(() => {
        if (!cancelled) setTaskTimeline(undefined);
      })
      .finally(() => {
        if (!cancelled) setTaskTimelineLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, dataRevision, selectedTaskId, view]);

  // Once the journal is rendered, bring the linked entry into view. Matched on
  // the heading's text, which is what the timeline carries, and dropped after
  // one attempt so a later visit to the journal is not yanked back to it.
  useEffect(() => {
    if (
      !journalTarget ||
      view !== "workspace" ||
      selectedWorkspaceFile?.path !== "JOURNAL.md" ||
      workspaceFileMode !== "preview"
    )
      return;
    const frame = requestAnimationFrame(() => {
      const heading = [
        ...document.querySelectorAll<HTMLElement>(
          ".workspace-viewer-content h2, .workspace-viewer-content h3",
        ),
      ].find((element) => element.textContent?.trim() === journalTarget);
      // The class carries the scroll margin, so it goes on before the scroll.
      heading?.classList.add("journal-target");
      heading?.scrollIntoView({ block: "start" });
      setJournalTarget(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [journalTarget, selectedWorkspaceFile, view, workspaceFileMode]);

  const setFocusMode = useCallback(
    async (enabled: boolean) => {
      const response = await client.request.focusModeSet({ enabled });
      if (!response.ok) setError(response.error.message);
      await refresh();
    },
    [client, refresh],
  );

  const dismissToasts = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      await client.request.toastsAcknowledge({ ids });
      await refresh();
    },
    [client, refresh],
  );

  // Presence is published, not inferred at the far end: whoever decides which
  // channel an alert takes needs to know where the user is, and only the
  // window knows that. The heartbeat is short enough that a closed window
  // stops absorbing alerts within a few seconds.
  useEffect(() => {
    let cancelled = false;
    const publish = () => {
      if (cancelled) return;
      // A heartbeat is never worth breaking the window over, and harnesses
      // inject partial clients.
      try {
        void client.request.presencePublish?.({
          appForeground:
            document.visibilityState === "visible" && document.hasFocus(),
          // With every workspace showing, no single one is "the one on
          // screen". Routing only reads the session anyway.
          workspaceId: showingAll ? null : (workspaceId ?? null),
          sessionId: activeSessionId ?? null,
        });
      } catch {
        // Presence is advisory; routing degrades to "no app", never to a crash.
      }
    };
    publish();
    const timer = setInterval(publish, 3_000);
    window.addEventListener("focus", publish);
    window.addEventListener("blur", publish);
    document.addEventListener("visibilitychange", publish);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", publish);
      window.removeEventListener("blur", publish);
      document.removeEventListener("visibilitychange", publish);
    };
  }, [activeSessionId, client, showingAll, workspaceId]);
  const runDesktopCommand = useCallback(
    (command: DesktopCommand) => {
      if (command === "view-board") setView("board");
      else if (command === "view-sessions" && workspaceId) setView("sessions");
      else if (command === "view-workspace" && workspaceId && !showingAll)
        setView("workspace");
      else if (command === "toggle-terminal")
        setTerminalPanelOpen((current) => !current);
    },
    [showingAll, workspaceId],
  );
  useEffect(
    () => client.subscribeCommands(runDesktopCommand),
    [client, runDesktopCommand],
  );
  // A clicked notification runs `daedal focus`, which raises the app and lands
  // here. Selecting the session is the whole point: an alert that only brings
  // the window forward still leaves the user hunting.
  useEffect(
    () =>
      client.subscribeFocusSession((sessionId) => {
        const session = snapshotRef.current?.agents.find(
          (item) => item.id === sessionId,
        );
        if (!session) return;
        setWorkspaceId(session.workspaceId);
        openSession(sessionId);
        setView("sessions");
      }),
    [client, openSession],
  );
  // Deliberately not routed through Focus mode. This is a direct response to
  // the user pressing Cmd+Q, not an alert, and suppressing it would leave a
  // keystroke that silently does nothing.
  useEffect(
    () =>
      client.subscribeQuitRequest?.((plan) => {
        setQuitting(undefined);
        setQuitRequest(plan);
        // Tells the host the dialog exists. Without this it quits on its own
        // after a couple of seconds, keeping everything running, rather than
        // leaving Cmd+Q looking broken.
        void client.request.quitDialogShown?.({});
      }),
    [client],
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
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        setWorkspaceContent(response.data);
        setWorkspaceDirectories({ "": response.data.files });
        // A journal link from the task timeline lands on the entry, rendered,
        // rather than on the brief the view opens by default.
        const journal = Boolean(journalTargetRef.current);
        setSelectedWorkspaceFile({
          name: journal ? "JOURNAL.md" : "BRIEF.md",
          path: journal ? "JOURNAL.md" : "BRIEF.md",
          content: journal ? response.data.journal : response.data.brief,
          format: "markdown",
        });
        setWorkspaceDraft(
          journal ? response.data.journal : response.data.brief,
        );
        setWorkspaceFileMode(journal ? "preview" : "edit");
        setSelectedWorkspaceDirectory("");
        setNewWorkspaceEntry(undefined);
        setError(undefined);

        // Folders the user opened stay open across a workspace switch, a trip
        // to the board, and a restart. Each one is listed again rather than
        // trusted: a folder can be gone, or no longer a folder, between two
        // visits, and an entry that cannot be listed is simply forgotten.
        const remembered = rememberedExpandedDirectories(workspaceId);
        if (remembered.length === 0) {
          setExpandedWorkspaceDirectories(new Set());
          return;
        }
        const listings = await Promise.all(
          remembered.map(async (path) => {
            const listing = await client.request.workspaceDirectoryList({
              workspace: workspaceId,
              path,
            });
            return listing.ok ? ([path, listing.data] as const) : undefined;
          }),
        );
        if (cancelled) return;
        const restored = listings.filter((entry) => entry !== undefined);
        setWorkspaceDirectories((current) => ({
          ...current,
          ...Object.fromEntries(restored),
        }));
        const paths = restored.map(([path]) => path);
        setExpandedWorkspaceDirectories(new Set(paths));
        if (paths.length !== remembered.length)
          rememberExpandedDirectories(workspaceId, paths);
      });
    return () => {
      cancelled = true;
    };
  }, [client, view, workspaceId]);

  useEffect(() => {
    if (!entryMenu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEntryMenu(undefined);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [entryMenu]);
  // A menu and a half-typed rename both belong to a tree that is on screen.
  useEffect(() => {
    setEntryMenu(undefined);
    setRenamingEntry(undefined);
  }, [view, workspaceId]);

  // The host watches whichever workspace this window is actually showing, and
  // nothing when it is showing something else. A watcher is a kernel resource
  // and a tree nobody is looking at does not need to be fresh.
  useEffect(() => {
    if (view !== "workspace" || !workspaceId) {
      void client.request.workspaceWatchSet({ workspaces: [] });
      return;
    }
    void client.request.workspaceWatchSet({ workspaces: [workspaceId] });
    return () => {
      void client.request.workspaceWatchSet({ workspaces: [] });
    };
  }, [client, view, workspaceId]);

  // Changes on disk are reconciled into the directory cache, never applied to
  // the tree directly. Re-listing the affected folders is what lets expansion,
  // selection and an unsaved draft survive a file appearing underneath them.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const unsubscribe = client.subscribeWorkspaceFiles(
      ({ workspaceId: changed, changes, overflow }) => {
        if (changed !== workspaceId) return;
        void (async () => {
          const plan = planExplorerRefresh({
            known: Object.keys(workspaceDirectoriesRef.current),
            changes,
            overflow,
          });
          if (plan.dropped.length > 0) {
            setWorkspaceDirectories((current) => {
              const next = { ...current };
              for (const folder of plan.dropped) delete next[folder];
              return next;
            });
            // A folder that no longer exists cannot be open. Forgetting it here
            // also keeps it out of what is remembered for the next visit.
            setExpandedWorkspaceDirectories((current) => {
              if (!plan.dropped.some((folder) => current.has(folder)))
                return current;
              const next = new Set(current);
              for (const folder of plan.dropped) next.delete(folder);
              rememberExpandedDirectories(workspaceId, next);
              return next;
            });
          }
          const listings = await Promise.all(
            plan.relist.map(async (path) => {
              const listing = await client.request.workspaceDirectoryList({
                workspace: workspaceId,
                path: path || undefined,
              });
              // A folder that vanished between the event and this call simply
              // has no listing; its own parent is in the same batch and will
              // report it gone.
              return listing.ok ? ([path, listing.data] as const) : undefined;
            }),
          );
          if (cancelled) return;
          const refreshed = listings.filter((entry) => entry !== undefined);
          if (refreshed.length > 0)
            setWorkspaceDirectories((current) => ({
              ...current,
              ...Object.fromEntries(refreshed),
            }));
          await reconcileOpenFile(changes, overflow);
        })();
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, workspaceId, reconcileOpenFile]);
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
    window.localStorage.setItem(
      "daedalus.panel.explorer-width",
      String(explorerWidth),
    );
  }, [explorerWidth]);
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

  /**
   * Answers the quit dialog. Not routed through `perform`: archiving a board
   * of sessions is slower than one RPC deadline, and the reply to a successful
   * quit never arrives at all because the process is gone by then.
   */
  function answerQuit(choice: QuitChoice) {
    if (quitting) return;
    if (choice === "cancel") {
      setQuitRequest(undefined);
      setQuitting(undefined);
    } else setQuitting(choice);
    void client.request.quitDecision?.({ choice }).catch(() => {
      // The app is on its way out; there is nobody left to tell.
    });
  }

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

  // Activity and attention arrive as flat arrays on the snapshot, exactly like
  // telemetry. Indexing them once keeps every surface reading the same DTO.
  const activityById = new Map(
    (snapshot?.sessionActivity ?? []).map((item) => [item.sessionId, item]),
  );
  const attentionById = new Map(
    (snapshot?.attention ?? []).map((item) => [item.sessionId, item]),
  );
  const telemetryById = new Map(
    (snapshot?.sessionTelemetry ?? []).map((item) => [item.sessionId, item]),
  );
  const statusViewFor = (session: AgentSessionDto) =>
    sessionStatusView(
      session,
      activityById.get(session.id),
      attentionById.get(session.id),
    );

  const activeWorkspaces = (snapshot?.workspaces ?? []).filter(
    (item) => !item.archivedAt && !archivingWorkspaceIds.has(item.id),
  );
  const archivedWorkspaces = (snapshot?.workspaces ?? []).filter(
    (item) => item.archivedAt,
  );
  const workspace = activeWorkspaces.find((item) => item.id === workspaceId);
  const workspaceReorder = useListReorder({
    ids: activeWorkspaces.map((item) => item.id),
    // The promise is returned, not discarded: it is what holds the dropped
    // card in place until the refreshed snapshot agrees with it.
    onCommit: (references) =>
      perform(client.request.workspaceReorder({ references })),
  });
  const orderedWorkspaces = workspaceReorder.order.flatMap(
    (id) => activeWorkspaces.find((item) => item.id === id) ?? [],
  );
  const workspaceById = new Map(
    (snapshot?.workspaces ?? []).map((item) => [item.id, item]),
  );
  // The scope's workspaces: the selected one, or every active one. An
  // archived workspace's tasks and sessions stay out of the all-workspaces
  // view the same way its card stays out of the column.
  const inScope = (id: string) =>
    showingAll
      ? activeWorkspaces.some((item) => item.id === id)
      : id === workspaceId;
  const allTasks = (snapshot?.tasks ?? []).filter((item) =>
    inScope(item.workspaceId),
  );
  // Order is the user's, kept in the database and applied by the query that
  // built this snapshot. The renderer filters it but never re-sorts it: a list
  // the user arranged by hand is the one thing an adapter has no business
  // second-guessing. Across every workspace the order is the column's: each
  // workspace's sessions together, in that workspace's own order, because the
  // snapshot's positions are only meaningful within one workspace.
  const workspaceSessions = showingAll
    ? orderedWorkspaces.flatMap((item) =>
        (snapshot?.agents ?? []).filter(
          (session) => session.workspaceId === item.id,
        ),
      )
    : (snapshot?.agents ?? []).filter(
        (item) => item.workspaceId === workspaceId,
      );
  const activeSessions = workspaceSessions.filter((item) => !item.archivedAt);
  const attentionSessionIds = new Set(
    activeSessions
      .filter((item) => statusViewFor(item).attention)
      .map((item) => item.id),
  );
  // Blocked sessions used to float to the top here. They no longer do: once
  // the order is something the user placed, moving a card out from under them
  // is the bug, not the feature. The "Needs me" filter, the card tone and the
  // workspace roll-up count all still surface a blocked session in place.
  const sessions = activeSessions.filter(
    (item) => sessionFilter === "all" || attentionSessionIds.has(item.id),
  );
  const sessionReorder = useListReorder({
    ids: sessions.map((item) => item.id),
    // A position is an order within one workspace, so the all-workspaces
    // list is read-only: there is no one list on the server for a drag
    // across it to write.
    disabled: showingAll,
    // Only the visible sessions are named, so a drag inside the "Needs me"
    // filter leaves the sessions it is hiding exactly where they were.
    onCommit: (sessionIds) =>
      perform(
        client.request.agentReorder({
          sessionIds,
          workspace: workspaceId!,
        }),
      ),
  });
  const orderedSessions = sessionReorder.order.flatMap(
    (id) => sessions.find((item) => item.id === id) ?? [],
  );
  const workspaceSessionLaunches = sessionLaunches.filter((item) =>
    inScope(item.workspaceId),
  );
  const visibleSessionLaunches = pendingSessionLaunches(
    workspaceSessionLaunches,
    workspaceSessions,
  );
  const sessionStartupErrors = new Map(
    workspaceSessionLaunches.flatMap((launch) =>
      launch.sessionId && launch.error
        ? [[launch.sessionId, launch.error] as const]
        : [],
    ),
  );
  const archivedSessions = workspaceSessions.filter((item) => item.archivedAt);
  const workspaceSessionIds = new Set(workspaceSessions.map((item) => item.id));
  // The snapshot carries every workspace's worktrees so the board can read
  // them without the workspace view open; the board shows only this one's.
  const workspaceWorktrees = (snapshot?.worktrees ?? []).filter((item) =>
    workspaceSessionIds.has(item.sessionId),
  );
  // Claude first when both are installed: it is the order the session dialog
  // lists them in, and Start has to pick something when nothing is chosen.
  const availableBoardProviders = (["claude", "codex"] as const).filter(
    (name) =>
      snapshot?.settings.providers.some(
        (provider) => provider.name === name && provider.available,
      ),
  ) as BoardProvider[];
  const selectedTask = snapshot?.tasks.find(
    (item) => item.id === selectedTaskId,
  );
  // Deliberately not the filtered list: hiding a session from the list must
  // not tear down the terminal the user is sitting in.
  const activeSession = activeSessions.find(
    (item) => item.id === activeSessionId,
  );
  // A session that was asked to hand off, by a click or by the automatic
  // sweep, is followed to its successor: the fresh session in the same
  // working directory that started after the request. Looked up across the
  // archived sessions too, because the successor arrives and the
  // predecessor is archived within the same second.
  const viewedHandoff = workspaceSessions.find(
    (item) => item.id === activeSessionId && item.handoffRequestedAt,
  );
  const handoffSuccessor = viewedHandoff
    ? activeSessions.find(
        (item) =>
          item.id !== viewedHandoff.id &&
          item.workingDirectory === viewedHandoff.workingDirectory &&
          item.startedAt >= viewedHandoff.handoffRequestedAt!,
      )
    : undefined;
  useEffect(() => {
    if (handoffSuccessor) openSession(handoffSuccessor.id);
  }, [handoffSuccessor, openSession]);
  const activeSessionTelemetry = snapshot?.sessionTelemetry.find(
    (item) => item.sessionId === activeSession?.id,
  );
  // The workspace content only describes the selected workspace, and with
  // every workspace showing the active session can belong to another one.
  // The snapshot carries every worktree, so that is the fallback.
  const activeSessionWorktree =
    workspaceContent?.worktrees.find(
      (item) => item.sessionId === activeSession?.id,
    ) ??
    snapshot?.worktrees.find((item) => item.sessionId === activeSession?.id);
  const activeSessionRepository = workspaceContent?.repositories.find(
    (item) => item.id === activeSessionWorktree?.repositoryId,
  );
  const activeSessionWorkspace = activeSession
    ? workspaceById.get(activeSession.workspaceId)
    : undefined;
  const activeSessionModel =
    activeSessionTelemetry?.model ?? sessionConfiguredModel(activeSession);
  const sessionModelCatalog =
    sessionType === "codex" || sessionType === "claude"
      ? modelCatalogs[sessionType]
      : undefined;
  const sessionDefaultModel = sessionModelCatalog?.models.find(
    (model) =>
      model.id === sessionModelCatalog.defaultModel ||
      model.resolvedModel === sessionModelCatalog.defaultModel,
  );
  const selectedSessionModel = sessionModelCatalog?.models.find(
    (model) => model.id === sessionModel,
  );
  // The workspace default applies to this dialog's provider only when it is
  // the provider the default was set for; a Claude default says nothing
  // about a Codex session. Leaving the picker on its first option starts
  // with it, because the core applies the same rule to every spawn.
  // The session dialog's workspace. A dialog opened from a task belongs to
  // that task's workspace, which with every workspace showing need not be the
  // selected one; opened from the Sessions toolbar it is the selected one,
  // and that toolbar's button is off while every workspace is showing.
  const sessionFormTask = snapshot?.tasks.find(
    (item) => item.id === sessionForm.taskId,
  );
  const sessionWorkspace =
    (sessionFormTask && workspaceById.get(sessionFormTask.workspaceId)) ??
    (showingAll ? undefined : workspace);
  const workspaceDefaultModel =
    sessionWorkspace && sessionWorkspace.defaultProvider === sessionType
      ? sessionWorkspace.defaultModel
      : null;
  const workspaceDefaultModelEntry = workspaceDefaultModel
    ? sessionModelCatalog?.models.find(
        (model) =>
          model.id === workspaceDefaultModel ||
          model.resolvedModel === workspaceDefaultModel,
      )
    : undefined;
  // Only a loaded catalog can call a default stale.
  const workspaceDefaultModelStale = Boolean(
    workspaceDefaultModel && sessionModelCatalog && !workspaceDefaultModelEntry,
  );
  // The first option already means the workspace default, so only another
  // provider or an explicit model is a choice worth remembering.
  const sessionChoiceIsWorkspaceDefault = Boolean(
    sessionWorkspace &&
    sessionWorkspace.defaultProvider === sessionType &&
    (sessionModel === "" || sessionModel === sessionWorkspace.defaultModel),
  );
  const sessionModelCatalogPending =
    sessionType !== "terminal" && !sessionModelCatalog && !modelCatalogError;
  const integratedTerminals = snapshot?.terminals ?? [];
  const activeIntegratedTerminal =
    integratedTerminals.find((item) => item.id === activeTerminalId) ??
    integratedTerminals.at(-1);

  useEffect(() => {
    if (viewWorkspaceId.current !== scopeKey) {
      viewWorkspaceId.current = scopeKey;
      setView(preferredScopeView(scope, rememberedWorkspaceView(scopeKey)));
      return;
    }
    if (scopeKey)
      window.localStorage.setItem(lastViewStorageKey(scopeKey), view);
  }, [scope, scopeKey, view]);

  useEffect(() => {
    if (view !== "sessions" || !scopeKey) return;
    const remembered = window.localStorage.getItem(
      lastSessionStorageKey(scopeKey),
    );
    const preferred = preferredSessionId(sessions, activeSessionId, remembered);
    if (preferred !== activeSessionId) setActiveSessionId(preferred);
  }, [activeSessionId, sessions, view, scopeKey]);

  useEffect(() => {
    if (!scopeKey || !activeSessionId) return;
    if (!sessions.some((session) => session.id === activeSessionId)) return;
    window.localStorage.setItem(
      lastSessionStorageKey(scopeKey),
      activeSessionId,
    );
  }, [activeSessionId, sessions, scopeKey]);
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
  const canSubmitRepositoryPicker =
    looksLikeRepositorySource(repositoryForm.search) ||
    [...selectedRepositoryIds].filter(
      (id) => !attachedLibraryRepositoryIds.has(id),
    ).length +
      selectedGitHubRepositories.size >
      0;
  const selectedRepositoryCount =
    [...selectedRepositoryIds].filter(
      (id) => !attachedLibraryRepositoryIds.has(id),
    ).length + selectedGitHubRepositories.size;

  function toggleRepositoryCandidate(key: string) {
    const candidate = repositoryCandidates.find((item) =>
      item.kind === "library"
        ? item.repository.id === key
        : `github:${item.repository.nameWithOwner}` === key,
    );
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

  /**
   * Arrow navigation, which is the only part of this the platform does not do
   * for us: Space toggling and Enter submitting are what a checkbox inside a
   * form already does, so neither is handled here.
   */
  function moveRepositoryFocus(from: HTMLElement, delta: number) {
    const options = [
      ...(from
        .closest(".repository-picker")
        ?.querySelectorAll<HTMLInputElement>(
          "input[data-repository-option]:not(:disabled)",
        ) ?? []),
    ];
    if (options.length === 0) return;
    const current = options.indexOf(from as HTMLInputElement);
    // From the search box, down enters the list and up stays put.
    if (current === -1) {
      if (delta > 0) options[0]?.focus();
      return;
    }
    const next = current + delta;
    if (next < 0) {
      from
        .closest(".repository-picker")
        ?.querySelector<HTMLInputElement>(".repository-unified-search input")
        ?.focus();
      return;
    }
    options[Math.min(next, options.length - 1)]?.focus();
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

  /** Loads a provider's model list once, for the board's settings. */
  const ensureModelCatalog = useCallback(
    (provider: BoardProvider) => {
      if (modelCatalogs[provider]) return;
      void client.request
        .agentModels({ provider })
        .then((response) => {
          if (response.ok)
            setModelCatalogs((current) => ({
              ...current,
              [provider]: response.data,
            }));
        })
        .catch(() => {
          // The model list is a convenience; the provider default still works.
        });
    },
    [client, modelCatalogs],
  );

  /**
   * Start on a board card. It launches with the workspace's default provider
   * and model without asking, and stays on the board: a dispatcher starting
   * three tasks does not want to be carried into each terminal in turn. The
   * core moves the task to `in_progress` when the workspace setting says so.
   */
  async function startTaskSession(
    task: TaskDto,
    options: {
      provider?: BoardProvider;
      model?: string;
      draftBrief?: boolean;
    } = {},
  ) {
    // The task's own workspace, never the selected one: with every workspace
    // showing they differ, and the core refuses a task spawned elsewhere.
    const target = workspaceById.get(task.workspaceId);
    if (!target) return;
    const provider =
      options.provider ?? target.defaultProvider ?? availableBoardProviders[0];
    if (!provider) {
      setError("No agent provider is installed");
      return;
    }
    // Only an explicit pick travels. The core starts a spawn that names no
    // model with the workspace default when the provider is the one it was
    // set for, so Start, the dialog and the CLI all agree without the
    // renderer holding a copy of the rule.
    const model = options.model;
    const launch: SessionLaunchState = {
      key: crypto.randomUUID(),
      workspaceId: target.id,
      taskId: task.id,
      name: task.title,
      tool: provider,
      startedAt: new Date().toISOString(),
      status: "starting",
    };
    setSessionLaunches((current) => [launch, ...current]);
    try {
      const response = await client.request.agentSpawn({
        workspace: target.id,
        taskId: task.id,
        provider,
        ...(model ? { model } : {}),
        ...(options.draftBrief ? { draftBrief: true } : {}),
      });
      if (response.ok) {
        setSessionLaunches((current) =>
          current.filter((item) => item.key !== launch.key),
        );
        await refresh();
        return response.data;
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
    } catch (cause) {
      setSessionLaunches((current) =>
        current.map((item) =>
          item.key === launch.key
            ? { ...item, status: "error", error: errorMessage(cause) }
            : item,
        ),
      );
    }
    return undefined;
  }

  function openSessionModal(task?: TaskDto) {
    setSessionForm({ name: task?.title ?? "", taskId: task?.id });
    // The dialog opens on what Start would launch, so "default" means the
    // same thing here and on the board.
    const target = task ? workspaceById.get(task.workspaceId) : workspace;
    if (
      target?.defaultProvider &&
      availableBoardProviders.includes(target.defaultProvider)
    )
      setSessionType(target.defaultProvider);
    setSessionModel("");
    setRememberSessionModel(false);
    setModelCatalogError(undefined);
    setModal("session");
  }

  function openRepositoryModal() {
    setSelectedRepositoryIds(new Set());
    setSelectedGitHubRepositories(new Set());
    setRepositoryDiscovery(undefined);
    setRepositoryForm({ remoteUrl: "", search: "" });
    setModal("repository");
    void loadRepositoryDiscovery();
  }

  function closeRepositoryModal() {
    setModal(undefined);
  }

  function closeSessionModal() {
    setSessionForm({ name: "" });
    setSessionModel("");
    setRememberSessionModel(false);
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
      setScope("workspace");
      setWorkspaceId(created.id);
      setWorkspaceForm({ name: "", slug: "", path: "" });
      setModal(undefined);
    }
  }

  /**
   * The board's capture line: a title, a `todo`, nothing else. Most tasks in
   * a workspace start as a line typed fast, and a modal is a reason not to.
   */
  async function quickCaptureTask(title: string): Promise<boolean> {
    // A task belongs to one workspace, and the board hides the capture line
    // while every workspace is showing; this is the guard behind it.
    if (!workspace || showingAll) return false;
    const created = await perform(
      client.request.taskCreate({ workspace: workspace.id, title }),
    );
    return Boolean(created);
  }

  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace || showingAll) return;
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
    if (!sessionWorkspace) return;
    const isTerminal = sessionType === "terminal";
    const launch: SessionLaunchState = {
      key: crypto.randomUUID(),
      workspaceId: sessionWorkspace.id,
      taskId: sessionForm.taskId,
      name: sessionForm.name,
      tool: isTerminal ? "terminal" : (sessionType as "codex" | "claude"),
      startedAt: new Date().toISOString(),
      status: "starting",
    };
    setSessionLaunches((current) => [launch, ...current]);
    setSessionForm({ name: "" });
    setRememberSessionModel(false);
    setModal(undefined);
    setView("sessions");
    try {
      // Remembered before the spawn, so a session that fails to start still
      // leaves the default the user asked for. An empty model is a real
      // choice too: it records "this provider, its own default".
      if (rememberSessionModel && !isTerminal)
        await perform(
          client.request.workspaceUpdate({
            reference: sessionWorkspace.id,
            defaultProvider: sessionType as BoardProvider,
            defaultModel: sessionModel || null,
          }),
        );
      const response = await client.request.agentSpawn({
        workspace: sessionWorkspace.id,
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
        openSession(response.data.id);
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

  /**
   * Starts every selected repository and closes.
   *
   * There is no progress to watch here any more: preparation happens in the
   * background and each repository shows its own state in the workspace, so a
   * window saying the same thing more loudly only stands between the user and
   * the thing they were doing. Only a repository that could not even be
   * started is worth reporting, and the error banner does that.
   */
  async function attachSelectedRepositories() {
    if (!workspace) return;
    const pending = [...selectedRepositoryIds].filter(
      (id) => !attachedLibraryRepositoryIds.has(id),
    );
    const pendingGitHub = (repositoryDiscovery?.repositories ?? []).filter(
      (item) => selectedGitHubRepositories.has(item.nameWithOwner),
    );
    if (pending.length === 0 && pendingGitHub.length === 0) return;
    closeRepositoryModal();
    const failures: string[] = [];
    await runWithConcurrency(
      [
        ...pendingGitHub.map((repository) => async () => {
          const started = await client.request.repositoryAddAndAttachStart({
            workspace: workspace.id,
            githubNameWithOwner: repository.nameWithOwner,
            remoteUrl: repository.remoteUrl,
          });
          if (!started.ok)
            failures.push(`${repository.name}: ${started.error.message}`);
        }),
        ...pending.map((libraryRepositoryId) => async () => {
          const attached = await client.request.workspaceRepositoryAttach({
            workspace: workspace.id,
            libraryRepositoryId,
          });
          if (!attached.ok) failures.push(attached.error.message);
        }),
      ],
      REPOSITORY_ADD_CONCURRENCY,
    );
    if (failures.length > 0) setError(failures.join("; "));
    await refreshWorkspaceContent();
    await refresh();
  }

  // Fetch, pull and push are the same shape: run one request, then re-read the
  // workspace so every status in the tree reflects what just happened.
  async function runRepositoryAction(
    key: string,
    request: () => Promise<RpcResult<unknown>>,
  ) {
    if (!workspace || pendingRepositoryActions.has(key)) return;
    setPendingRepositoryActions((current) => new Set(current).add(key));
    setError(undefined);
    try {
      const response = await request();
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
      setPendingRepositoryActions((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  async function detachWorkspaceRepository(repositoryId: string) {
    await runRepositoryAction(`detach:${repositoryId}`, () =>
      client.request.workspaceRepositoryDetach({ id: repositoryId }),
    );
  }

  async function fetchWorkspaceRepository(repositoryId: string) {
    await runRepositoryAction(`fetch:${repositoryId}`, () =>
      client.request.workspaceRepositoryFetch({ id: repositoryId }),
    );
  }

  async function pushSessionWorktree(worktree: SessionWorktreeDto) {
    await runRepositoryAction(
      `push:${worktree.sessionId}:${worktree.repositoryId}`,
      () =>
        client.request.sessionWorktreePush({
          session: worktree.sessionId,
          repository: worktree.repositoryId,
        }),
    );
  }

  /**
   * The picker's one submit path, so Enter does the obvious thing from
   * anywhere in the form: clone what was pasted, or add what was ticked.
   */
  async function submitRepositoryPicker(event?: React.FormEvent) {
    event?.preventDefault();
    if (!workspace || busy) return;
    if (!looksLikeRepositorySource(repositoryForm.search)) {
      if (selectedRepositoryCount > 0) await attachSelectedRepositories();
      return;
    }
    const started = await perform(
      client.request.repositoryAddAndAttachStart({
        workspace: workspace.id,
        remoteUrl: repositoryForm.search,
      }),
    );
    if (started) {
      setRepositoryForm({ remoteUrl: "", search: "" });
      closeRepositoryModal();
      await refreshWorkspaceContent();
    }
  }

  async function refreshWorkspaceContent() {
    if (!workspace) return;
    const content = await client.request.workspaceContentGet({
      workspace: workspace.id,
    });
    if (!content.ok) return;
    setWorkspaceContent(content.data);
    setWorkspaceDirectories((current) => ({
      ...current,
      "": content.data.files,
    }));
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
      setExpandedWorkspaceDirectories((current) => {
        const next = new Set(current)
          .add(selectedWorkspaceDirectory)
          .add(created.path);
        // The root is expanded by definition and is not a path anyone can
        // close, so it never belongs in what is remembered.
        next.delete("");
        rememberExpandedDirectories(workspace.id, next);
        return next;
      });
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

  /** Fetches the named folders again and writes them back into the cache. */
  async function relistDirectories(paths: readonly string[]) {
    if (!workspace || paths.length === 0) return;
    const listings = await Promise.all(
      paths.map(async (path) => {
        const listing = await client.request.workspaceDirectoryList({
          workspace: workspace.id,
          path: path || undefined,
        });
        return listing.ok ? ([path, listing.data] as const) : undefined;
      }),
    );
    const refreshed = listings.filter((entry) => entry !== undefined);
    if (refreshed.length > 0)
      setWorkspaceDirectories((current) => ({
        ...current,
        ...Object.fromEntries(refreshed),
      }));
  }

  /**
   * Follows an entry that moved, so the explorer ends up in the state the user
   * left it in rather than collapsing whatever they had open.
   *
   * The watcher would eventually re-list both parents on its own, but it would
   * leave the renamed folder closed and the open file unselected — it reports
   * two unrelated paths, and nothing on disk says they are the same entry.
   * Only the caller knows that, so only the caller can carry the state across.
   */
  async function followMovedEntry(from: string, to: string) {
    if (!workspace) return;
    const repath = (path: string) =>
      path === from
        ? to
        : path.startsWith(`${from}/`)
          ? to + path.slice(from.length)
          : path;
    const moved = [...expandedWorkspaceDirectories].filter(
      (path) => path === from || path.startsWith(`${from}/`),
    );
    if (moved.length > 0)
      setExpandedWorkspaceDirectories((current) => {
        const next = new Set([...current].map(repath));
        rememberExpandedDirectories(workspace.id, next);
        return next;
      });
    setWorkspaceDirectories((current) => {
      const next: Record<string, WorkspaceFileEntryDto[]> = {};
      for (const [path, entries] of Object.entries(current))
        if (path !== from && !path.startsWith(`${from}/`)) next[path] = entries;
      return next;
    });
    if (
      selectedWorkspaceDirectory === from ||
      selectedWorkspaceDirectory.startsWith(`${from}/`)
    )
      setSelectedWorkspaceDirectory(repath(selectedWorkspaceDirectory));
    const open = selectedWorkspaceFile;
    if (open && (open.path === from || open.path.startsWith(`${from}/`))) {
      const reopened = await client.request.workspaceFileRead({
        workspace: workspace.id,
        path: repath(open.path),
      });
      if (reopened.ok) {
        const wasEdited = workspaceDraft !== open.content;
        setSelectedWorkspaceFile(reopened.data);
        // A draft in progress belongs to the user, not to the path it was
        // opened from. It follows the file rather than being discarded.
        if (!wasEdited) setWorkspaceDraft(reopened.data.content);
      }
    }
    await relistDirectories([
      ...new Set([
        workspaceParentPath(from),
        workspaceParentPath(to),
        ...moved.map(repath),
      ]),
    ]);
  }

  async function renameWorkspaceEntry(path: string, name: string) {
    if (!workspace) return;
    const trimmed = name.trim();
    setRenamingEntry(undefined);
    if (!trimmed || trimmed === path.slice(path.lastIndexOf("/") + 1)) return;
    const renamed = await perform(
      client.request.workspaceEntryRename({
        workspace: workspace.id,
        path,
        name: trimmed,
      }),
    );
    if (renamed) await followMovedEntry(path, renamed.path);
  }

  async function moveWorkspaceEntry(entry: WorkspaceFileEntryDto) {
    if (!workspace) return;
    const from = workspaceParentPath(entry.path);
    const destination = window.prompt(
      `Move ${entry.name} into which folder? Leave empty for the workspace root.`,
      from,
    );
    if (destination === null) return;
    const moved = await perform(
      client.request.workspaceEntryMove({
        workspace: workspace.id,
        path: entry.path,
        destinationPath: destination.trim().replace(/^\/+|\/+$/g, ""),
      }),
    );
    if (moved) await followMovedEntry(entry.path, moved.path);
  }

  async function removeWorkspaceEntry(entry: WorkspaceFileEntryDto) {
    if (!workspace) return;
    if (
      !window.confirm(
        entry.kind === "directory"
          ? `Delete the folder ${entry.name} and everything inside it? This cannot be undone.`
          : `Delete ${entry.name}? This cannot be undone.`,
      )
    )
      return;
    const removed = await perform(
      client.request.workspaceEntryRemove({
        workspace: workspace.id,
        path: entry.path,
      }),
    );
    if (!removed) return;
    setWorkspaceDirectories((current) => {
      const next: Record<string, WorkspaceFileEntryDto[]> = {};
      for (const [path, entries] of Object.entries(current))
        if (path !== entry.path && !path.startsWith(`${entry.path}/`))
          next[path] = entries;
      return next;
    });
    setExpandedWorkspaceDirectories((current) => {
      const next = new Set(
        [...current].filter(
          (path) => path !== entry.path && !path.startsWith(`${entry.path}/`),
        ),
      );
      rememberExpandedDirectories(workspace.id, next);
      return next;
    });
    if (
      selectedWorkspaceFile &&
      (selectedWorkspaceFile.path === entry.path ||
        selectedWorkspaceFile.path.startsWith(`${entry.path}/`))
    ) {
      setSelectedWorkspaceFile(null);
      setWorkspaceDraft("");
    }
    if (
      selectedWorkspaceDirectory === entry.path ||
      selectedWorkspaceDirectory.startsWith(`${entry.path}/`)
    )
      setSelectedWorkspaceDirectory(workspaceParentPath(entry.path));
    await relistDirectories([workspaceParentPath(entry.path)]);
  }

  async function toggleWorkspaceDirectory(path: string) {
    if (!workspace) return;
    const isExpanded = expandedWorkspaceDirectories.has(path);
    if (isExpanded) {
      setExpandedWorkspaceDirectories((current) => {
        const next = new Set(current);
        next.delete(path);
        // Closing a folder closes what is inside it. Leaving the descendants
        // remembered would reopen them the next time the parent is opened,
        // which is not what closing a folder means.
        for (const entry of current)
          if (entry.startsWith(`${path}/`)) next.delete(entry);
        rememberExpandedDirectories(workspace.id, next);
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
    setExpandedWorkspaceDirectories((current) => {
      const next = new Set(current).add(path);
      rememberExpandedDirectories(workspace.id, next);
      return next;
    });
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

  // The button runs the same thing as `/daedalus-handoff`: a running agent
  // is asked to write its note and continue itself; a session that cannot
  // answer gets its successor straight away, working from brief and git.
  async function continueInNewAgent(session: AgentSessionDto) {
    if (session.status === "running") {
      await perform(client.request.agentRequestHandoff({ id: session.id }));
      return;
    }
    const successor = await perform(
      client.request.agentContinue({ id: session.id }),
    );
    if (successor) openSession(successor.id);
  }

  async function restoreSession(session: AgentSessionDto) {
    const restored = await perform(
      client.request.agentRestore({ id: session.id }),
    );
    if (restored) openSession(restored.id);
  }

  async function reviveSession(session: AgentSessionDto) {
    const revived = await perform(
      client.request.agentRevive({ id: session.id }),
    );
    if (revived) openSession(revived.id);
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
    if (restored) {
      setScope("workspace");
      setWorkspaceId(restored.id);
    }
  }

  async function createIntegratedTerminal(
    workspaceItem?: WorkspaceDto,
    location?: { name: string; workingDirectory: string },
  ) {
    setTerminalPanelOpen(true);
    const created = await perform(
      client.request.terminalCreate({
        workspace: workspaceItem?.id,
        name: location?.name ?? workspaceItem?.name,
        workingDirectory: location?.workingDirectory,
      }),
    );
    if (created) setActiveTerminalId(created.id);
  }

  async function removeSessionWorktree(
    worktree: SessionWorktreeDto,
    force: boolean,
  ) {
    await runRepositoryAction(
      `remove:${worktree.sessionId}:${worktree.repositoryId}`,
      () =>
        client.request.sessionWorktreeRemove({
          session: worktree.sessionId,
          repository: worktree.repositoryId,
          force,
        }),
    );
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
    setScope("workspace");
    setWorkspaceId(id);
    setSelectedTaskId(undefined);
    setActiveSessionId(undefined);
    // Restoring the Sessions mode re-arms `preferredSessionId`, so a focus
    // request left over from this workspace's previous visit could be
    // satisfied by a session the user never opened. Switching workspaces is
    // not an intent to type into whatever is restored.
    clearSessionFocusRequest();
    setView(preferredWorkspaceView(rememberedWorkspaceView(id)));
  }

  /** The card above the workspaces: every workspace's board and sessions. */
  function selectAllWorkspaces() {
    setScope("all");
    setSelectedTaskId(undefined);
    setActiveSessionId(undefined);
    clearSessionFocusRequest();
    setView(
      preferredScopeView(
        "all",
        rememberedWorkspaceView(ALL_WORKSPACES_SCOPE_KEY),
      ),
    );
  }

  /**
   * Leaves the all-workspaces scope for one workspace and lands on a view of
   * it. The scope effect restores that workspace's remembered view when the
   * scope key changes, so the ref is moved first: this is a deliberate
   * destination, not a return visit.
   */
  function enterWorkspace(id: string, nextView: WorkspaceView) {
    setScope("workspace");
    setWorkspaceId(id);
    viewWorkspaceId.current = id;
    setView(nextView);
  }

  // One repository with the working trees cut from it: the row the explorer
  // used to draw, now the body of a chip's popover in the header (#27).
  const renderRepositoryGroup = (
    repository: WorkspaceContentDto["repositories"][number],
  ) => {
    if (!workspace || !workspaceContent) return null;
    const worktrees = workspaceContent.worktrees.filter(
      (item) => item.repositoryId === repository.id,
    );
    const preparing = repository.status === "preparing";
    const failed = repository.status === "failed";
    return (
      <div className="workspace-repository-group" key={repository.id}>
        <div
          className={`workspace-resource-row repository-status-${repository.gitStatus?.state ?? "unavailable"} ${preparing ? "repository-preparing" : ""} ${failed ? "repository-failed" : ""}`}
        >
          <span>
            <strong>{repository.name}</strong>
            {preparing ? (
              <small>
                <span
                  aria-hidden="true"
                  className="repository-preparing-spinner"
                />
                Preparing…
              </small>
            ) : failed ? (
              <small
                className="repository-failed-reason"
                title={repository.statusError ?? undefined}
              >
                {repository.statusError ?? "Could not be prepared"}
              </small>
            ) : (
              <small
                title={repository.referencePath ?? repository.canonicalPath}
              >
                {repository.baseBranch ?? "Local"}
                {" · "}
                <span className="repository-git-status">
                  <i aria-hidden="true" />
                  {repositoryStatusText(repository.gitStatus)}
                </span>
              </small>
            )}
          </span>
          <span className="workspace-resource-actions">
            {failed && (
              <button
                aria-label={`Dismiss ${repository.name}`}
                className="quiet repository-action"
                onClick={() => void detachWorkspaceRepository(repository.id)}
                title="Remove this failed attachment"
                type="button"
              >
                <DismissIcon />
              </button>
            )}
            <button
              aria-label={`Open ${repository.name} in integrated terminal`}
              className="quiet repository-action"
              disabled={
                repository.status !== "ready" ||
                !repository.referencePath ||
                !snapshot?.settings.tmuxAvailable
              }
              onClick={() =>
                void createIntegratedTerminal(workspace, {
                  name: repository.name,
                  workingDirectory: repository.referencePath!,
                })
              }
              title="Open a terminal in this checkout"
              type="button"
            >
              <TerminalIcon />
            </button>
            <button
              aria-label={`Fetch ${repository.name}`}
              className={`quiet repository-action ${pendingRepositoryActions.has(`fetch:${repository.id}`) ? "syncing" : ""}`}
              disabled={
                repository.status !== "ready" ||
                pendingRepositoryActions.has(`fetch:${repository.id}`)
              }
              onClick={() => void fetchWorkspaceRepository(repository.id)}
              title={`Fetch, and move this checkout to the latest ${repository.baseBranch ?? "default branch"}`}
              type="button"
            >
              <RepositoryFetchIcon />
            </button>
          </span>
        </div>
        {worktrees.length === 0
          ? // A repository that has not arrived cannot
            // have working trees; saying so is noise.
            repository.status === "ready" && (
              <div className="workspace-worktree-row empty">
                No working trees
              </div>
            )
          : worktrees.map((worktree) => {
              const session = workspaceSessions.find(
                (item) => item.id === worktree.sessionId,
              );
              const key = `push:${worktree.sessionId}:${worktree.repositoryId}`;
              return (
                <div className="workspace-worktree-row" key={key}>
                  <span>
                    <strong>
                      {session
                        ? sessionName(session)
                        : worktree.sessionId.slice(0, 8)}
                    </strong>
                    <small title={worktree.path}>{worktree.branchName}</small>
                  </span>
                  <span className="workspace-worktree-status">
                    {gitStatusParts(worktree.gitStatus).map((part) => (
                      <em
                        className={`git-part tone-${part.tone}`}
                        key={part.key}
                      >
                        {part.text}
                      </em>
                    ))}
                  </span>
                  <button
                    aria-label={`Open ${worktree.branchName} in integrated terminal`}
                    className="quiet repository-action"
                    disabled={!snapshot?.settings.tmuxAvailable}
                    onClick={() =>
                      void createIntegratedTerminal(workspace, {
                        name: session ? sessionName(session) : repository.name,
                        workingDirectory: worktree.path,
                      })
                    }
                    title="Open a terminal in this working tree"
                    type="button"
                  >
                    <TerminalIcon />
                  </button>
                  <button
                    aria-label={`Push ${worktree.branchName}`}
                    className={`quiet repository-action ${pendingRepositoryActions.has(key) ? "syncing" : ""}`}
                    disabled={pendingRepositoryActions.has(key)}
                    onClick={() => void pushSessionWorktree(worktree)}
                    title={`Push ${worktree.branchName} to origin`}
                    type="button"
                  >
                    <RepositoryPushIcon />
                  </button>
                  <button
                    aria-label={`Remove ${worktree.branchName}`}
                    className={`quiet repository-action ${pendingRepositoryActions.has(`remove:${worktree.sessionId}:${worktree.repositoryId}`) ? "syncing" : ""}`}
                    disabled={pendingRepositoryActions.has(
                      `remove:${worktree.sessionId}:${worktree.repositoryId}`,
                    )}
                    onClick={() =>
                      setWorktreeAction({
                        worktree,
                        repositoryName: repository.name,
                        sessionLabel: session
                          ? sessionName(session)
                          : worktree.sessionId.slice(0, 8),
                      })
                    }
                    title="Remove this working tree"
                    type="button"
                  >
                    <DismissIcon />
                  </button>
                </div>
              );
            })}
      </div>
    );
  };

  const repositoriesReady =
    workspaceContent !== undefined &&
    workspaceContent.workspaceId === workspace?.id;
  // The board's right column is the workspace's, not the selected task's
  // (#27): the repositories with the working trees cut from each, as the
  // explorer used to draw them. The task's detail floats over it in a drawer.
  const workspaceRepositories = !repositoriesReady ? (
    <div className="empty">Loading repositories…</div>
  ) : workspaceContent.repositories.length === 0 ? (
    <div className="workspace-repository-invite">
      <strong>No repositories yet</strong>
      <span>
        Attach one and Daedalus keeps a read-only checkout here for planning,
        then gives each agent its own working tree off the latest base branch.
      </span>
      <button onClick={() => openRepositoryModal()} type="button">
        Add a repository
      </button>
    </div>
  ) : (
    <div className="workspace-repositories workspace-resource-list">
      {workspaceContent.repositories.map((repository) =>
        renderRepositoryGroup(repository),
      )}
    </div>
  );

  function closeTaskDrawer() {
    setSelectedTaskId(undefined);
    setEditingTask(false);
  }

  // The drawer's action bar reads the same lane inputs the board does, so
  // what it offers is what the task's card offers (#34).
  const laneInputs = {
    sessions: workspaceSessions,
    activity: activityById,
    attention: attentionById,
    worktrees: workspaceWorktrees,
  };
  const selectedTaskActions = selectedTask
    ? taskActions(selectedTask, laneFor(selectedTask, laneInputs), {
        ...laneInputs,
        launches: workspaceSessionLaunches,
        availableProviders: availableBoardProviders,
        tasksById: new Map(allTasks.map((task) => [task.id, task])),
      })
    : undefined;

  // The card above the workspaces (#35). Its roll-up is the workspace cards'
  // summed: what a dispatcher wants to know before choosing where to look.
  const everySession = (snapshot?.agents ?? []).filter(
    (session) =>
      !session.archivedAt &&
      activeWorkspaces.some((item) => item.id === session.workspaceId),
  );
  const everyLiveCount = everySession.filter(sessionIsLive).length;
  const everyAttentionCount = everySession.filter((session) =>
    sessionNeedsAttention(statusViewFor(session)),
  ).length;
  const everySessionLabel = `${everySession.length} ${everySession.length === 1 ? "session" : "sessions"}`;
  const allWorkspacesCard = activeWorkspaces.length > 0 && (
    <div
      className={`workspace-card all-workspaces-card ${showingAll ? "selected" : ""}`}
    >
      <button
        aria-current={showingAll ? "true" : undefined}
        aria-label={`All workspaces: ${everySessionLabel}, ${everyLiveCount} live, ${everyAttentionCount} need you`}
        className="workspace-item all-workspaces-item"
        onClick={selectAllWorkspaces}
        title={`${activeWorkspaces.length} ${activeWorkspaces.length === 1 ? "workspace" : "workspaces"} · ${everySessionLabel} · ${everyLiveCount} live · ${everyAttentionCount} need you`}
      >
        <span aria-hidden="true" className="all-workspaces-icon">
          <AllWorkspacesIcon />
        </span>
        <strong className="workspace-card-name">
          <span>All workspaces</span>
          {everyAttentionCount > 0 && (
            <span
              className="workspace-attention-badge"
              title={`${everyAttentionCount} ${everyAttentionCount === 1 ? "session needs" : "sessions need"} you`}
            >
              {everyAttentionCount}
            </span>
          )}
        </strong>
      </button>
    </div>
  );

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
      <h2>
        #{selectedTask.number} {selectedTask.title}
      </h2>
      <div className="task-meta">
        <TaskStatusMenu
          onChange={(status) =>
            void perform(
              client.request.taskSetStatus({ id: selectedTask.id, status }),
            )
          }
          status={selectedTask.status}
        />
        <TaskPriorityMenu
          onChange={(priority) =>
            void perform(
              client.request.taskUpdate({ id: selectedTask.id, priority }),
            )
          }
          priority={selectedTask.priority}
        />
      </div>
      {selectedTaskActions && (
        <TaskActionBar
          actions={selectedTaskActions}
          busy={busy}
          onDismissLaunch={dismissSessionLaunch}
          onDelete={() => void deleteTask(selectedTask)}
          onDraftBrief={() =>
            void startTaskSession(selectedTask, { draftBrief: true })
          }
          onEdit={() => setEditingTask(true)}
          onMarkDone={() =>
            void perform(
              client.request.taskSetStatus({
                id: selectedTask.id,
                status: "done",
              }),
            )
          }
          onOpenLink={openTerminalLink}
          onOpenSession={(session) => {
            setWorkspaceId(session.workspaceId);
            openSession(session.id);
            setView("sessions");
          }}
          onPark={() =>
            void perform(
              client.request.taskSetStatus({
                id: selectedTask.id,
                status: "blocked",
              }),
            )
          }
          onOpenWorktree={(worktree) =>
            void perform(
              client.request.sessionWorktreeOpen({
                session: worktree.sessionId,
                repository: worktree.repositoryId,
              }),
            )
          }
          onSecondOpinion={(provider) =>
            void startTaskSession(selectedTask, { provider })
          }
          onSetInProgress={() =>
            void perform(
              client.request.taskSetStatus({
                id: selectedTask.id,
                status: "in_progress",
              }),
            )
          }
          onStart={() => void startTaskSession(selectedTask)}
          onStartWith={() => openSessionModal(selectedTask)}
          task={selectedTask}
          tmuxAvailable={Boolean(snapshot?.settings.tmuxAvailable)}
        />
      )}
      <MarkdownPreview source={selectedTask.description} />
      <TaskRelationsBlock
        laneOf={(task) => laneFor(task, laneInputs)}
        onSelect={(task) => {
          setSelectedTaskId(task.id);
          setEditingTask(false);
        }}
        task={selectedTask}
        tasks={allTasks}
      />
      <TaskTimeline
        loading={taskTimelineLoading}
        onOpenJournal={(heading) => {
          setJournalTarget(heading);
          // The journal is a file of the task's workspace, and the Workspace
          // view shows one workspace's files.
          if (showingAll) enterWorkspace(selectedTask.workspaceId, "workspace");
          else setView("workspace");
        }}
        timeline={
          taskTimeline?.taskId === selectedTask.id ? taskTimeline : undefined
        }
      />
      {taskTimeline?.taskId === selectedTask.id && (
        <TaskCostLine cost={taskTimeline.cost} now={now} />
      )}
    </div>
  );

  async function deleteTask(task: TaskDto) {
    if (!window.confirm(`Permanently delete task “${task.title}”?`)) return;
    await perform(client.request.taskRemove({ id: task.id, force: true }));
    setSelectedTaskId(undefined);
  }

  /**
   * Entries Daedalus keeps pointing at by path. The service refuses these too
   * — it has to, because the RPC surface is reachable without the UI — but a
   * menu item that is going to fail is better greyed out than clickable.
   */
  /**
   * The service decides, and says so on every row it lists. The renderer used
   * to keep its own copy of the rule, and the copy drifted: it greyed out the
   * three managed folders but not the files Daedalus regenerates, so Delete
   * was offered on BRIEF.md, succeeded, and the content refetch that follows
   * every mutation put the file back before the tree redrew.
   */
  const workspaceEntryMutable = (entry: WorkspaceFileEntryDto) => entry.mutable;

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
      const renaming = renamingEntry?.path === entry.path;
      return (
        <div className="workspace-tree-entry" key={entry.path}>
          {renaming ? (
            // Deliberately not a <form>. The explorer's "new entry" field is
            // one, but a form here submits on Enter through the browser's own
            // implicit-submission path, which wedged the renderer outright in
            // the browser check — the handler never ran and the page stopped
            // answering. An input with its own keys has no such path, and it
            // is what the editor this imitates does anyway.
            <div
              className="workspace-tree-rename"
              style={{ paddingLeft: `${8 + depth * 14}px` }}
            >
              <input
                aria-label={`Rename ${entry.name}`}
                autoFocus
                onBlur={() =>
                  void renameWorkspaceEntry(entry.path, renamingEntry.name)
                }
                onChange={(event) =>
                  setRenamingEntry({
                    path: entry.path,
                    name: event.target.value,
                  })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void renameWorkspaceEntry(entry.path, renamingEntry.name);
                    return;
                  }
                  if (event.key !== "Escape") return;
                  // Escape has to win over the blur that follows it, or
                  // cancelling would commit whatever was half-typed.
                  event.preventDefault();
                  setRenamingEntry(undefined);
                }}
                value={renamingEntry.name}
              />
            </div>
          ) : (
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
              onContextMenu={(event) => {
                event.preventDefault();
                setEntryMenu({ entry, x: event.clientX, y: event.clientY });
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
          )}
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
      <ToastStack
        onDismiss={(ids) => void dismissToasts(ids)}
        onOpen={(toast) => {
          // Without the deep link people learn to ignore these.
          if (toast.workspaceId) selectWorkspace(toast.workspaceId);
          if (toast.sessionId) {
            openSession(toast.sessionId);
            setView("sessions");
          }
        }}
        toasts={snapshot?.toasts ?? []}
      />
      <header className="topbar">
        <div className="brand">
          <img
            alt=""
            aria-hidden="true"
            className="brand-mark"
            src="/daedalus-app-icon.png"
          />
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
            disabled={!workspace || showingAll}
            onClick={() => setView("workspace")}
            title={
              showingAll ? "Pick a workspace to browse its files" : undefined
            }
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
          <nav
            aria-label="Workspaces"
            className="item-list"
            data-reordering={workspaceReorder.draggingId ? "true" : undefined}
          >
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
            {allWorkspacesCard}
            {orderedWorkspaces.map((item) => {
              const itemSessions = (snapshot?.agents ?? []).filter(
                (session) =>
                  session.workspaceId === item.id && !session.archivedAt,
              );
              const liveCount = itemSessions.filter(sessionIsLive).length;
              // Blocked sessions come first so the five-icon truncation can
              // never be the reason a blocked session goes unnoticed.
              const itemViews = itemSessions
                .map((session) => ({ session, view: statusViewFor(session) }))
                .sort(
                  (left, right) =>
                    Number(right.view.attention) - Number(left.view.attention),
                );
              const attentionCount = itemViews.filter((item) =>
                sessionNeedsAttention(item.view),
              ).length;
              const sessionLabel = `${itemSessions.length} ${itemSessions.length === 1 ? "session" : "sessions"}`;
              const insightLabel = `${sessionLabel} in ${item.name}: ${liveCount} live, ${attentionCount} need you`;

              return (
                <div
                  className={`workspace-card ${!showingAll && item.id === workspaceId ? "selected" : ""}`}
                  data-dragging={
                    workspaceReorder.draggingId === item.id ? "true" : undefined
                  }
                  key={item.id}
                  onPointerDown={workspaceReorder.onPointerDown(item.id)}
                  ref={workspaceReorder.registerCard(item.id)}
                >
                  <button
                    className="workspace-item"
                    onClick={() => selectWorkspace(item.id)}
                    onKeyDown={(event) => {
                      if (!event.altKey) return;
                      const direction =
                        event.key === "ArrowUp"
                          ? "up"
                          : event.key === "ArrowDown"
                            ? "down"
                            : undefined;
                      if (
                        direction &&
                        workspaceReorder.moveByKeyboard(item.id, direction)
                      )
                        event.preventDefault();
                    }}
                  >
                    <span className="workspace-icon">
                      {item.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="workspace-card-content">
                      <strong className="workspace-card-name">
                        <span>{item.name}</span>
                        {/* A session blocked in a workspace nobody is looking
                            at has to be discoverable without clicking in. The
                            badge is a bare count so it survives a 210px
                            column; the line below spells it out. */}
                        {attentionCount > 0 && (
                          <span
                            aria-label={`${attentionCount} ${attentionCount === 1 ? "session needs" : "sessions need"} you in ${item.name}`}
                            className="workspace-attention-badge"
                            title={`${attentionCount} ${attentionCount === 1 ? "session needs" : "sessions need"} you`}
                          >
                            {attentionCount}
                          </span>
                        )}
                      </strong>
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
                          {itemViews.slice(0, 5).map(({ session, view }) => {
                            const tool = sessionTool(session);
                            return (
                              <span
                                className={`workspace-session-indicator tool-${tool}`}
                                data-attention={
                                  view.attention ? "true" : undefined
                                }
                                key={session.id}
                                title={statusAriaLabel(session, view, now)}
                              >
                                <ToolIcon tool={tool} />
                                <AgentStatusDot
                                  count={view.reasons.length}
                                  view={view}
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
                            ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} you`
                            : itemSessions.length > 0
                              ? `${liveCount} live · ${sessionLabel}`
                              : "No sessions"}
                        </small>
                      </span>
                    </span>
                  </button>
                  <span className="workspace-card-actions" data-no-drag>
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
                {showingAll && workspace
                  ? `${activeWorkspaces.length} ${activeWorkspaces.length === 1 ? "workspace" : "workspaces"}`
                  : (workspace?.slug ?? "Select a workspace")}
              </span>
              <h1>
                {showingAll && workspace
                  ? "All workspaces"
                  : (workspace?.name ?? "Workspace")}
              </h1>
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
                <div
                  className="workspace-browser"
                  style={
                    {
                      "--explorer-width": `${explorerWidth}px`,
                    } as CSSProperties
                  }
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
                    {entryMenu && (
                      <>
                        {/*
                          A full-window backdrop, so the next click anywhere
                          closes the menu. Without it the menu survives a click
                          on the tree behind it and two can be open at once.
                        */}
                        <div
                          className="workspace-tree-menu-backdrop"
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setEntryMenu(undefined);
                          }}
                          onPointerDown={() => setEntryMenu(undefined)}
                        />
                        <div
                          aria-label={`Actions for ${entryMenu.entry.name}`}
                          className="workspace-tree-menu"
                          // Opened at the pointer, then pulled back inside the
                          // window if it would hang off the bottom or the
                          // right. Measured rather than estimated: the menu's
                          // size depends on its labels and the theme's font.
                          ref={(node) => {
                            if (!node) return;
                            const box = node.getBoundingClientRect();
                            const overflowX = box.right - window.innerWidth + 8;
                            const overflowY =
                              box.bottom - window.innerHeight + 8;
                            if (overflowX > 0)
                              node.style.left = `${Math.max(8, entryMenu.x - overflowX)}px`;
                            if (overflowY > 0)
                              node.style.top = `${Math.max(8, entryMenu.y - overflowY)}px`;
                          }}
                          role="menu"
                          style={{ left: entryMenu.x, top: entryMenu.y }}
                        >
                          {entryMenu.entry.immutableReason && (
                            // Greyed-out items with no explanation read as
                            // broken ones. This was reported as "delete does
                            // nothing", and it was the menu's silence, not the
                            // action, that was wrong.
                            <small className="workspace-tree-menu-reason">
                              {entryMenu.entry.immutableReason}
                            </small>
                          )}
                          <button
                            disabled={!workspaceEntryMutable(entryMenu.entry)}
                            onClick={() => {
                              setRenamingEntry({
                                path: entryMenu.entry.path,
                                name: entryMenu.entry.name,
                              });
                              setEntryMenu(undefined);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            Rename
                          </button>
                          <button
                            disabled={!workspaceEntryMutable(entryMenu.entry)}
                            onClick={() => {
                              const target = entryMenu.entry;
                              setEntryMenu(undefined);
                              void moveWorkspaceEntry(target);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            Move to…
                          </button>
                          <button
                            className="destructive"
                            disabled={!workspaceEntryMutable(entryMenu.entry)}
                            onClick={() => {
                              const target = entryMenu.entry;
                              setEntryMenu(undefined);
                              void removeWorkspaceEntry(target);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </aside>

                  <div
                    aria-label="Resize explorer"
                    aria-orientation="vertical"
                    aria-valuemax={EXPLORER_MAX_WIDTH}
                    aria-valuemin={EXPLORER_MIN_WIDTH}
                    aria-valuenow={explorerWidth}
                    className="column-resize-handle explorer-resize-handle"
                    onKeyDown={(event) => {
                      if (
                        event.key !== "ArrowLeft" &&
                        event.key !== "ArrowRight"
                      )
                        return;
                      event.preventDefault();
                      setExplorerWidth((width) =>
                        clampExplorerWidth(
                          width +
                            (event.key === "ArrowRight"
                              ? PANEL_STEP
                              : -PANEL_STEP),
                          EXPLORER_MAX_WIDTH,
                        ),
                      );
                    }}
                    onPointerDown={startExplorerWidthResize}
                    role="separator"
                    tabIndex={0}
                  />

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
            <BoardView
              activity={activityById}
              attention={attentionById}
              availableProviders={availableBoardProviders}
              busy={busy}
              launches={workspaceSessionLaunches}
              modelCatalogs={modelCatalogs}
              now={now}
              onCreateTask={() => setModal("task")}
              onDismissLaunch={dismissSessionLaunch}
              onDraftBrief={(task) =>
                void startTaskSession(task, { draftBrief: true })
              }
              onQuickCapture={quickCaptureTask}
              onAnswer={async (session, text) =>
                Boolean(
                  await perform(
                    client.request.agentSend({ id: session.id, text }),
                  ),
                )
              }
              onMarkDone={(task) =>
                void perform(
                  client.request.taskSetStatus({ id: task.id, status: "done" }),
                )
              }
              onOpenWorktree={(worktree) =>
                void perform(
                  client.request.sessionWorktreeOpen({
                    session: worktree.sessionId,
                    repository: worktree.repositoryId,
                  }),
                )
              }
              onPark={(task) =>
                void perform(
                  client.request.taskSetStatus({
                    id: task.id,
                    status: "blocked",
                  }),
                )
              }
              onSecondOpinion={(task, provider) =>
                void startTaskSession(task, { provider })
              }
              onStartNext={(task) => void startTaskSession(task)}
              onNeedModels={ensureModelCatalog}
              onOpenLink={openTerminalLink}
              onOpenSession={(session) => {
                // The Sessions view lists this scope's sessions, so the
                // scope stays; the workspace underneath follows the session
                // so the terminal heading and the content loaders agree.
                setWorkspaceId(session.workspaceId);
                openSession(session.id);
                setView("sessions");
              }}
              onSelectTask={(task) => {
                setSelectedTaskId(task.id);
                setEditingTask(false);
              }}
              onSetInProgress={(task) =>
                void perform(
                  client.request.taskSetStatus({
                    id: task.id,
                    status: "in_progress",
                  }),
                )
              }
              onStart={(task) => void startTaskSession(task)}
              onStartWith={(task) => openSessionModal(task)}
              onUpdateSettings={(changes) =>
                void perform(
                  client.request.workspaceUpdate({
                    reference: workspace.id,
                    ...changes,
                  }),
                )
              }
              selectedTaskId={selectedTaskId}
              sessions={workspaceSessions}
              tasks={allTasks}
              telemetry={telemetryById}
              tmuxAvailable={Boolean(snapshot?.settings.tmuxAvailable)}
              workspace={showingAll ? undefined : workspace}
              workspaces={activeWorkspaces}
              worktrees={workspaceWorktrees}
            />
          ) : (
            <>
              <div className="sessions-toolbar">
                <div>
                  <strong>Sessions</strong>
                  <span className="count-badge">
                    {sessions.length + visibleSessionLaunches.length}
                  </span>
                  <button
                    aria-pressed={sessionFilter === "needs-me"}
                    className={`quiet session-filter-toggle${sessionFilter === "needs-me" ? " active" : ""}`}
                    disabled={
                      attentionSessionIds.size === 0 && sessionFilter === "all"
                    }
                    onClick={() =>
                      setSessionFilter((current) =>
                        current === "needs-me" ? "all" : "needs-me",
                      )
                    }
                    title="Show only sessions waiting on you"
                    type="button"
                  >
                    Needs me
                    {attentionSessionIds.size > 0 && (
                      <span className="session-filter-count">
                        {attentionSessionIds.size}
                      </span>
                    )}
                  </button>
                </div>
                <div className="panel-heading-actions">
                  <CreateButton
                    disabled={!snapshot?.settings.tmuxAvailable || showingAll}
                    label="Create session"
                    onClick={() => openSessionModal()}
                    title={
                      showingAll
                        ? "Pick a workspace to start a session in, or Start a task from the board"
                        : undefined
                    }
                  />
                  <PanelCollapseButton
                    collapsed={sessionsPanelWidth < PANEL_COMPACT_THRESHOLD}
                    label="sessions"
                    onClick={toggleSessionsPanel}
                    side="left"
                  />
                </div>
              </div>
              <div
                className="session-grid item-list"
                data-reordering={sessionReorder.draggingId ? "true" : undefined}
              >
                {sessions.length === 0 &&
                  visibleSessionLaunches.length === 0 &&
                  (sessionFilter === "needs-me" ? (
                    <div className="empty large">
                      <strong>Nothing is waiting on you</strong>
                      <span>Every session is working or finished.</span>
                    </div>
                  ) : (
                    <div className="empty large">
                      <strong>No sessions yet</strong>
                      <span>Create an agent or free terminal.</span>
                    </div>
                  ))}
                {visibleSessionLaunches.map((launch) => (
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
                    {launch.status === "error" && (
                      <button
                        aria-label={`Dismiss failed ${launch.name} session`}
                        className="session-card-action"
                        onClick={() => dismissSessionLaunch(launch.key)}
                        title="Dismiss"
                        type="button"
                      >
                        <DismissIcon />
                      </button>
                    )}
                  </div>
                ))}
                {orderedSessions.map((session) => {
                  const task = allTasks.find(
                    (item) => item.id === session.taskId,
                  );
                  const tool = sessionTool(session);
                  const timestamp = session.endedAt ?? session.startedAt;
                  const startupError = sessionStartupErrors.get(session.id);
                  const view = statusViewFor(session);
                  return (
                    <div
                      className={`session-card tone-${view.tone} ${session.id === activeSessionId ? "selected" : ""}`}
                      data-attention={view.attention ? "true" : undefined}
                      data-dragging={
                        sessionReorder.draggingId === session.id
                          ? "true"
                          : undefined
                      }
                      key={session.id}
                      onPointerDown={sessionReorder.onPointerDown(session.id)}
                      ref={sessionReorder.registerCard(session.id)}
                    >
                      <button
                        className="session-card-main"
                        data-provider={session.provider}
                        data-session-id={session.id}
                        onClick={() => openSession(session.id)}
                        onKeyDown={(event) => {
                          if (!event.altKey) return;
                          const direction =
                            event.key === "ArrowUp"
                              ? "up"
                              : event.key === "ArrowDown"
                                ? "down"
                                : undefined;
                          if (
                            direction &&
                            sessionReorder.moveByKeyboard(session.id, direction)
                          )
                            event.preventDefault();
                        }}
                      >
                        <span className={`session-kind-icon tool-${tool}`}>
                          <ToolIcon tool={tool} />
                        </span>
                        <span>
                          <strong>{sessionName(session)}</strong>
                          <small>
                            {showingAll && (
                              <span className="session-card-workspace">
                                {workspaceById.get(session.workspaceId)?.slug ??
                                  session.workspaceId}
                                {" · "}
                              </span>
                            )}
                            {task?.title ?? "Workspace session"}
                          </small>
                          <em>
                            <AgentStatusDot
                              count={view.reasons.length}
                              label={statusAriaLabel(session, view, now)}
                              view={view}
                            />
                            <span className="session-status-label">
                              {startupError ? "failed to start" : view.label}
                              {view.attention && view.since
                                ? ` · waiting ${waitingLabel(view.since, now)}`
                                : ""}{" "}
                              · {session.id.slice(0, 6)}
                            </span>
                            {view.unconfirmed && (
                              <span
                                className="session-status-unconfirmed"
                                title="Read from the terminal pane, not reported by the agent"
                              >
                                unconfirmed
                              </span>
                            )}
                          </em>
                          {view.detail && (
                            <em className="session-status-detail">
                              {view.detail}
                            </em>
                          )}
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
                      {session.status === "lost" && (
                        <button
                          aria-label={`Revive ${sessionName(session)} session`}
                          className="session-card-action"
                          data-no-drag
                          disabled={busy}
                          onClick={() => void reviveSession(session)}
                          title="Resume this conversation in a new terminal"
                        >
                          ↻
                        </button>
                      )}
                      <span className="workspace-card-actions" data-no-drag>
                        {session.kind === "agent" &&
                          (session.provider === "claude" ||
                            session.provider === "codex") && (
                            <button
                              aria-label={`Continue ${sessionName(session)} in a new agent`}
                              className="session-card-action session-handoff-action"
                              data-handoff-requested={
                                session.handoffRequestedAt ? "true" : undefined
                              }
                              disabled={busy}
                              onClick={() => void continueInNewAgent(session)}
                              title={
                                session.handoffRequestedAt
                                  ? "Handoff requested; the agent is writing its note. Click to ask again."
                                  : session.status === "running"
                                    ? "Continue in a new agent: this one writes a handoff note, then a fresh agent with an empty context takes over in the same working directory"
                                    : "Continue in a new agent: a fresh agent takes over in the same working directory, working from the brief, the journal and git"
                              }
                              type="button"
                            >
                              <HandoffIcon />
                            </button>
                          )}
                        <button
                          aria-label={`Archive ${sessionName(session)} session`}
                          className="session-card-action"
                          onClick={() => setSessionAction({ session })}
                          title="Archive session"
                          type="button"
                        >
                          <ArchiveIcon />
                        </button>
                      </span>
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

        {workspace &&
          (view === "sessions" || (view === "board" && !showingAll)) && (
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

        {/* The column is one workspace's repositories, so with every
            workspace showing there is none; the board takes the width. */}
        {view === "board" && workspace && !showingAll && (
          <aside
            className={`board-detail-column ${boardDetailPanelWidth < PANEL_COMPACT_THRESHOLD ? "panel-compact" : ""}`}
          >
            <div className="section-heading">
              <div>
                <span className="eyebrow">Workspace</span>
                <h1>Repositories</h1>
              </div>
              <div className="panel-heading-actions">
                {repositoriesReady && (
                  <small className="count-badge">
                    {workspaceContent.repositories.length}
                  </small>
                )}
                <button
                  aria-label="Add repository"
                  className="quiet"
                  onClick={() => openRepositoryModal()}
                  title="Add repository"
                  type="button"
                >
                  + Add
                </button>
                <PanelCollapseButton
                  collapsed={boardDetailPanelWidth < PANEL_COMPACT_THRESHOLD}
                  label="workspace"
                  onClick={toggleBoardDetailPanel}
                  side="right"
                />
              </div>
            </div>
            {workspaceRepositories}
          </aside>
        )}

        {view === "board" && workspace && selectedTask && (
          <section
            aria-label={`Task #${selectedTask.number}`}
            className="task-drawer"
            role="dialog"
          >
            <div className="section-heading">
              <div>
                <span className="eyebrow">Task #{selectedTask.number}</span>
                <h1>Task brief</h1>
              </div>
              <div className="panel-heading-actions">
                <button
                  aria-label="Close task"
                  className="quiet task-drawer-close"
                  onClick={closeTaskDrawer}
                  title="Close (Esc)"
                  type="button"
                >
                  <DismissIcon />
                </button>
              </div>
            </div>
            {taskInspector}
          </section>
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
                activity={activityById.get(activeSession.id)}
                attention={attentionById.get(activeSession.id)}
                terminalEndpoint={terminalEndpoint}
                focused={shouldFocusSession(focusedSessionId, activeSession.id)}
                fitRevision={terminalFitRevision}
                id={activeSession.id}
                key={`${activeSession.id}:${terminalMountRevision}`}
                label={sessionName(activeSession)}
                locationLabel={
                  activeSessionRepository?.name ??
                  activeSessionWorkspace?.name ??
                  workspace.name
                }
                onClearAttention={() => void clearAttention(activeSession.id)}
                onFocused={clearSessionFocusRequest}
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
                    terminalEndpoint={terminalEndpoint}
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
                    title={
                      terminal.revivedAt
                        ? `${terminal.workingDirectory} — reopened after a restart, scrollback not restored`
                        : terminal.workingDirectory
                    }
                    type="button"
                  >
                    <span
                      className={`agent-dot tone-${lifecycleTone(terminal.status)}`}
                    />
                    <span className="integrated-terminal-tab-copy">
                      <strong>
                        {terminal.name}
                        {terminal.revivedAt && (
                          <span
                            aria-label="reopened after a restart, scrollback not restored"
                            className="integrated-terminal-revived"
                          >
                            ↻
                          </span>
                        )}
                      </strong>
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
          title="Add repositories"
          wide
        >
          <form className="repository-picker" onSubmit={submitRepositoryPicker}>
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
                    // Down enters the list. Enter is left alone: it submits
                    // the form, which is what it should do from here.
                    if (event.key !== "ArrowDown") return;
                    event.preventDefault();
                    moveRepositoryFocus(event.currentTarget, 1);
                  }}
                />
                <button
                  className="quiet"
                  disabled={
                    busy || !looksLikeRepositorySource(repositoryForm.search)
                  }
                  onClick={() => void submitRepositoryPicker()}
                  type="button"
                >
                  Clone URL/path
                </button>
              </div>
            </label>

            <div
              className="repository-picker-results repository-unified-results"
              onKeyDown={(event) => {
                const delta =
                  event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowUp"
                      ? -1
                      : 0;
                if (!delta) return;
                event.preventDefault();
                moveRepositoryFocus(event.target as HTMLElement, delta);
              }}
            >
              <div className="repository-result-summary">
                <span>
                  {repositorySearch ? "Best matches" : "All repositories"}
                </span>
                <small>
                  {repositoryCandidates.length}
                  {repositoryDiscoveryLoading ? " + discovering GitHub…" : ""}
                </small>
              </div>
              {repositoryCandidates.map((candidate) => {
                const option =
                  candidate.kind === "library"
                    ? {
                        key: candidate.repository.id,
                        name: candidate.repository.name,
                        detail: candidate.repository.remoteUrl,
                        trailing: candidate.repository.defaultBranch,
                        source: "Local",
                        attached: attachedLibraryRepositoryIds.has(
                          candidate.repository.id,
                        ),
                        selected: selectedRepositoryIds.has(
                          candidate.repository.id,
                        ),
                      }
                    : {
                        key: `github:${candidate.repository.nameWithOwner}`,
                        name: candidate.repository.name,
                        detail: candidate.repository.nameWithOwner,
                        trailing: "GitHub",
                        source: "Clone",
                        attached: false,
                        selected: selectedGitHubRepositories.has(
                          candidate.repository.nameWithOwner,
                        ),
                      };
                const checked = option.attached || option.selected;
                return (
                  <label
                    className={`${option.selected ? "selected" : ""} ${option.attached ? "attached" : ""}`}
                    key={option.key}
                  >
                    {/* A real checkbox inside the form, so Space toggles it
                            and Enter submits, with neither wired up here. */}
                    <input
                      checked={checked}
                      data-repository-option="true"
                      disabled={busy || option.attached}
                      onChange={() => toggleRepositoryCandidate(option.key)}
                      type="checkbox"
                    />
                    <span
                      aria-hidden="true"
                      className="repository-picker-check"
                    >
                      {checked ? "✓" : ""}
                    </span>
                    <span>
                      <strong>{option.name}</strong>
                      <small>{option.detail}</small>
                    </span>
                    <span>
                      <strong>
                        {option.attached ? "Added" : option.trailing}
                      </strong>
                      <small>{option.source}</small>
                    </span>
                  </label>
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
                      <span>Run `gh auth login`, then reopen this picker.</span>
                    </>
                  )}
                </div>
              )}
            </div>

            <small className="repository-clone-destination">
              New clones are stored once in {snapshot?.settings.repositoryRoot}.
            </small>
            <div className="modal-actions">
              <span className="repository-selection-count">
                {selectedRepositoryCount
                  ? `${selectedRepositoryCount} selected`
                  : "Select one or more repositories"}
              </span>
              <button
                className="quiet"
                onClick={closeRepositoryModal}
                type="button"
              >
                Cancel
              </button>
              <button
                disabled={busy || !canSubmitRepositoryPicker}
                type="submit"
              >
                {selectedRepositoryCount === 1
                  ? "Add repository"
                  : selectedRepositoryCount > 1
                    ? `Add ${selectedRepositoryCount} repositories`
                    : looksLikeRepositorySource(repositoryForm.search)
                      ? "Clone and add"
                      : "Add selected"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === "session" && sessionWorkspace && snapshot && (
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
                        setRememberSessionModel(false);
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
                      {workspaceDefaultModel
                        ? `Workspace default · ${workspaceDefaultModelEntry?.label ?? workspaceDefaultModel}${workspaceDefaultModelStale ? " (not offered any more)" : ""}`
                        : `Provider default${
                            sessionModelCatalog?.defaultModel
                              ? ` · ${sessionDefaultModel?.label ?? sessionModelCatalog.defaultModel}`
                              : " · Automatic"
                          }`}
                    </option>
                  )}
                  {sessionModelCatalog?.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                      {model.resolvedModel ? ` · ${model.resolvedModel}` : ""}
                    </option>
                  ))}
                </select>
                <small
                  className={
                    workspaceDefaultModelStale && !sessionModel
                      ? "session-model-error"
                      : "session-model-description"
                  }
                >
                  {sessionModelCatalogPending || modelCatalogLoading
                    ? "Reading the models available to your account"
                    : (selectedSessionModel?.description ??
                      (sessionModel
                        ? `Use ${sessionModel} for this session`
                        : workspaceDefaultModelStale
                          ? `${providerLabel(sessionType)} no longer offers ${workspaceDefaultModel}. Pick a model here, or change the default in board settings; until then a session started without one refuses.`
                          : workspaceDefaultModel
                            ? "Set in board settings. Every new session of this provider in this workspace starts with it unless one is picked here."
                            : sessionType === "claude"
                              ? "Claude's recommended model, asked for by name, so a /model change made inside a session does not carry into new ones."
                              : sessionModelCatalog?.defaultModel
                                ? "The model Codex is configured with"
                                : "The provider chooses its current default"))}
                </small>
                {modelCatalogError && (
                  <small className="session-model-error">
                    Model list unavailable: {modelCatalogError}
                  </small>
                )}
              </label>
            )}
            {sessionType !== "terminal" && !sessionChoiceIsWorkspaceDefault && (
              <label className="session-model-remember">
                <input
                  checked={rememberSessionModel}
                  onChange={(event) =>
                    setRememberSessionModel(event.target.checked)
                  }
                  type="checkbox"
                />
                <span>
                  Remember{" "}
                  <strong>
                    {providerLabel(sessionType)} ·{" "}
                    {selectedSessionModel?.label ??
                      (sessionModel || "provider default")}
                  </strong>{" "}
                  as this workspace&apos;s default
                </span>
              </label>
            )}
            <div className="session-workspace-note">
              <span className="workspace-icon">
                {sessionWorkspace.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{sessionWorkspace.name}</strong>
                <small>Opens in {sessionWorkspace.path}</small>
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
        <Modal onClose={() => setModal(undefined)} title="Settings" wide>
          <SettingsModal
            busy={busy}
            client={client}
            onError={setError}
            onFocusMode={(enabled) => void setFocusMode(enabled)}
            onSection={setSettingsSection}
            onTheme={(value) => {
              setTheme(value);
              window.localStorage.setItem("daedalus.theme", value);
            }}
            perform={perform}
            section={settingsSection}
            settings={snapshot.settings}
            theme={theme}
          />
        </Modal>
      )}

      {worktreeAction &&
        (() => {
          const status = worktreeAction.worktree.gitStatus;
          const unsaved = status?.changedFiles ?? 0;
          const unpushed = status?.ahead ?? 0;
          const holdsWork = unsaved > 0 || unpushed > 0;
          return (
            <Modal
              onClose={() => setWorktreeAction(undefined)}
              title="Remove working tree"
            >
              <div className="confirmation-content">
                <p>
                  Remove the <strong>{worktreeAction.repositoryName}</strong>{" "}
                  working tree for{" "}
                  <strong>{worktreeAction.sessionLabel}</strong>?
                </p>
                <p>
                  {holdsWork ? (
                    <>
                      It has{" "}
                      {unsaved > 0 &&
                        `${unsaved} uncommitted ${unsaved === 1 ? "change" : "changes"}`}
                      {unsaved > 0 && unpushed > 0 && " and "}
                      {unpushed > 0 &&
                        `${unpushed} unpushed ${unpushed === 1 ? "commit" : "commits"}`}
                      . Removing it discards that permanently. Push first if you
                      want to keep it.
                    </>
                  ) : (
                    <>
                      Nothing is uncommitted and nothing is unpushed, so the
                      directory and its branch can go without losing anything.
                    </>
                  )}
                </p>
                <div className="modal-actions">
                  <button
                    className="quiet"
                    onClick={() => setWorktreeAction(undefined)}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    autoFocus={!holdsWork}
                    className={holdsWork ? "danger-action" : ""}
                    onClick={() => {
                      const pending = worktreeAction;
                      setWorktreeAction(undefined);
                      void removeSessionWorktree(pending.worktree, holdsWork);
                    }}
                    type="button"
                  >
                    {holdsWork ? "Discard and remove" : "Remove"}
                  </button>
                </div>
              </div>
            </Modal>
          );
        })()}
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

      {quitRequest && (
        <Modal
          dismissible={!quitting}
          onClose={() => answerQuit("cancel")}
          title="Quit Daedalus"
        >
          <div className="confirmation-content">
            <p>
              {quitDisclosure(quitRequest)} Reopening Daedalus reconnects to
              them. Stopping them instead resumes them when you reopen.
            </p>
            <div className="modal-actions">
              <button
                className="quiet"
                disabled={Boolean(quitting)}
                onClick={() => answerQuit("cancel")}
                type="button"
              >
                Cancel
              </button>
              {/* Never the focused button: it is the only one that ends
                  anything, and Enter must not reach it by accident. */}
              <button
                className="danger-action"
                disabled={Boolean(quitting)}
                onClick={() => answerQuit("shutdown")}
                type="button"
              >
                {quitting === "shutdown"
                  ? "Stopping\u2026"
                  : "Quit and stop sessions"}
              </button>
              <button
                autoFocus
                disabled={Boolean(quitting)}
                onClick={() => answerQuit("keep")}
                type="button"
              >
                Quit
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}

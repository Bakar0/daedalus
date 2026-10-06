import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  lazy,
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type {
  FileLinkTargetDto,
  AppUpdateDto,
  TaskTimelineDto,
  AgentActivity,
  AgentActivityDto,
  AgentSessionDto,
  AttentionReasonDto,
  DesktopCommand,
  DesktopSnapshotDto,
  GitStatusDto,
  RepositoryFetchOutcomeDto,
  IntegratedTerminalDto,
  ProviderModelCatalogDto,
  SessionTelemetryDto,
  SessionWorktreeDto,
  QuitChoice,
  RepositoryDiscoveryDto,
  RoutinesDetailDto,
  RpcResult,
  SessionColorDto,
  SessionAttentionDto,
  ShutdownPlanDto,
  TaskDto,
  WorkspaceContentDto,
  WorkspaceDto,
  ToastDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { SettingsModal, type SettingsSection } from "./SettingsModal";
import { UpdateBanner } from "./UpdateBanner";
import { runWithConcurrency } from "./concurrency";
import { wholeLinkRows, type LinkRange } from "./terminal-links";
import { findPathCandidates } from "./terminal-file-links";
import { repositoryFuzzyScore } from "./repository-search";
import { ReorderGroup } from "./ReorderGroup";
import { useListReorder, type ReorderHandles } from "./use-list-reorder";
import { BoardView, TaskRelationsBlock, type BoardProvider } from "./BoardView";
import { laneFor } from "./board-lanes";
import { taskActions } from "./task-actions";
import { TaskCostLine, TaskTimeline } from "./TaskTimeline";
import { TaskActionBar } from "./TaskActionBar";
import { askConfirm, askText, DialogHost } from "./dialogs";
import { type FileOpenRequest, FilesView } from "./files/FilesView";
import {
  ChangedFileList,
  useWorktreeChanges,
  WorktreeCommits,
  worktreeKey,
} from "./files/ChangesView";
import type { DiffTarget } from "./files/EditorArea";
import { MarkdownPreview } from "./markdown-preview";
import { buildWorldModel, worldInputFromSnapshot } from "./world/world-model";
import { TaskPriorityMenu, TaskStatusMenu } from "./TaskStatusMenu";
import { ColorSwatches, SessionMenu } from "./SessionMenu";
import { RoutineBar } from "./routines/RoutineBar";
import { RoutinesPanel } from "./routines/RoutinesPanel";
import {
  AgentStatusDot,
  compactTokenLabel,
  lifecycleTone,
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

// Pixi is about 290 kB (87 kB gzipped) that the app only needs once someone
// opens the World, so the view and everything under it load on first open.
const WorldView = lazy(() => import("./world/WorldView"));

export { MarkdownPreview };

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

// The workspace column holds the session lists (#55), so it no longer folds
// to a rail; this is as narrow as it goes.
export const WORKSPACE_PANEL_MIN_WIDTH = 200;
const WORKSPACE_PANEL_DEFAULT_WIDTH = 248;
export const clampWorkspacePanelSize = (size: number, maximum: number) =>
  Math.min(Math.max(WORKSPACE_PANEL_MIN_WIDTH, Math.round(size)), maximum);

const storedPanelSize = (key: string, fallback: number) => {
  if (typeof window === "undefined") return fallback;
  const stored = Number(window.localStorage.getItem(key));
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
};

export {
  clampExplorerWidth,
  EXPLORER_DEFAULT_WIDTH,
  EXPLORER_MAX_WIDTH,
  EXPLORER_MIN_WIDTH,
  type ExplorerRefreshPlan,
  parseRememberedDirectories,
  planExplorerRefresh,
} from "./files/explorer-state";

const COLLAPSED_WORKSPACES_STORAGE_KEY = "daedalus.workspaces.collapsed";

/**
 * The workspaces whose session lists are folded away in the left column
 * (#55). Lists start open, so only the folded ones are stored.
 */
export function parseCollapsedWorkspaces(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

const rememberedCollapsedWorkspaces = () => {
  if (typeof window === "undefined") return new Set<string>();
  try {
    return parseCollapsedWorkspaces(
      window.localStorage.getItem(COLLAPSED_WORKSPACES_STORAGE_KEY),
    );
  } catch {
    return new Set<string>();
  }
};

const lastSessionStorageKey = (workspaceId: string) =>
  `daedalus.session.last.${workspaceId}`;

const lastViewStorageKey = (workspaceId: string) =>
  `daedalus.view.last.${workspaceId}`;

/**
 * What the main column shows. "session" is one session's terminal, opened
 * from the session lists nested under each workspace in the left column; it
 * has no tab of its own (#55).
 */
export type WorkspaceView = "board" | "session" | "workspace" | "world";

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
  // Files and a session's terminal belong to one workspace; every workspace
  // at once is the board and the World only.
  return scope === "all" &&
    (preferred === "workspace" || preferred === "session")
    ? "board"
    : preferred;
}

export function preferredWorkspaceView(
  rememberedView?: string | null,
): WorkspaceView {
  // Board first, and first by default. The board is where a dispatcher starts
  // the day, and since #27 it also holds the repositories and the add button,
  // so a workspace with nothing attached yet is fixed from here too.
  // "sessions" is the tab that #55 removed; its list now lives in the left
  // column, so a workspace left on it comes back to its session.
  if (rememberedView === "sessions") return "session";
  return rememberedView === "session" ||
    rememberedView === "workspace" ||
    rememberedView === "world"
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

/** A folder: one workspace, beside its name in the left column (#55). */
function WorkspaceFolderIcon() {
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
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
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

/** Fetch: download from the remote. Nothing in a checkout moves. */
function RepositoryFetchIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.3"
      viewBox="0 0 16 16"
    >
      <path d="M4.5 11.5H4a3 3 0 0 1-.3-6 4.2 4.2 0 0 1 8.1 1A2.5 2.5 0 0 1 12 11.5h-.5" />
      <path d="M8 7.5v6M5.8 11.3 8 13.5l2.2-2.2" />
    </svg>
  );
}

/** Pull: bring the checkout up to the latest base branch. */
function RepositoryPullIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.3"
      viewBox="0 0 16 16"
    >
      <path d="M8 1.5v7M5.5 6 8 8.5 10.5 6" />
      <circle cx="8" cy="12" r="2" />
      <path d="M2 12h4M10 12h4" />
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

// What a working tree holds, in the order it reads: what is uncommitted here,
// then whether its commits still need anything. "↑" counts only commits no
// branch on origin has, which is what is waiting to be pushed. Counting every
// commit ahead of the base branch showed work that was pushed and merged
// long ago as if it were still to push.
export function gitStatusParts(
  status: GitStatusDto | undefined,
  landed = false,
) {
  if (!status || status.state === "unavailable") return [];
  const parts: Array<{
    key: string;
    tone: string;
    text: string;
    title?: string;
  }> = [];
  if (status.changedFiles)
    parts.push({
      key: "changed",
      tone: "modified",
      text: `~${status.changedFiles}`,
      title: `${status.changedFiles} uncommitted ${status.changedFiles === 1 ? "change" : "changes"}`,
    });
  const unpushed = status.unpushed ?? status.ahead;
  if (landed)
    parts.push({
      key: "merged",
      tone: "merged",
      text: "merged",
      title:
        "Its pull request is merged, so these commits are on the base branch",
    });
  else if (unpushed > 0)
    parts.push({
      key: "ahead",
      tone: "ahead",
      text: `↑${unpushed}`,
      title: `${unpushed} ${unpushed === 1 ? "commit" : "commits"} not on origin yet`,
    });
  else if (status.ahead > 0)
    parts.push({
      key: "pushed",
      tone: "clean",
      text: "pushed",
      title: `${status.ahead} ${status.ahead === 1 ? "commit" : "commits"} ahead of the base branch, all on origin`,
    });
  if (status.behind && !landed)
    parts.push({
      key: "behind",
      tone: "behind",
      text: `↓${status.behind}`,
      title: `${status.behind} ${status.behind === 1 ? "commit" : "commits"} on the base branch since this tree branched`,
    });
  if (parts.length === 0)
    parts.push({ key: "clean", tone: "clean", text: "clean" });
  return parts;
}

/**
 * What the last fetch did to a checkout, in a few words, with the commits it
 * brought in for the tooltip.
 */
export function fetchOutcomeNote(outcome: RepositoryFetchOutcomeDto): {
  tone: string;
  text: string;
  title: string;
} {
  if (outcome.error)
    return { tone: "error", text: "fetch failed", title: outcome.error };
  if (outcome.newCommits > 0) {
    const listed = outcome.commits
      .map((commit) => `${commit.hash.slice(0, 7)} ${commit.subject}`)
      .join("\n");
    const more = outcome.newCommits - outcome.commits.length;
    return {
      tone: "new",
      text: `+${outcome.newCommits} new`,
      title: more > 0 ? `${listed}\n…and ${more} more` : listed,
    };
  }
  if (outcome.heldBack)
    return {
      tone: "held",
      text: "not moved",
      title:
        outcome.heldBack === "local-changes"
          ? `${outcome.behind} new on origin; this checkout has local changes, so it stayed`
          : `${outcome.behind} new on origin; this checkout has diverged, so it stayed`,
    };
  return { tone: "none", text: "up to date", title: "Nothing new on origin" };
}

/** How long a row keeps saying what its last fetch did. */
const FETCH_OUTCOME_VISIBLE_MS = 120_000;

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
  const section = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // A dialog opened from a session would otherwise leave the caret in the
  // terminal, where xterm swallows Escape and sends it to the agent.
  useEffect(() => {
    const element = section.current;
    if (element && !element.contains(document.activeElement)) element.focus();
  }, []);
  // Escape closes it, on the window like the task drawer, so a menu or a
  // confirm on top that handles Escape first (`preventDefault`, or a stopped
  // event) closes only itself.
  useEffect(() => {
    if (!dismissible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(".app-dialog-backdrop")) return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissible]);
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
        ref={section}
        role="dialog"
        tabIndex={-1}
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

/** How a terminal turns a printed path into a link and follows it. */
interface FileLinks {
  resolve(path: string): Promise<FileLinkTargetDto | null>;
  open(target: FileLinkTargetDto, line?: number, column?: number): void;
}

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
  onCopy,
  onFocused,
  onOpenLink,
  fileLinks,
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
  onCopy: (text: string) => void;
  onFocused?: () => void;
  onOpenLink: (url: string) => void;
  /** Paths the program prints become Cmd+click links into the editor. */
  fileLinks?: FileLinks;
  status: AgentSessionDto["status"];
  session?: AgentSessionDto;
  telemetry?: SessionTelemetryDto;
  target: "agent" | "integrated";
  worktree?: SessionWorktreeDto;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileLinksRef = useRef(fileLinks);
  fileLinksRef.current = fileLinks;
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

    // A link looks clickable only while Cmd is held, as in iTerm2. The
    // underline is drawn here rather than by xterm, which underlines only the
    // row under the mouse when a program broke a long URL across rows.
    let linksArmed = false;
    let hoveredLink: { url: string; range: LinkRange } | undefined;
    const linkLayer = document.createElement("div");
    linkLayer.className = "terminal-link-layer";
    const drawLink = () => {
      linkLayer.replaceChildren();
      const screen = linkLayer.parentElement;
      if (!linksArmed || !hoveredLink || !terminal || !screen) return;
      const buffer = terminal.buffer.active;
      const cellWidth = screen.clientWidth / terminal.cols;
      const cellHeight = screen.clientHeight / terminal.rows;
      for (const row of wholeLinkRows(
        hoveredLink.url,
        hoveredLink.range,
        terminal.cols,
        (y) => buffer.getLine(y - 1)?.translateToString(),
      )) {
        const top = row.y - 1 - buffer.viewportY;
        if (top < 0 || top >= terminal.rows) continue;
        const line = document.createElement("div");
        line.style.left = `${(row.x1 - 1) * cellWidth}px`;
        line.style.top = `${top * cellHeight}px`;
        line.style.width = `${(row.x2 - row.x1 + 1) * cellWidth}px`;
        line.style.height = `${cellHeight}px`;
        linkLayer.append(line);
      }
    };
    const armLinks = (event: KeyboardEvent | MouseEvent) => {
      if (event.metaKey === linksArmed) return;
      linksArmed = event.metaKey;
      container.classList.toggle("links-armed", linksArmed);
      drawLink();
    };
    const disarmLinks = () => {
      linksArmed = false;
      container.classList.remove("links-armed");
      drawLink();
    };
    const hoverLink = (_event: MouseEvent, url: string, range: LinkRange) => {
      hoveredLink = { url, range };
      drawLink();
    };
    const leaveLink = () => {
      hoveredLink = undefined;
      drawLink();
    };
    window.addEventListener("keydown", armLinks, true);
    window.addEventListener("keyup", armLinks, true);
    window.addEventListener("blur", disarmLinks);
    container.addEventListener("mousemove", armLinks);

    void (async () => {
      if (disposed) return;
      terminal = new Terminal({
        cursorBlink: true,
        // Clicks and drags go to the program, as in any terminal: Claude
        // Code selects in its own layout and copies the text it wrapped, so
        // a copy has no breaks where the screen did, and in a plain shell
        // tmux selects. Option and drag is the native selection, the way it
        // is in iTerm2.
        macOptionClickForcesSelection: true,
        // OSC 8 links, which Claude Code sends when told it may: the whole
        // URL rides on every row it was wrapped across, so a link split over
        // two lines opens whole. Cmd and click, like a native terminal; a
        // plain click belongs to the program.
        linkHandler: {
          activate: (event, url) => {
            if (event.metaKey) onOpenLink(url);
          },
          hover: hoverLink,
          leave: leaveLink,
        },
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
        new WebLinksAddon(
          (event, url) => {
            event.preventDefault();
            if (event.metaKey) onOpenLink(url);
          },
          { hover: hoverLink, leave: leaveLink },
        ),
      );
      // Paths an agent prints, like `src/a.ts:12:3`. Only the ones that name
      // a file in a workspace become links, which is what keeps ordinary
      // words with a dot in them from lighting up.
      terminal.registerLinkProvider({
        provideLinks: (y, callback) => {
          const links = fileLinksRef.current;
          const text = terminal?.buffer.active
            .getLine(y - 1)
            ?.translateToString(true);
          const candidates = text ? findPathCandidates(text) : [];
          if (!links || candidates.length === 0) {
            callback(undefined);
            return;
          }
          void Promise.all(
            candidates.map((candidate) => links.resolve(candidate.path)),
          ).then((targets) => {
            const found = candidates.flatMap((candidate, index) => {
              const target = targets[index];
              if (!target) return [];
              const range = {
                start: { x: candidate.index + 1, y },
                end: { x: candidate.index + candidate.text.length, y },
              };
              return [
                {
                  text: candidate.text,
                  range,
                  activate: (event: MouseEvent) => {
                    if (event.metaKey)
                      fileLinksRef.current?.open(
                        target,
                        candidate.line,
                        candidate.column,
                      );
                  },
                  hover: (event: MouseEvent, linkText: string) =>
                    hoverLink(event, linkText, range),
                  leave: leaveLink,
                },
              ];
            });
            callback(found.length > 0 ? found : undefined);
          });
        },
      });
      // How a program in the terminal copies: tmux after a drag in a plain
      // shell, and anything else that writes OSC 52. Only a write is honoured;
      // a `?` query would hand the clipboard to whatever runs in the pane.
      terminal.parser.registerOscHandler(52, (data) => {
        const encoded = data.slice(data.indexOf(";") + 1);
        if (!encoded || encoded === "?") return true;
        try {
          const bytes = Uint8Array.from(atob(encoded), (char) =>
            char.charCodeAt(0),
          );
          onCopy(new TextDecoder().decode(bytes));
        } catch {
          // Not base64: nothing a program meant to copy.
        }
        return true;
      });
      terminal.open(container);
      container.querySelector(".xterm-screen")?.append(linkLayer);
      terminal.onRender(() => {
        if (hoveredLink) drawLink();
      });
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
      window.removeEventListener("keydown", armLinks, true);
      window.removeEventListener("keyup", armLinks, true);
      window.removeEventListener("blur", disarmLinks);
      container.removeEventListener("mousemove", armLinks);
      linkLayer.remove();
      container.classList.remove("links-armed");
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
  onCopy,
  onOpenLink,
  fileLinks,
  terminal,
  terminalEndpoint,
}: {
  active: boolean;
  fitRevision: number;
  mountRevision: number;
  onCopy: (text: string) => void;
  onOpenLink: (url: string) => void;
  fileLinks?: FileLinks;
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
          onCopy={onCopy}
          onOpenLink={onOpenLink}
          fileLinks={fileLinks}
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
  // A session created from the dialog, shown in the terminal column while its
  // provider starts. Spawning returns only once the agent is ready, which
  // takes seconds; the column switches at once and the terminal takes the
  // caret when it exists. Opening any session in the meantime cancels this.
  const [openingLaunchKey, setOpeningLaunchKey] = useState<string>();
  const openingLaunchKeyRef = useRef(openingLaunchKey);
  openingLaunchKeyRef.current = openingLaunchKey;
  const openSession = useCallback((id: string) => {
    setOpeningLaunchKey(undefined);
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
  const [view, setView] = useState<WorkspaceView>(() =>
    preferredScopeView(
      scope,
      initialWorkspaceView ?? rememberedWorkspaceView(scopeKey),
    ),
  );
  const viewWorkspaceId = useRef(scopeKey);
  // Where the World button returns to: the World spans every workspace, so
  // it toggles over whichever workspace view was open.
  const lastWorkspaceView = useRef<WorkspaceView>(
    view === "world" ? "board" : view,
  );
  if (view !== "world") lastWorkspaceView.current = view;
  const [workspaceContent, setWorkspaceContent] = useState(
    initialWorkspaceContent,
  );
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
  // A journal heading the workspace view should open JOURNAL.md at, once.
  const [journalTarget, setJournalTarget] = useState<string>();
  // A file a terminal link asked for, opened by the Workspace view.
  const [fileOpenRequest, setFileOpenRequest] = useState<FileOpenRequest>();
  // The quit dialog is driven entirely by the host: it arrives with the plan
  // already computed, and every button answers back over `quitDecision`.
  const [quitRequest, setQuitRequest] = useState<ShutdownPlanDto>();
  // Also host-driven: the host checks for releases and says when to show this.
  const [appUpdate, setAppUpdate] = useState<AppUpdateDto | null>(null);
  // A check asked for from Settings, until the host answers. The host has no
  // "checking" state of its own, and without one the button looks dead.
  const [checkingUpdate, setCheckingUpdate] = useState(false);
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
    /** The workspace whose card's + opened the dialog. */
    workspaceId?: string;
    color?: SessionColorDto;
    routines?: boolean;
  }>({ name: "" });
  // The Routines drawer on the selected session, and what it last read.
  const [routinesPanel, setRoutinesPanel] = useState<{
    sessionId: string;
    detail?: RoutinesDetailDto;
    error?: string;
  }>();
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
  // What each checkout's last fetch did, shown on its row for a while so a
  // fetch that brought something in says so, and what.
  const [fetchOutcomes, setFetchOutcomes] = useState<
    Readonly<Record<string, RepositoryFetchOutcomeDto>>
  >({});
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
  // Sessions confirmed for archiving whose request has not returned yet. They
  // show as archived at once; stopping the agent and releasing its worktrees
  // can take seconds, and the dialog should not wait for that.
  const [archivingSessionIds, setArchivingSessionIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const archivingStartedAt = useRef(new Date().toISOString());
  // Repositories confirmed in the picker whose rows have not arrived yet.
  // Attaching and reloading the workspace's git status takes seconds; these
  // rows say something is happening until the real ones replace them.
  const [addingRepositories, setAddingRepositories] = useState<
    Array<{ key: string; workspaceId: string; name: string }>
  >([]);
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(
    initialTerminalPanelOpen,
  );
  const [terminalPanelHeight, setTerminalPanelHeight] = useState(() =>
    typeof window === "undefined" ? 300 : Math.round(window.innerHeight * 0.38),
  );
  // Wide enough by default for the session cards listed under each
  // workspace, which used to have a column of their own (#55).
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(() => {
    const stored = storedPanelSize(
      "daedalus.panel.workspace-width",
      WORKSPACE_PANEL_DEFAULT_WIDTH,
    );
    // A width left over from the rail opens at the default instead.
    return stored < WORKSPACE_PANEL_MIN_WIDTH
      ? WORKSPACE_PANEL_DEFAULT_WIDTH
      : stored;
  });
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<
    ReadonlySet<string>
  >(rememberedCollapsedWorkspaces);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLLAPSED_WORKSPACES_STORAGE_KEY,
        JSON.stringify([...collapsedWorkspaceIds]),
      );
    } catch {
      // Folding a list is not worth an error when the store is unavailable.
    }
  }, [collapsedWorkspaceIds]);
  const setWorkspaceCollapsed = useCallback(
    (id: string, collapsed: boolean) => {
      setCollapsedWorkspaceIds((current) => {
        if (current.has(id) === collapsed) return current;
        const next = new Set(current);
        if (collapsed) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [],
  );
  const expandWorkspace = useCallback(
    (id: string) => setWorkspaceCollapsed(id, false),
    [setWorkspaceCollapsed],
  );
  const [boardDetailPanelWidth, setBoardDetailPanelWidth] = useState(() =>
    storedPanelSize("daedalus.panel.board-detail-width", 340),
  );
  // The Workspace panel (repositories, worktrees and what each changed) sits
  // on the right of every view about one workspace: board, files, session.
  const workspacePanelVisible =
    Boolean(workspaceId) &&
    !showingAll &&
    (view === "board" || view === "workspace" || view === "session");
  const workspacePanelCollapsed =
    boardDetailPanelWidth < PANEL_COMPACT_THRESHOLD;
  const boardDetailExpandedWidth = useRef(
    boardDetailPanelWidth >= PANEL_COMPACT_THRESHOLD
      ? boardDetailPanelWidth
      : 340,
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

  // xterm asks for a line's links on every mouse move over it, so an answer
  // is kept for a few seconds rather than asked of the host each time.
  const fileLinkCache = useRef(
    new Map<
      string,
      { at: number; target: Promise<FileLinkTargetDto | null> }
    >(),
  );
  const resolveFileLink = useCallback(
    (path: string, baseDirectories: readonly string[]) => {
      const key = `${baseDirectories.join("\0")}\0\0${path}`;
      const cached = fileLinkCache.current.get(key);
      if (cached && Date.now() - cached.at < 5_000) return cached.target;
      const target = client.request
        .fileLinkResolve({ path, baseDirectories: [...baseDirectories] })
        .then((response) => (response.ok ? response.data : null))
        .catch(() => null);
      fileLinkCache.current.set(key, { at: Date.now(), target });
      return target;
    },
    [client],
  );
  const openFileTarget = useCallback(
    (target: FileLinkTargetDto, line?: number, column?: number) => {
      enterWorkspace(target.workspaceId, "workspace");
      setFileOpenRequest({
        workspaceId: target.workspaceId,
        path: target.path,
        line,
        column,
        nonce: Date.now(),
      });
    },
    // `enterWorkspace` only calls state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const fileLinksFrom = useCallback(
    (baseDirectories: readonly string[]): FileLinks => ({
      resolve: (path) => resolveFileLink(path, baseDirectories),
      open: openFileTarget,
    }),
    [openFileTarget, resolveFileLink],
  );

  const openTerminalLink = useCallback(
    (url: string) => {
      // `file://` links, which Claude Code prints for the files it touches,
      // open in the editor when they are workspace files.
      if (url.startsWith("file://")) {
        let path: string;
        try {
          path = decodeURIComponent(new URL(url).pathname);
        } catch {
          return;
        }
        void resolveFileLink(path, []).then((target) => {
          if (target) openFileTarget(target);
          else setError("That file is not in a workspace");
        });
        return;
      }
      void client.request.openExternal({ url }).then((response) => {
        if (!response.ok) setError(response.error.message);
        else if (!response.data.opened)
          setError("The link could not be opened in the default browser");
      });
    },
    [client, openFileTarget, resolveFileLink],
  );

  const copyTerminalText = useCallback(
    (text: string) => {
      void client.request.clipboardWrite({ text }).then((response) => {
        if (!response.ok) setError(response.error.message);
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
      const hasSecondary = workspacePanelVisible;
      const secondaryWidth =
        shell.querySelector<HTMLElement>(".board-detail-column")?.offsetWidth ??
        boardDetailPanelWidth;
      const mainMinimum = 320;
      const handlesWidth = hasSecondary ? 12 : 6;
      const workspaceMaximum = Math.max(
        PANEL_RAIL_WIDTH,
        shell.clientWidth -
          (hasSecondary ? secondaryWidth : 0) -
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
            clampWorkspacePanelSize(
              workspaceWidth + movement,
              workspaceMaximum,
            ),
          );
        else
          setBoardDetailPanelWidth(
            clampPanelSize(secondaryWidth - movement, secondaryMaximum),
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
    [boardDetailPanelWidth, workspacePanelVisible, workspacePanelWidth],
  );

  const toggleBoardDetailPanel = useCallback(() => {
    setBoardDetailPanelWidth((width) => {
      if (width < PANEL_COMPACT_THRESHOLD)
        return boardDetailExpandedWidth.current;
      boardDetailExpandedWidth.current = width;
      return PANEL_RAIL_WIDTH;
    });
  }, []);

  // ⌥⌘B folds the workspace panel, the key VS Code gives its secondary side bar.
  useEffect(() => {
    if (!workspacePanelVisible) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || !event.altKey || event.code !== "KeyB") return;
      event.preventDefault();
      toggleBoardDetailPanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleBoardDetailPanel, workspacePanelVisible]);

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
      else if (command === "view-world" && workspaceId)
        setView((current) =>
          current === "world" ? lastWorkspaceView.current : "world",
        );
      else if (command === "view-session" && workspaceId && !showingAll)
        setView("session");
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
        if (session) showSession(session.id, session.workspaceId);
      }),
    [client, openSession],
  );
  // A clicked routine notification lands on its task, on its board.
  useEffect(
    () =>
      client.subscribeFocusTask?.((taskId) => {
        const task = snapshotRef.current?.tasks.find(
          (item) => item.id === taskId,
        );
        if (!task) return;
        enterWorkspace(task.workspaceId, "board");
        setSelectedTaskId(task.id);
        setEditingTask(false);
      }),
    [client],
  );
  // The host may have checked before this window existed, so ask once, then
  // follow its messages.
  useEffect(() => {
    let cancelled = false;
    void client.request.appUpdateGet?.({}).then((response) => {
      if (!cancelled && response?.ok) setAppUpdate(response.data);
    });
    const unsubscribe = client.subscribeAppUpdate?.(setAppUpdate);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [client]);
  const checkForUpdate = useCallback(() => {
    setCheckingUpdate(true);
    void client.request
      .appUpdateCheck({})
      .then((response) => {
        if (response.ok) setAppUpdate(response.data);
        else
          setAppUpdate({
            state: "error",
            currentVersion: snapshot?.settings.version ?? "",
            message: `Could not check for updates: ${response.error.message}`,
          });
      })
      .finally(() => setCheckingUpdate(false));
  }, [client, snapshot?.settings.version]);
  const installUpdate = useCallback(() => {
    void client.request.appUpdateInstall({}).then((response) => {
      if (response.ok) setAppUpdate(response.data);
    });
  }, [client]);
  const dismissUpdate = useCallback(
    (version?: string) => {
      void client.request
        .appUpdateDismiss({ ...(version ? { version } : {}) })
        .then((response) => {
          if (response.ok) setAppUpdate(response.data);
        });
    },
    [client],
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
        setError(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [client, view, workspaceId]);

  // The host watches whichever workspace this window is actually showing, and
  // nothing when it is showing something else. A watcher is a kernel resource
  // and a tree nobody is looking at does not need to be fresh.
  useEffect(() => {
    if (view === "world" || scope === "all" || !workspaceId) {
      void client.request.workspaceWatchSet({ workspaces: [] });
      return;
    }
    void client.request.workspaceWatchSet({ workspaces: [workspaceId] });
    return () => {
      void client.request.workspaceWatchSet({ workspaces: [] });
    };
  }, [client, scope, view, workspaceId]);

  useEffect(() => {
    const stored = window.localStorage.getItem("daedalus.theme");
    if (stored === "dark" || stored === "light") setTheme(stored);
  }, []);
  useEffect(() => {
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
  const worktreeChanges = useWorktreeChanges(
    client,
    workspacePanelVisible ? workspace?.id : undefined,
  );
  // The same changes, by workspace path, so the file tree can colour them.
  const changedPaths = useMemo(
    () =>
      new Map(
        [...worktreeChanges.values()].flatMap((tree) =>
          tree.files.map((file) => [file.path, file.status] as const),
        ),
      ),
    [worktreeChanges],
  );
  // Where each worktree branched, so the editor can mark what changed.
  const worktreeBases = useMemo(
    () =>
      new Map(
        [...worktreeChanges.values()].map(
          (tree) => [tree.root, tree.base] as const,
        ),
      ),
    [worktreeChanges],
  );
  // Worktrees whose file list the user folded away in the panel.
  const [foldedWorktrees, setFoldedWorktrees] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
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
  const agents = (snapshot?.agents ?? []).map((session) =>
    archivingSessionIds.has(session.id) && !session.archivedAt
      ? { ...session, archivedAt: archivingStartedAt.current }
      : session,
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
        agents.filter((session) => session.workspaceId === item.id),
      )
    : agents.filter((item) => item.workspaceId === workspaceId);
  // Blocked sessions used to float to the top here. They no longer do: once
  // the order is something the user placed, moving a card out from under them
  // is the bug, not the feature. The card tone and the workspace roll-up
  // count still surface a blocked session in place.
  const sessions = workspaceSessions.filter((item) => !item.archivedAt);
  // Sessions holding routines, which their cards and archive dialog mark.
  const routinesBySession = new Map(
    (snapshot?.routines ?? []).map((status) => [status.sessionId, status]),
  );
  const workspaceSessionLaunches = sessionLaunches.filter((item) =>
    inScope(item.workspaceId),
  );
  // Every workspace's list is in the left column whatever the scope, so the
  // launch errors are read across all of them.
  const sessionStartupErrors = new Map(
    sessionLaunches.flatMap((launch) =>
      launch.sessionId && launch.error
        ? [[launch.sessionId, launch.error] as const]
        : [],
    ),
  );
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
  // The launch being opened, while it is still one: once it fails or becomes
  // a session, the column goes back to showing sessions.
  const openingLaunch = openingLaunchKey
    ? sessionLaunches.find(
        (launch) =>
          launch.key === openingLaunchKey &&
          launch.status === "starting" &&
          launch.workspaceId === workspaceId,
      )
    : undefined;
  const activeSession = openingLaunch
    ? undefined
    : sessions.find((item) => item.id === activeSessionId);
  // A session that was asked to hand off, by a click or by the automatic
  // sweep, is followed to its successor: the fresh session in the same
  // working directory that started after the request. Looked up across the
  // archived sessions too, because the successor arrives and the
  // predecessor is archived within the same second.
  const viewedHandoff = workspaceSessions.find(
    (item) => item.id === activeSessionId && item.handoffRequestedAt,
  );
  const handoffSuccessor = viewedHandoff
    ? sessions.find(
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
  const activeSessionRoutines = snapshot?.routines.find(
    (status) => status.sessionId === activeSession?.id,
  );
  // The drawer reads its runs on request, so it reads again whenever the
  // session's routine status moves: a run went in, finished or was queued.
  const openRoutinesStatus =
    routinesPanel &&
    snapshot?.routines.find(
      (status) => status.sessionId === routinesPanel.sessionId,
    );
  const openRoutinesFingerprint = openRoutinesStatus
    ? JSON.stringify([
        openRoutinesStatus.waiting.map((run) => run.runId),
        openRoutinesStatus.running,
        openRoutinesStatus.paused,
        openRoutinesStatus.nextRun,
        openRoutinesStatus.routines,
      ])
    : undefined;
  useEffect(() => {
    if (routinesPanel && openRoutinesFingerprint)
      void loadRoutinesDetail(routinesPanel.sessionId);
  }, [openRoutinesFingerprint]);
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
  // that task's workspace, and one opened from a workspace card's + to that
  // workspace; with every workspace showing, neither need be the selected one.
  const sessionFormTask = snapshot?.tasks.find(
    (item) => item.id === sessionForm.taskId,
  );
  const sessionWorkspace =
    (sessionFormTask && workspaceById.get(sessionFormTask.workspaceId)) ??
    (sessionForm.workspaceId
      ? workspaceById.get(sessionForm.workspaceId)
      : undefined) ??
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
    if (view !== "session" || !scopeKey) return;
    if (openingLaunch) return;
    const remembered = window.localStorage.getItem(
      lastSessionStorageKey(scopeKey),
    );
    const preferred = preferredSessionId(sessions, activeSessionId, remembered);
    if (preferred !== activeSessionId) setActiveSessionId(preferred);
    // A workspace with nothing to show in the session view lands on its
    // board. A launch still starting counts as something: it becomes the
    // session in a moment.
    else if (
      !preferred &&
      snapshot &&
      !sessionLaunches.some(
        (launch) =>
          launch.workspaceId === workspaceId && launch.status === "starting",
      )
    )
      setView("board");
  }, [
    activeSessionId,
    openingLaunch,
    sessionLaunches,
    sessions,
    snapshot,
    view,
    scopeKey,
    workspaceId,
  ]);

  // A session opened from elsewhere (the board, a toast) may be below the
  // fold of a long left column; its card scrolls into sight.
  useEffect(() => {
    if (view !== "session" || !activeSessionId) return;
    document
      .querySelector(
        `.session-card-main[data-session-id="${CSS.escape(activeSessionId)}"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSessionId, view]);

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

  function openSessionModal(task?: TaskDto, forWorkspace?: WorkspaceDto) {
    setSessionForm({
      name: task?.title ?? "",
      taskId: task?.id,
      workspaceId: forWorkspace?.id,
    });
    // The dialog opens on what Start would launch, so "default" means the
    // same thing here and on the board.
    const target = task
      ? workspaceById.get(task.workspaceId)
      : (forWorkspace ?? workspace);
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
    const { color, routines } = sessionForm;
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
    // The launch's card appears in the workspace's list in the left column,
    // and the terminal column switches to it now rather than when it is ready.
    expandWorkspace(launch.workspaceId);
    setOpeningLaunchKey(launch.key);
    enterWorkspace(launch.workspaceId, "session");
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
        ...(color ? { color } : {}),
        ...(routines && !isTerminal
          ? { abilities: ["routines" as const] }
          : {}),
      });
      if (response.ok) {
        // The launch stays until the refreshed list holds its session, so the
        // column never falls back to another session in between.
        await refresh();
        setSessionLaunches((current) =>
          current.filter((item) => item.key !== launch.key),
        );
        // Only if the user is still waiting on it: a session they opened in
        // the meantime keeps the column and the caret.
        if (openingLaunchKeyRef.current === launch.key)
          showSession(response.data.id, launch.workspaceId);
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
      if (sessionId && openingLaunchKeyRef.current === launch.key) {
        setOpeningLaunchKey(undefined);
        setActiveSessionId(sessionId);
      }
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
    const placeholders = [
      ...pendingGitHub.map((repository) => repository.name),
      ...pending.map(
        (id) =>
          snapshot?.repositories.find((item) => item.id === id)?.name ?? id,
      ),
    ].map((name) => ({
      key: crypto.randomUUID(),
      workspaceId: workspace.id,
      name,
    }));
    setAddingRepositories((current) => [...current, ...placeholders]);
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
    dropAddingRepositories(placeholders);
    await refresh();
  }

  function dropAddingRepositories(placeholders: Array<{ key: string }>) {
    const keys = new Set(placeholders.map((item) => item.key));
    setAddingRepositories((current) =>
      current.filter((item) => !keys.has(item.key)),
    );
  }

  // Fetch, pull and push are the same shape: run one request, then re-read the
  // workspace so every status in the tree reflects what just happened.
  async function runRepositoryAction<T>(
    key: string,
    request: () => Promise<RpcResult<T>>,
  ): Promise<T | undefined> {
    if (!workspace || pendingRepositoryActions.has(key)) return undefined;
    setPendingRepositoryActions((current) => new Set(current).add(key));
    setError(undefined);
    let data: T | undefined;
    try {
      const response = await request();
      if (!response.ok) throw new Error(response.error.message);
      data = response.data;
      const content = await client.request.workspaceContentGet({
        workspace: workspace.id,
      });
      if (!content.ok) throw new Error(content.error.message);
      setWorkspaceContent(content.data);
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
    return data;
  }

  async function detachWorkspaceRepository(repositoryId: string) {
    await runRepositoryAction(`detach:${repositoryId}`, () =>
      client.request.workspaceRepositoryDetach({ id: repositoryId }),
    );
  }

  // One repository, or every one in the workspace when `repositoryId` is
  // absent. Each row then says what its checkout took.
  /**
   * Fetch downloads from the remote and moves nothing; pull also moves each
   * checkout under `repos/` to the latest base branch.
   */
  async function fetchWorkspaceRepositories(
    mode: "fetch" | "pull",
    repositoryId?: string,
  ) {
    if (!workspace) return;
    const outcomes = await runRepositoryAction(
      `${mode}:${repositoryId ?? "all"}`,
      () =>
        client.request.workspaceRepositoriesFetch({
          workspace: workspace.id,
          pull: mode === "pull",
          ...(repositoryId ? { ids: [repositoryId] } : {}),
        }),
    );
    if (!outcomes) return;
    setFetchOutcomes((current) => {
      const next = { ...current };
      for (const outcome of outcomes) next[outcome.repositoryId] = outcome;
      return next;
    });
    window.setTimeout(
      () =>
        setFetchOutcomes((current) => {
          const next = { ...current };
          for (const outcome of outcomes)
            if (next[outcome.repositoryId] === outcome)
              delete next[outcome.repositoryId];
          return next;
        }),
      FETCH_OUTCOME_VISIBLE_MS,
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
    const remoteUrl = repositoryForm.search;
    const placeholder = {
      key: crypto.randomUUID(),
      workspaceId: workspace.id,
      name:
        remoteUrl
          .trim()
          .replace(/\/+$/, "")
          .split(/[/:]/)
          .pop()
          ?.replace(/\.git$/, "") || remoteUrl,
    };
    setRepositoryForm({ remoteUrl: "", search: "" });
    closeRepositoryModal();
    setAddingRepositories((current) => [...current, placeholder]);
    const started = await perform(
      client.request.repositoryAddAndAttachStart({
        workspace: workspace.id,
        remoteUrl,
      }),
    );
    if (started) await refreshWorkspaceContent();
    dropAddingRepositories([placeholder]);
  }

  async function refreshWorkspaceContent() {
    if (!workspace) return;
    const content = await client.request.workspaceContentGet({
      workspace: workspace.id,
    });
    if (!content.ok) return;
    setWorkspaceContent(content.data);
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
    const wasActive = activeSessionId === session.id;
    setSessionAction(undefined);
    archivingStartedAt.current = new Date().toISOString();
    setArchivingSessionIds((current) => new Set(current).add(session.id));
    if (wasActive) setActiveSessionId(undefined);
    const archived = await perform(
      client.request.agentArchive({ id: session.id, force: false }),
    );
    setArchivingSessionIds((current) => {
      const next = new Set(current);
      next.delete(session.id);
      return next;
    });
    if (!archived && wasActive) setActiveSessionId(session.id);
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

  async function updateSession(
    session: AgentSessionDto,
    change: { name?: string; pinned?: boolean; color?: SessionColorDto | null },
  ) {
    await perform(
      client.request.sessionUpdate({ sessionId: session.id, ...change }),
    );
  }

  async function renameSession(session: AgentSessionDto) {
    const name = await askText({
      title: "Rename session",
      message: "The name shows on the card, the terminal and the World.",
      initial: session.name,
      confirmLabel: "Rename",
    });
    const trimmed = name?.trim();
    if (trimmed && trimmed !== session.name)
      await updateSession(session, { name: trimmed });
  }

  async function setRoutinesAbility(
    session: AgentSessionDto,
    granted: boolean,
  ) {
    if (
      !granted &&
      !(await askConfirm({
        title: `Revoke routines from ${sessionName(session)}?`,
        message:
          "No more runs go in and waiting runs are dropped. The routines and their purpose are kept, and come back if routines are granted again.",
        confirmLabel: "Revoke",
      }))
    )
      return;
    await perform(
      client.request.sessionAbility({
        sessionId: session.id,
        ability: "routines",
        granted,
      }),
    );
    if (!granted && routinesPanel?.sessionId === session.id)
      setRoutinesPanel(undefined);
  }

  async function loadRoutinesDetail(sessionId: string) {
    try {
      const response = await client.request.routinesDetail({ sessionId });
      setRoutinesPanel((current) =>
        current?.sessionId !== sessionId
          ? current
          : response.ok
            ? { sessionId, detail: response.data }
            : { sessionId, error: response.error.message },
      );
    } catch (cause) {
      setRoutinesPanel((current) =>
        current?.sessionId === sessionId
          ? { sessionId, error: errorMessage(cause) }
          : current,
      );
    }
  }

  function openRoutinesPanel(sessionId: string) {
    setRoutinesPanel({ sessionId });
    void loadRoutinesDetail(sessionId);
  }

  /** A routines request from the bar or the drawer, then a fresh drawer. */
  async function routinesAction<T>(
    sessionId: string,
    operation: Promise<RpcResult<T>>,
  ) {
    const result = await perform(operation);
    if (routinesPanel?.sessionId === sessionId)
      await loadRoutinesDetail(sessionId);
    return result;
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
    // Restoring the session view re-arms `preferredSessionId`, so a focus
    // request left over from this workspace's previous visit could be
    // satisfied by a session the user never opened. Switching workspaces is
    // not an intent to type into whatever is restored.
    clearSessionFocusRequest();
    // A workspace's card opens its board; its sessions are listed right
    // under the card (#55). The ref moves first, as in `enterWorkspace`, or
    // the scope effect restores the workspace's remembered view (often its
    // last session) over the board.
    viewWorkspaceId.current = id;
    setView("board");
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

  /**
   * Every way to a session ends here: a card in the left column, a board
   * card, the World, a toast or a notification. A session's terminal is one
   * workspace's view, so this leaves the all-workspaces scope, and it opens
   * the session's list in case it was collapsed (#55).
   */
  function showSession(sessionId: string, sessionWorkspaceId: string) {
    expandWorkspace(sessionWorkspaceId);
    enterWorkspace(sessionWorkspaceId, "session");
    openSession(sessionId);
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
                {fetchOutcomes[repository.id] &&
                  (() => {
                    const note = fetchOutcomeNote(
                      fetchOutcomes[repository.id]!,
                    );
                    return (
                      <span
                        className={`repository-fetch-note tone-${note.tone}`}
                        title={note.title}
                      >
                        {" · "}
                        {note.text}
                      </span>
                    );
                  })()}
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
            {(["fetch", "pull"] as const).map((mode) => {
              const busy = ["all", repository.id].some((target) =>
                ["fetch", "pull"].some((kind) =>
                  pendingRepositoryActions.has(`${kind}:${target}`),
                ),
              );
              const running =
                pendingRepositoryActions.has(`${mode}:${repository.id}`) ||
                pendingRepositoryActions.has(`${mode}:all`);
              return (
                <button
                  aria-label={`${mode === "fetch" ? "Fetch" : "Pull"} ${repository.name}`}
                  className={`quiet repository-action ${running ? "syncing" : ""}`}
                  disabled={repository.status !== "ready" || busy}
                  key={mode}
                  onClick={() =>
                    void fetchWorkspaceRepositories(mode, repository.id)
                  }
                  title={
                    mode === "fetch"
                      ? "Fetch: download from the remote. The checkout stays where it is."
                      : `Pull: fetch, and move this checkout to the latest ${repository.baseBranch ?? "default branch"}`
                  }
                  type="button"
                >
                  {mode === "fetch" ? (
                    <RepositoryFetchIcon />
                  ) : (
                    <RepositoryPullIcon />
                  )}
                </button>
              );
            })}
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
              const changesKey = worktreeKey(
                worktree.sessionId,
                worktree.repositoryId,
              );
              const changes = worktreeChanges.get(changesKey);
              const folded = foldedWorktrees.has(changesKey);
              const commitsAhead = worktree.gitStatus?.ahead ?? 0;
              // Something to unfold: changed files, or commits to read.
              const unfoldable = Boolean(
                changes && (changes.files.length > 0 || commitsAhead > 0),
              );
              return (
                <Fragment key={key}>
                  <div className="workspace-worktree-row">
                    <button
                      aria-expanded={changes ? !folded : undefined}
                      aria-label={`${folded ? "Show" : "Hide"} changed files`}
                      className="worktree-disclosure"
                      disabled={!unfoldable}
                      onClick={() =>
                        setFoldedWorktrees((current) => {
                          const next = new Set(current);
                          if (folded) next.delete(changesKey);
                          else next.add(changesKey);
                          return next;
                        })
                      }
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className={`file-tree-twisty ${unfoldable && !folded ? "open" : ""}`}
                      >
                        {unfoldable ? "›" : ""}
                      </span>
                    </button>
                    <span>
                      <strong>
                        {session
                          ? sessionName(session)
                          : worktree.sessionId.slice(0, 8)}
                      </strong>
                      <small title={worktree.path}>{worktree.branchName}</small>
                    </span>
                    <span className="workspace-worktree-status">
                      {worktree.pullRequest && (
                        <button
                          className={`pr-chip state-${worktree.pullRequest.isDraft && worktree.pullRequest.state === "OPEN" ? "draft" : worktree.pullRequest.state.toLowerCase()}`}
                          onClick={() =>
                            openTerminalLink(worktree.pullRequest!.url)
                          }
                          title={`Pull request #${worktree.pullRequest.number}${worktree.pullRequest.title ? `: ${worktree.pullRequest.title}` : ""}\n${worktree.pullRequest.isDraft && worktree.pullRequest.state === "OPEN" ? "Draft" : worktree.pullRequest.state.toLowerCase()} · open on GitHub`}
                          type="button"
                        >
                          <svg aria-hidden="true" viewBox="0 0 16 16">
                            <circle cx="4" cy="3.5" r="1.6" />
                            <circle cx="4" cy="12.5" r="1.6" />
                            <circle cx="12" cy="12.5" r="1.6" />
                            <path d="M4 5.1v5.8M12 10.9V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" />
                          </svg>
                          #{worktree.pullRequest.number}
                        </button>
                      )}
                      {changes && changes.files.length > 0 && (
                        <em
                          className="git-part tone-changes"
                          title={`${changes.files.length} uncommitted ${changes.files.length === 1 ? "change" : "changes"}, as git status shows them`}
                        >
                          {changes.files.length}{" "}
                          {changes.files.length === 1 ? "file" : "files"}
                        </em>
                      )}
                      {gitStatusParts(worktree.gitStatus, worktree.landed).map(
                        (part) => (
                          <em
                            className={`git-part tone-${part.tone}`}
                            key={part.key}
                            title={part.title}
                          >
                            {part.text}
                          </em>
                        ),
                      )}
                    </span>
                    <button
                      aria-label={`Open ${worktree.branchName} in integrated terminal`}
                      className="quiet repository-action"
                      disabled={!snapshot?.settings.tmuxAvailable}
                      onClick={() =>
                        void createIntegratedTerminal(workspace, {
                          name: session
                            ? sessionName(session)
                            : repository.name,
                          workingDirectory: worktree.path,
                        })
                      }
                      title="Open a terminal in this working tree"
                      type="button"
                    >
                      <TerminalIcon />
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
                  {changes && changes.files.length > 0 && !folded && (
                    <ChangedFileList
                      onOpenDiff={(target, options) =>
                        openFromPanel({ ...options, diff: target })
                      }
                      onOpenFile={(path) => openFromPanel({ path })}
                      tree={changes}
                    />
                  )}
                  {changes && commitsAhead > 0 && !folded && (
                    <WorktreeCommits
                      client={client}
                      count={commitsAhead}
                      onOpenDiff={(target, options) =>
                        openFromPanel({ ...options, diff: target })
                      }
                      onOpenFile={(path) => openFromPanel({ path })}
                      root={changes.root}
                      workspaceId={workspace.id}
                    />
                  )}
                </Fragment>
              );
            })}
      </div>
    );
  };

  const repositoriesReady =
    workspaceContent !== undefined &&
    workspaceContent.workspaceId === workspace?.id;
  const workspaceAddingRepositories = addingRepositories.filter(
    (item) => item.workspaceId === workspace?.id,
  );
  // The board's right column is the workspace's, not the selected task's
  // (#27): the repositories with the working trees cut from each, as the
  // explorer used to draw them. The task's detail floats over it in a drawer.
  const workspaceRepositories = !repositoriesReady ? (
    <div className="empty">Loading repositories…</div>
  ) : workspaceContent.repositories.length === 0 &&
    workspaceAddingRepositories.length === 0 ? (
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
      {workspaceAddingRepositories.map((item) => (
        <div className="workspace-repository-group" key={item.key}>
          <div className="workspace-resource-row repository-status-unavailable repository-preparing">
            <span>
              <strong>{item.name}</strong>
              <small>
                <span
                  aria-hidden="true"
                  className="repository-preparing-spinner"
                />
                Adding…
              </small>
            </span>
          </div>
        </div>
      ))}
    </div>
  );

  // The panel folded to a rail still says something: each repository by its
  // initials and state, and under it one chip per worktree with how many
  // files it changed. Any of it opens the panel.
  const workspaceRail = repositoriesReady ? (
    <button
      aria-label="Expand workspace panel"
      className="workspace-rail"
      onClick={toggleBoardDetailPanel}
      type="button"
    >
      {workspaceContent.repositories.map((repository) => (
        <span className="rail-repository" key={repository.id}>
          <span
            className={`rail-avatar repository-status-${repository.gitStatus?.state ?? "unavailable"}`}
            title={`${repository.name} · ${repositoryStatusText(repository.gitStatus)}`}
          >
            {repository.name.slice(0, 2)}
            <i aria-hidden="true" />
          </span>
          {workspaceContent.worktrees
            .filter((item) => item.repositoryId === repository.id)
            .map((worktree) => {
              const count =
                worktreeChanges.get(
                  worktreeKey(worktree.sessionId, worktree.repositoryId),
                )?.files.length ?? 0;
              const session = workspaceSessions.find(
                (item) => item.id === worktree.sessionId,
              );
              const label = session
                ? sessionName(session)
                : worktree.branchName;
              return (
                <span
                  className={`rail-worktree ${count > 0 ? "changed" : ""}`}
                  key={`${worktree.sessionId}:${worktree.repositoryId}`}
                  title={`${label} · ${count} ${count === 1 ? "file" : "files"} changed`}
                >
                  {count > 0 ? count : "·"}
                </span>
              );
            })}
        </span>
      ))}
      <span className="rail-label">Workspace</span>
    </button>
  ) : null;

  /** A file or a diff from the panel opens in the Workspace view's editor. */
  function openFromPanel(request: {
    path?: string;
    diff?: DiffTarget;
    pinned?: boolean;
  }) {
    const path = request.diff?.path ?? request.path;
    if (!path || !workspaceId) return;
    if (view !== "workspace") setView("workspace");
    setFileOpenRequest({
      workspaceId,
      path,
      diff: request.diff,
      pinned: request.pinned,
      nonce: Date.now(),
    });
  }

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

  // A session's card in its workspace's list in the left column (#55).
  const renderSessionCard = (
    session: AgentSessionDto,
    reorder: ReorderHandles,
  ) => {
    const task = snapshot?.tasks.find((item) => item.id === session.taskId);
    const tool = sessionTool(session);
    const timestamp = session.endedAt ?? session.startedAt;
    const startupError = sessionStartupErrors.get(session.id);
    const statusView = statusViewFor(session);
    const holdsRoutines = routinesBySession.has(session.id);
    const waitingRuns = routinesBySession.get(session.id)?.waiting.length ?? 0;
    return (
      <div
        className={`session-card tone-${statusView.tone} ${view === "session" && session.id === activeSessionId ? "selected" : ""}`}
        data-color={session.color ?? undefined}
        data-pinned={session.pinnedAt ? "true" : undefined}
        data-attention={statusView.attention ? "true" : undefined}
        data-dragging={reorder.draggingId === session.id ? "true" : undefined}
        key={session.id}
        onPointerDown={reorder.onPointerDown(session.id)}
        ref={reorder.registerCard(session.id)}
      >
        <button
          className="session-card-main"
          data-provider={session.provider}
          data-session-id={session.id}
          onClick={() => showSession(session.id, session.workspaceId)}
          // What the three rows leave out, or cut short.
          title={[
            sessionName(session),
            `${session.id.slice(0, 8)} · ${session.endedAt ? "ended" : "started"} ${new Date(timestamp).toLocaleString()}`,
            startupError ?? statusView.detail,
            statusView.unconfirmed
              ? "Status read from the terminal pane, not reported by the agent"
              : undefined,
          ]
            .filter(Boolean)
            .join("\n")}
          onKeyDown={(event) => {
            if (!event.altKey) return;
            const direction =
              event.key === "ArrowUp"
                ? "up"
                : event.key === "ArrowDown"
                  ? "down"
                  : undefined;
            if (direction && reorder.moveByKeyboard(session.id, direction))
              event.preventDefault();
          }}
        >
          <span className={`session-kind-icon tool-${tool}`}>
            <ToolIcon tool={tool} />
          </span>
          <span>
            <strong>{sessionName(session)}</strong>
            <small>
              {holdsRoutines ? (
                <span className="session-routines-badge">
                  Routines
                  {waitingRuns > 0 && (
                    <span
                      className="session-waiting-badge"
                      title="Routine runs waiting to go in"
                    >
                      {waitingRuns} waiting
                    </span>
                  )}
                </span>
              ) : (
                (task?.title ?? "Workspace session")
              )}
            </small>
            {/* Always three rows: name, what it is for, and one line of
                live status with what the agent is doing, so every card is
                the same height (#55). A failed start takes the status line. */}
            <em
              className="session-card-status"
              data-clearable={
                statusView.reasons.length > 0 && !startupError
                  ? "true"
                  : undefined
              }
              data-error={startupError ? "true" : undefined}
            >
              <AgentStatusDot
                count={statusView.reasons.length}
                label={statusAriaLabel(session, statusView, now)}
                view={statusView}
              />
              <span
                className="session-status-label"
                role={startupError ? "alert" : undefined}
              >
                {startupError
                  ? `failed to start · ${startupError}`
                  : [
                      statusView.attention && statusView.since
                        ? `${statusView.label} ${waitingLabel(statusView.since, now)}`
                        : statusView.label,
                      statusView.detail,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </span>
            </em>
          </span>
        </button>
        {/* The alert's own dot, made into a pill that clears it, over the
            status row's dot: a button cannot sit inside the card's button.
            Only while something the agent or its pane raised is open; a
            lost session needs reviving, not clearing. */}
        {statusView.reasons.length > 0 && !startupError && (
          <button
            aria-label={`Clear ${sessionName(session)}'s needs-you alert`}
            className="session-attention-clear"
            data-no-drag
            disabled={busy}
            onClick={() => void clearAttention(session.id)}
            title={
              statusView.reasons.length > 1
                ? `Mark as seen: clear these ${statusView.reasons.length} alerts`
                : "Mark as seen: clear this alert"
            }
            type="button"
          >
            <AgentStatusDot
              count={statusView.reasons.length}
              view={statusView}
            />
            Clear
          </button>
        )}
        <span className="workspace-card-actions" data-no-drag>
          {session.status === "lost" && (
            <button
              aria-label={`Revive ${sessionName(session)} session`}
              className="session-card-action"
              disabled={busy}
              onClick={() => void reviveSession(session)}
              title="Resume this conversation in a new terminal"
            >
              ↻
            </button>
          )}
          {session.kind === "agent" &&
            (session.provider === "claude" || session.provider === "codex") && (
              <button
                aria-label={`Continue ${sessionName(session)} in a new agent`}
                className="session-card-action session-card-hover-action session-handoff-action"
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
            className="session-card-action session-card-hover-action"
            onClick={() => setSessionAction({ session })}
            title={
              holdsRoutines
                ? "Archive session and pause its routines"
                : "Archive session"
            }
            type="button"
          >
            <ArchiveIcon />
          </button>
          {/* Last, so hand off and archive open to its left on hover. */}
          <SessionMenu
            color={session.color}
            name={sessionName(session)}
            offerAbilities={
              session.kind === "agent" &&
              (session.provider === "claude" || session.provider === "codex")
            }
            onColor={(color) => void updateSession(session, { color })}
            onPin={(pinned) => void updateSession(session, { pinned })}
            onRename={() => void renameSession(session)}
            onRoutines={(granted) => void setRoutinesAbility(session, granted)}
            pinned={Boolean(session.pinnedAt)}
            routines={holdsRoutines}
          />
        </span>
      </div>
    );
  };
  // A session asked for but not yet started, or that failed to start.
  const renderLaunchCard = (launch: SessionLaunchState) => (
    <div
      aria-busy={launch.status === "starting"}
      className={`session-card session-card-${launch.status}`}
      key={launch.key}
    >
      <div className="session-card-main">
        <span className={`session-kind-icon tool-${launch.tool}`}>
          {launch.status === "starting" ? (
            <span aria-hidden="true" className="session-launch-spinner" />
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
            Requested · {new Date(launch.startedAt).toLocaleString()}
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
  );
  // One workspace's sessions, listed under its card in the left column
  // (#55). Each list keeps its own drag order, because a session's position
  // is an order within its workspace.
  const renderWorkspaceSessions = (item: WorkspaceDto) => {
    const itemSessions = agents.filter(
      (session) => session.workspaceId === item.id,
    );
    const liveSessions = itemSessions.filter((session) => !session.archivedAt);
    const archived = itemSessions.filter((session) => session.archivedAt);
    // Offered only for the workspace in focus, but its row's space is kept
    // under every workspace that has some, so focus moving never shifts the
    // list (#55).
    const archiveInFocus = !showingAll && item.id === workspaceId;
    const launches = pendingSessionLaunches(
      sessionLaunches.filter((launch) => launch.workspaceId === item.id),
      itemSessions,
    );
    if (
      liveSessions.length === 0 &&
      launches.length === 0 &&
      archived.length === 0
    )
      return null;
    return (
      <ReorderGroup
        ids={liveSessions.map((session) => session.id)}
        onCommit={(sessionIds) =>
          perform(
            client.request.agentReorder({ sessionIds, workspace: item.id }),
          )
        }
      >
        {(reorder) => {
          // Pinned sessions sit above the rest, in the order they were
          // pinned; the manual order holds within each group.
          const ordered = reorder.order
            .flatMap(
              (id) => liveSessions.find((session) => session.id === id) ?? [],
            )
            .sort((left, right) =>
              left.pinnedAt && right.pinnedAt
                ? left.pinnedAt.localeCompare(right.pinnedAt)
                : Number(Boolean(right.pinnedAt)) -
                  Number(Boolean(left.pinnedAt)),
            );
          return (
            <div
              aria-label={`Sessions in ${item.name}`}
              className="workspace-sessions"
              role="group"
            >
              <div
                className="session-grid"
                data-reordering={reorder.draggingId ? "true" : undefined}
              >
                {launches.map(renderLaunchCard)}
                {ordered.map((session) => renderSessionCard(session, reorder))}
              </div>
              {archived.length > 0 && (
                <details
                  aria-hidden={archiveInFocus ? undefined : true}
                  className="archive-list session-archive-list"
                  data-in-focus={archiveInFocus ? "true" : undefined}
                  // Out of focus it is a closed, invisible placeholder.
                  {...(archiveInFocus ? {} : { open: false })}
                >
                  <summary tabIndex={archiveInFocus ? undefined : -1}>
                    Archived sessions ({archived.length})
                  </summary>
                  <div className="item-list">
                    {archived.map((session) => (
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
            </div>
          );
        }}
      </ReorderGroup>
    );
  };

  // The focus mark on the column's edge (see `.workspace-column[data-focus]`).
  // It follows the card through scrolling, folding and every render, and is
  // written straight to the element so measuring never re-renders the app.
  const workspaceColumnRef = useRef<HTMLElement>(null);
  const focusSelector =
    view === "session"
      ? ".workspace-sessions .session-card.selected"
      : ".workspace-group > .workspace-card.selected";
  useLayoutEffect(() => {
    const column = workspaceColumnRef.current;
    const list = column?.querySelector<HTMLElement>(":scope > .item-list");
    if (!column || !list) return;
    const place = () => {
      const card = list.querySelector<HTMLElement>(focusSelector);
      if (!card) {
        column.removeAttribute("data-focus");
        return;
      }
      const columnTop = column.getBoundingClientRect().top;
      const cardBox = card.getBoundingClientRect();
      const listBox = list.getBoundingClientRect();
      const top = Math.max(cardBox.top, listBox.top);
      const bottom = Math.min(cardBox.bottom, listBox.bottom);
      if (bottom - top < 4) {
        column.removeAttribute("data-focus");
        return;
      }
      column.style.setProperty("--focus-top", `${top - columnTop}px`);
      column.style.setProperty("--focus-height", `${bottom - top}px`);
      column.setAttribute("data-focus", "true");
    };
    place();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    list.addEventListener("scroll", schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      list.removeEventListener("scroll", schedule);
      resize.disconnect();
    };
  });

  const anyWorkspaceExpanded = activeWorkspaces.some(
    (item) => !collapsedWorkspaceIds.has(item.id),
  );

  // The card above the workspaces (#35). Its roll-up is the workspace cards'
  // summed: what a dispatcher wants to know before choosing where to look.
  const everySession = agents.filter(
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
          onOpenSession={(session) =>
            showSession(session.id, session.workspaceId)
          }
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
    const confirmed = await askConfirm({
      title: "Delete task",
      message: `Permanently delete task #${task.number} "${task.title}"? This cannot be undone.`,
      confirmLabel: "Delete task",
      danger: true,
    });
    if (!confirmed) return;
    await perform(client.request.taskRemove({ id: task.id, force: true }));
    setSelectedTaskId(undefined);
  }

  const reportsByTask = new Map(
    (snapshot?.routineReports ?? []).flatMap((report) =>
      report.taskId ? [[report.taskId, report] as const] : [],
    ),
  );
  const sessionsById = new Map(agents.map((session) => [session.id, session]));
  const routineOwners = new Map(
    (snapshot?.abilities ?? []).flatMap((ability) => {
      const session = sessionsById.get(ability.sessionId);
      return session
        ? [[ability.id, { name: session.name, color: session.color }] as const]
        : [];
    }),
  );
  const boardView = workspace ? (
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
      onDraftBrief={(task) => void startTaskSession(task, { draftBrief: true })}
      onQuickCapture={quickCaptureTask}
      onAnswer={async (session, text) =>
        Boolean(
          await perform(client.request.agentSend({ id: session.id, text })),
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
      routineReports={reportsByTask}
      routineOwners={routineOwners}
      onReportVerdict={(report, verdict) =>
        void perform(
          client.request.routineReportVerdict({
            id: report.id,
            verdict,
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
      onOpenSession={(session) => showSession(session.id, session.workspaceId)}
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
  ) : null;

  return (
    <main
      className={`app ${terminalPanelOpen ? "terminal-panel-open" : ""}`}
      data-theme={theme}
      style={
        {
          "--terminal-panel-height": `${terminalPanelHeight}px`,
          "--workspace-panel-width": `${workspacePanelWidth}px`,
          "--board-detail-panel-width": `${boardDetailPanelWidth}px`,
        } as CSSProperties
      }
    >
      <ToastStack
        onDismiss={(ids) => void dismissToasts(ids)}
        onOpen={(toast) => {
          // Without the deep link people learn to ignore these.
          const sessionWorkspaceId =
            toast.workspaceId ??
            snapshot?.agents.find((item) => item.id === toast.sessionId)
              ?.workspaceId;
          if (toast.sessionId && sessionWorkspaceId)
            showSession(toast.sessionId, sessionWorkspaceId);
          else if (toast.workspaceId) selectWorkspace(toast.workspaceId);
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
          {/* Apart from the tabs: the World is every workspace at once. */}
          <button
            aria-pressed={view === "world"}
            className={`world-toggle ${view === "world" ? "active" : ""}`}
            disabled={!workspace}
            onClick={() =>
              setView(view === "world" ? lastWorkspaceView.current : "world")
            }
            title={
              view === "world"
                ? "Back to the workspace (⌘4)"
                : "Every workspace's agents at once (⌘4)"
            }
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path d="M8 1.5h6.5v13h-13v-13H5M5 4.5h6.5v7h-7v-7M8 7.5h1v1" />
            </svg>
            World
          </button>
        </div>
      </header>
      {/* One grid row holds every banner, so two at once stack in it. */}
      <div className="banner-stack">
        {/* Settings shows the same state in About, so the bar would only
            repeat it behind the dialog. */}
        {appUpdate && modal !== "settings" && (
          <UpdateBanner
            onDismiss={dismissUpdate}
            onInstall={installUpdate}
            update={appUpdate}
          />
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(undefined)}>Dismiss</button>
          </div>
        )}
      </div>

      <div
        className={`workspace-shell mode-${view} ${workspacePanelVisible ? "has-workspace-panel" : ""}`}
      >
        <aside className="workspace-column" ref={workspaceColumnRef}>
          <div className="section-heading workspace-column-heading">
            <div className="workspace-column-title">
              <h1>Workspaces</h1>
            </div>
            <div className="panel-heading-actions">
              <button
                aria-label="Create workspace"
                className="quiet workspace-heading-create"
                onClick={() => setModal("workspace")}
                title="New workspace"
                type="button"
              >
                +
              </button>
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
                  <span>Use + to create one.</span>
                </div>
              )}
            {allWorkspacesCard}
            {/* Under All workspaces, its arrow in line with each
                workspace's own. */}
            {activeWorkspaces.length > 0 && (
              <button
                aria-label={
                  anyWorkspaceExpanded
                    ? "Collapse all session lists"
                    : "Expand all session lists"
                }
                className="quiet workspace-fold-all"
                onClick={() =>
                  setCollapsedWorkspaceIds(
                    anyWorkspaceExpanded
                      ? new Set(activeWorkspaces.map((item) => item.id))
                      : new Set(),
                  )
                }
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  {anyWorkspaceExpanded ? (
                    <path d="M5 2.5l3 3 3-3M5 13.5l3-3 3 3" />
                  ) : (
                    <path d="M5 5.5l3-3 3 3M5 10.5l3 3 3-3" />
                  )}
                </svg>
                {anyWorkspaceExpanded ? "Collapse all" : "Expand all"}
              </button>
            )}
            {orderedWorkspaces.map((item) => {
              const itemSessions = agents.filter(
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
              const sessionList = renderWorkspaceSessions(item);
              const expanded = !collapsedWorkspaceIds.has(item.id);

              return (
                // The group, not the card, is what a workspace drag measures:
                // its sessions travel with it.
                <div
                  className="workspace-group"
                  data-expanded={expanded ? "true" : undefined}
                  key={item.id}
                  ref={workspaceReorder.registerCard(item.id)}
                >
                  <div
                    className={`workspace-card ${!showingAll && item.id === workspaceId ? "selected" : ""}`}
                    data-dragging={
                      workspaceReorder.draggingId === item.id
                        ? "true"
                        : undefined
                    }
                    onPointerDown={workspaceReorder.onPointerDown(item.id)}
                  >
                    <button
                      aria-controls={`workspace-sessions-${item.id}`}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${item.name} sessions`}
                      className="quiet workspace-disclosure"
                      data-no-drag
                      disabled={!sessionList}
                      onClick={() => setWorkspaceCollapsed(item.id, expanded)}
                      title={
                        sessionList
                          ? `${expanded ? "Hide" : "Show"} sessions`
                          : "No sessions"
                      }
                      type="button"
                    >
                      <svg aria-hidden="true" viewBox="0 0 16 16">
                        <path d="M6 4l4 4-4 4" />
                      </svg>
                    </button>
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
                      <span className="workspace-folder-icon">
                        <WorkspaceFolderIcon />
                      </span>
                      <span className="workspace-card-content">
                        <strong className="workspace-card-name">
                          <span>{item.name}</span>
                        </strong>
                        {/* The slug is in the main header; the card only
                            speaks up when the folder is gone. */}
                        {!item.available && (
                          <small>{item.slug} · folder missing</small>
                        )}
                        <span
                          aria-label={insightLabel}
                          className="workspace-session-insights"
                        >
                          {/* An open list shows each session itself. */}
                          {!(expanded && sessionList) &&
                            itemViews.length > 0 && (
                              <span className="workspace-session-icons">
                                {itemViews
                                  .slice(0, 5)
                                  .map(({ session, view }) => {
                                    const tool = sessionTool(session);
                                    return (
                                      <span
                                        className={`workspace-session-indicator tool-${tool}`}
                                        data-attention={
                                          view.attention ? "true" : undefined
                                        }
                                        key={session.id}
                                        title={statusAriaLabel(
                                          session,
                                          view,
                                          now,
                                        )}
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
                            )}
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
                      {/* Last, so the ones that come in on hover open to its
                          left and it never moves. */}
                      <button
                        aria-label={`Create session in ${item.name}`}
                        className="session-card-action workspace-session-create"
                        disabled={
                          !item.available || !snapshot?.settings.tmuxAvailable
                        }
                        onClick={() => openSessionModal(undefined, item)}
                        title="New session"
                        type="button"
                      >
                        +
                      </button>
                    </span>
                  </div>
                  {expanded && sessionList && (
                    <div id={`workspace-sessions-${item.id}`}>
                      {sessionList}
                    </div>
                  )}
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
          aria-valuemin={WORKSPACE_PANEL_MIN_WIDTH}
          aria-valuenow={workspacePanelWidth}
          className="column-resize-handle workspace-panel-resize-handle"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setWorkspacePanelWidth((width) =>
              clampWorkspacePanelSize(
                width + (event.key === "ArrowRight" ? PANEL_STEP : -PANEL_STEP),
                480,
              ),
            );
          }}
          onPointerDown={(event) => startColumnResize(event, "workspace")}
          role="separator"
          tabIndex={0}
        />

        {view !== "session" && (
          <section
            className={`workspace-main ${view === "board" ? "board-column" : view === "world" ? "workspace-content-column world-column" : "workspace-content-column"}`}
          >
            <div className="workspace-main-header">
              <div>
                <span className="eyebrow">
                  {(showingAll || view === "world") && workspace
                    ? `${activeWorkspaces.length} ${activeWorkspaces.length === 1 ? "workspace" : "workspaces"}`
                    : (workspace?.slug ?? "Select a workspace")}
                </span>
                <h1>
                  {(showingAll || view === "world") && workspace
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
                  <FilesView
                    client={client}
                    gitStatus={changedPaths}
                    worktreeBases={worktreeBases}
                    // A request belongs to the workspace it was made for, and
                    // is cleared once shown, so a remount of this view (another
                    // workspace, or a return to it) does not replay it.
                    openRequest={
                      fileOpenRequest?.workspaceId === workspace.id
                        ? fileOpenRequest
                        : undefined
                    }
                    onOpenRequestShown={() => setFileOpenRequest(undefined)}
                    initialRoot={workspaceContent.files}
                    key={workspace.id}
                    onError={setError}
                    onJournalTargetShown={() => setJournalTarget(undefined)}
                    onWorkspaceDocumentSaved={() =>
                      void refreshWorkspaceContent()
                    }
                    journalTarget={journalTarget}
                    theme={theme}
                    workspace={workspace}
                  />
                )}
              </>
            ) : view === "world" ? (
              <Suspense
                fallback={<div className="empty large">Opening the World…</div>}
              >
                <WorldView
                  appearance={theme}
                  preview={!!snapshot && snapshot.settings.channel !== "stable"}
                  // The World is every workspace at once, whatever the sidebar
                  // has selected: it is the one view of everything running.
                  model={buildWorldModel(
                    worldInputFromSnapshot(snapshot, orderedWorkspaces, now),
                  )}
                  onPopOut={() => {
                    void client.request.worldWindowOpen({});
                    setView(lastWorkspaceView.current);
                  }}
                  now={now}
                  onOpenSession={showSession}
                />
              </Suspense>
            ) : view === "board" ? (
              boardView
            ) : null}
          </section>
        )}

        {workspace && workspacePanelVisible && (
          <div
            aria-label="Resize repositories panel"
            aria-orientation="vertical"
            aria-valuemax={720}
            aria-valuemin={PANEL_RAIL_WIDTH}
            aria-valuenow={boardDetailPanelWidth}
            className="column-resize-handle secondary-panel-resize-handle"
            onDoubleClick={toggleBoardDetailPanel}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                return;
              event.preventDefault();
              const movement =
                event.key === "ArrowRight" ? PANEL_STEP : -PANEL_STEP;
              setBoardDetailPanelWidth((width) =>
                clampPanelSize(width - movement, 720),
              );
            }}
            onPointerDown={(event) => startColumnResize(event, "secondary")}
            role="separator"
            tabIndex={0}
          >
            {/* The panel's edge is its handle: drag to resize, click the tab
                to fold it to a rail and back. */}
            <button
              aria-expanded={!workspacePanelCollapsed}
              aria-label={
                workspacePanelCollapsed
                  ? "Expand workspace panel"
                  : "Collapse workspace panel"
              }
              className="panel-edge-toggle"
              onClick={toggleBoardDetailPanel}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              title={`${workspacePanelCollapsed ? "Expand" : "Collapse"} workspace panel (⌥⌘B)`}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 8 14">
                <path
                  d={workspacePanelCollapsed ? "M6 1 1 7l5 6" : "M2 1l5 6-5 6"}
                />
              </svg>
            </button>
          </div>
        )}

        {/* The column is one workspace's repositories, so with every
            workspace showing there is none; the board takes the width. */}
        {workspacePanelVisible && workspace && (
          <aside
            aria-label="Workspace panel"
            className={`board-detail-column ${workspacePanelCollapsed ? "panel-compact" : ""}`}
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
              </div>
            </div>
            {/* Fetch and pull for every repository at once, a row of their
                own so the heading stays the panel's name and Add. */}
            {!workspacePanelCollapsed &&
            workspaceContent?.repositories.length ? (
              <div className="repository-toolbar">
                {(["fetch", "pull"] as const).map((mode) => {
                  const anyRunning = ["fetch", "pull"].some((kind) =>
                    [...pendingRepositoryActions].some((action) =>
                      action.startsWith(`${kind}:`),
                    ),
                  );
                  return (
                    <button
                      aria-label={`${mode === "fetch" ? "Fetch" : "Pull"} all repositories`}
                      className={`quiet repository-header-action ${pendingRepositoryActions.has(`${mode}:all`) ? "syncing" : ""}`}
                      disabled={
                        !workspaceContent?.repositories.some(
                          (item) => item.status === "ready",
                        ) || anyRunning
                      }
                      key={mode}
                      onClick={() => void fetchWorkspaceRepositories(mode)}
                      title={
                        mode === "fetch"
                          ? "Fetch every repository. No checkout moves."
                          : "Pull every repository: fetch, and move each checkout to the latest default branch"
                      }
                      type="button"
                    >
                      {mode === "fetch" ? (
                        <RepositoryFetchIcon />
                      ) : (
                        <RepositoryPullIcon />
                      )}
                      {mode === "fetch" ? "Fetch all" : "Pull all"}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {workspacePanelCollapsed ? workspaceRail : workspaceRepositories}
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

        {view === "session" && workspace && (
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
                  ) : openingLaunch ? (
                    openingLaunch.name || "New session"
                  ) : (
                    "No session selected"
                  )}
                </h1>
              </div>
              {activeSession ? (
                <small>{activeSession.status}</small>
              ) : (
                openingLaunch && <small>starting</small>
              )}
            </div>
            {activeSessionRoutines && activeSession && (
              <RoutineBar
                busy={busy}
                color={activeSession.color}
                onOpenPanel={() => openRoutinesPanel(activeSession.id)}
                onRunNow={() =>
                  void routinesAction(
                    activeSession.id,
                    client.request.routineRunNow({
                      sessionId: activeSession.id,
                    }),
                  )
                }
                onTogglePause={() =>
                  void routinesAction(
                    activeSession.id,
                    client.request.routinesControl({
                      sessionId: activeSession.id,
                      action: activeSessionRoutines.paused ? "resume" : "pause",
                    }),
                  )
                }
                status={activeSessionRoutines}
              />
            )}
            {activeSession ? (
              // The drawer sits over the terminal, below the routine bar, so
              // the bar's buttons stay in reach while it is open.
              <div className="terminal-stage">
                {activeSessionRoutines &&
                  routinesPanel?.sessionId === activeSession.id && (
                    <RoutinesPanel
                      busy={busy}
                      detail={routinesPanel.detail}
                      error={routinesPanel.error}
                      now={now}
                      onClose={() => setRoutinesPanel(undefined)}
                      onRunNow={(name) =>
                        void routinesAction(
                          activeSession.id,
                          client.request.routineRunNow({
                            sessionId: activeSession.id,
                            name,
                          }),
                        )
                      }
                      onSavePurpose={(purpose) =>
                        void routinesAction(
                          activeSession.id,
                          client.request.routinesPurpose({
                            sessionId: activeSession.id,
                            purpose,
                          }),
                        )
                      }
                      onSetEnabled={(name, enabled) =>
                        void routinesAction(
                          activeSession.id,
                          client.request.routineSetEnabled({
                            sessionId: activeSession.id,
                            name,
                            enabled,
                          }),
                        )
                      }
                      sessionName={sessionName(activeSession)}
                    />
                  )}
                <TerminalSurface
                  activity={activityById.get(activeSession.id)}
                  attention={attentionById.get(activeSession.id)}
                  terminalEndpoint={terminalEndpoint}
                  focused={shouldFocusSession(
                    focusedSessionId,
                    activeSession.id,
                  )}
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
                  onCopy={copyTerminalText}
                  onFocused={clearSessionFocusRequest}
                  onOpenLink={openTerminalLink}
                  fileLinks={fileLinksFrom([
                    activeSession.workingDirectory,
                    ...(snapshot?.worktrees ?? [])
                      .filter((item) => item.sessionId === activeSession.id)
                      .map((item) => item.path),
                  ])}
                  session={activeSession}
                  status={activeSession.status}
                  target="agent"
                  telemetry={activeSessionTelemetry}
                  worktree={activeSessionWorktree}
                />
              </div>
            ) : openingLaunch ? (
              <div className="terminal-empty">
                <strong>Starting {openingLaunch.tool}…</strong>
                <span>The terminal opens here as soon as it is ready.</span>
              </div>
            ) : (
              <div className="terminal-empty">
                <strong>Select a session</strong>
                <span>
                  Choose one under its workspace, or start one with the
                  workspace&apos;s +.
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
            aria-label={
              appUpdate?.state === "available"
                ? `Open settings. Daedalus ${appUpdate.version} is available`
                : "Open settings"
            }
            className="quiet settings-corner-button"
            onClick={() => {
              // An offer opens Settings on About, where its button is.
              if (appUpdate?.state === "available") setSettingsSection("about");
              setModal("settings");
            }}
            title={
              appUpdate?.state === "available"
                ? `Settings · Daedalus ${appUpdate.version} is available`
                : "Settings"
            }
            type="button"
          >
            <SettingsIcon />
            {appUpdate?.state === "available" ? (
              <span aria-hidden="true" className="update-dot" />
            ) : undefined}
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
                    onCopy={copyTerminalText}
                    onOpenLink={openTerminalLink}
                    fileLinks={fileLinksFrom([terminal.workingDirectory])}
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
              <div className="session-model-picker">
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
                  aria-label="Model"
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
                {!sessionChoiceIsWorkspaceDefault && (
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
              </div>
            )}
            <div className="session-color-picker">
              <span>
                <strong>Color</strong>
                <small>On the card&apos;s edge and the World figure</small>
              </span>
              <ColorSwatches
                onChange={(color) =>
                  setSessionForm({ ...sessionForm, color: color ?? undefined })
                }
                value={sessionForm.color ?? null}
              />
            </div>
            {sessionType !== "terminal" && (
              <label className="session-ability-option">
                <span>
                  <strong>Routines</strong>
                  <small>
                    Checks this session runs on a schedule while the app is
                    open. Ask it for routines once it starts.
                  </small>
                </span>
                <input
                  aria-label="Routines enabled"
                  checked={Boolean(sessionForm.routines)}
                  className="switch"
                  onChange={(event) =>
                    setSessionForm({
                      ...sessionForm,
                      routines: event.target.checked,
                    })
                  }
                  type="checkbox"
                />
              </label>
            )}
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
        <Modal
          onClose={() => {
            setModal(undefined);
            // "Up to date" and a failed check were answers to the button in
            // About, already read there. Kept, they would reappear as a bar.
            if (appUpdate?.state === "current" || appUpdate?.state === "error")
              dismissUpdate();
          }}
          title="Settings"
          wide
        >
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
            updates={{
              update: appUpdate,
              checking: checkingUpdate,
              onCheck: checkForUpdate,
              onInstall: installUpdate,
            }}
          />
        </Modal>
      )}

      {worktreeAction &&
        (() => {
          const status = worktreeAction.worktree.gitStatus;
          const unsaved = status?.changedFiles ?? 0;
          // The same two facts the removal guard checks: a merged pull
          // request holding HEAD means the commits are on the base branch.
          const unpushed = worktreeAction.worktree.landed
            ? 0
            : (status?.unpushed ?? status?.ahead ?? 0);
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
            {routinesBySession.has(sessionAction.session.id) && (
              <p>
                This session runs routines. Archiving pauses them and keeps them
                and their tasks. Restoring the session resumes them.
              </p>
            )}
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
      <DialogHost />
    </main>
  );
}

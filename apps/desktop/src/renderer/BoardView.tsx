/**
 * The board: tasks in derived lanes, each card a summary of its run.
 *
 * Its user is a dispatcher running several agents, not a worker moving their
 * own card, so a card answers "is this waiting on me, and for how long?"
 * before it answers "what stage was this filed under". The lanes come from
 * `board-lanes.ts`; this file only draws them and forwards clicks.
 */
import { useEffect, useState } from "react";
import type {
  AgentActivityDto,
  AgentSessionDto,
  ProviderModelCatalogDto,
  SessionAttentionDto,
  SessionTelemetryDto,
  SessionWorktreeDto,
  TaskDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import {
  BOARD_LANES,
  boardLanes,
  LANE_LABEL,
  taskSessions,
  taskWaitingSince,
  taskWorktrees,
  type BoardLane,
  type LaneInputs,
} from "./board-lanes";
import {
  AgentStatusDot,
  CreateButton,
  providerLabel,
  sessionConfiguredModel,
  sessionStatusView,
  sessionTool,
  statusAriaLabel,
  ToolIcon,
  waitingLabel,
} from "./session-view";

export type BoardProvider = "claude" | "codex";

/** A Start the user clicked that has not become a session yet. */
export interface BoardLaunch {
  key: string;
  taskId?: string;
  tool: "codex" | "claude" | "terminal";
  status: "starting" | "error";
  error?: string;
  sessionId?: string;
}

export interface BoardViewProps {
  workspace: WorkspaceDto;
  /** The workspace's tasks, in service order. */
  tasks: TaskDto[];
  /** The workspace's sessions, archived ones included. */
  sessions: AgentSessionDto[];
  activity: ReadonlyMap<string, AgentActivityDto>;
  attention: ReadonlyMap<string, SessionAttentionDto>;
  telemetry: ReadonlyMap<string, SessionTelemetryDto>;
  /** The workspace's session worktrees. */
  worktrees: SessionWorktreeDto[];
  launches: BoardLaunch[];
  selectedTaskId?: string;
  now: number;
  busy: boolean;
  tmuxAvailable: boolean;
  /** Providers installed on this machine, in the order to prefer them. */
  availableProviders: BoardProvider[];
  modelCatalogs: Partial<Record<BoardProvider, ProviderModelCatalogDto>>;
  onNeedModels: (provider: BoardProvider) => void;
  onSelectTask: (task: TaskDto) => void;
  onOpenSession: (session: AgentSessionDto) => void;
  onStart: (task: TaskDto) => void;
  /** Start with a provider and model chosen in the session dialog. */
  onStartWith: (task: TaskDto) => void;
  onDismissLaunch: (key: string) => void;
  onCreateTask: () => void;
  onOpenLink: (url: string) => void;
  onSetInProgress: (task: TaskDto) => void;
  onUpdateSettings: (changes: {
    startSetsInProgress?: boolean;
    defaultProvider?: BoardProvider | null;
    defaultModel?: string | null;
  }) => void;
}

const COLLAPSED_BY_DEFAULT: ReadonlySet<BoardLane> = new Set(["done"]);

const collapsedStorageKey = (workspaceId: string) =>
  `daedalus.board.collapsed.${workspaceId}`;

function rememberedCollapsed(workspaceId: string): Set<BoardLane> {
  try {
    const raw = window.localStorage.getItem(collapsedStorageKey(workspaceId));
    if (raw === null) return new Set(COLLAPSED_BY_DEFAULT);
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((lane): lane is BoardLane =>
            (BOARD_LANES as readonly string[]).includes(lane),
          )
        : COLLAPSED_BY_DEFAULT,
    );
  } catch {
    return new Set(COLLAPSED_BY_DEFAULT);
  }
}

/** "stopped 2h ago", or "stopped just now". */
const agoLabel = (since: string | null, now: number) => {
  const elapsed = waitingLabel(since, now);
  return elapsed === "just now" ? elapsed : `${elapsed} ago`;
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "+6 commits, 12 files", the shape of what a reviewer would read. */
export function worktreeDeltaLabel(worktree: SessionWorktreeDto): string {
  const status = worktree.gitStatus;
  if (!status) return "measuring…";
  if (status.state === "unavailable") return "status unavailable";
  const parts: string[] = [];
  if (status.ahead > 0) {
    parts.push(`+${plural(status.ahead, "commit")}`);
    if (status.filesAhead !== undefined)
      parts.push(plural(status.filesAhead, "file"));
  } else parts.push("no commits yet");
  if (status.changedFiles > 0) parts.push(`${status.changedFiles} uncommitted`);
  if (status.behind > 0) parts.push(`${status.behind} behind`);
  return parts.join(", ");
}

const worktreeShortName = (worktree: SessionWorktreeDto) =>
  worktree.sessionId.slice(0, 8);

const LANE_GLYPH_LABEL: Record<BoardLane, string> = {
  needs_me: "needs you",
  review: "ready for review",
  running: "running",
  queued: "queued",
  parked: "parked",
  done: "done",
};

function BoardSessionRow({
  activity,
  attention,
  now,
  onOpen,
  session,
  telemetry,
}: {
  activity?: AgentActivityDto;
  attention?: SessionAttentionDto;
  now: number;
  onOpen: () => void;
  session: AgentSessionDto;
  telemetry?: SessionTelemetryDto;
}) {
  const view = sessionStatusView(session, activity, attention);
  const tool = sessionTool(session);
  const model = telemetry?.model ?? sessionConfiguredModel(session);
  const context = telemetry?.context?.usedPercent;
  const live = session.status === "running" || session.status === "starting";
  const summary = [
    session.kind === "terminal" ? "terminal" : session.provider,
    model,
    context !== undefined ? `${Math.round(context)}% ctx` : undefined,
    live || view.attention
      ? undefined
      : `stopped ${agoLabel(session.endedAt, now)}`,
  ].filter(Boolean);
  return (
    <button
      aria-label={`Open ${statusAriaLabel(session, view, now)}`}
      className={`board-session-row tone-${view.tone}`}
      data-attention={view.attention ? "true" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      title="Open this session"
      type="button"
    >
      <span className="board-session-summary">
        <AgentStatusDot count={view.reasons.length} view={view} />
        <span className={`board-session-tool tool-${tool}`}>
          <ToolIcon tool={tool} />
        </span>
        <span>{summary.join(" · ")}</span>
      </span>
      {(live || view.attention) && (
        <span className="board-session-activity">
          <span>
            {view.label} {waitingLabel(view.since, now)}
          </span>
          {view.unconfirmed && (
            <span
              className="session-status-unconfirmed"
              title="Read from the terminal pane, not reported by the agent"
            >
              unconfirmed
            </span>
          )}
          {view.detail && (
            <span className="board-session-detail"> · {view.detail}</span>
          )}
        </span>
      )}
    </button>
  );
}

function BoardSettings({
  availableProviders,
  modelCatalogs,
  onNeedModels,
  onUpdate,
  workspace,
}: {
  availableProviders: BoardProvider[];
  modelCatalogs: BoardViewProps["modelCatalogs"];
  onNeedModels: BoardViewProps["onNeedModels"];
  onUpdate: BoardViewProps["onUpdateSettings"];
  workspace: WorkspaceDto;
}) {
  const [open, setOpen] = useState(false);
  const provider = workspace.defaultProvider;
  const effective = provider ?? availableProviders[0];
  useEffect(() => {
    if (open && effective && !modelCatalogs[effective]) onNeedModels(effective);
  }, [effective, modelCatalogs, onNeedModels, open]);
  const catalog = effective ? modelCatalogs[effective] : undefined;
  return (
    <details
      className="board-settings"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label="Board settings" title="Board settings">
        Start with{" "}
        <strong>
          {effective ? providerLabel(effective) : "no provider"}
          {workspace.defaultModel ? ` · ${workspace.defaultModel}` : ""}
        </strong>
      </summary>
      <div className="board-settings-popover">
        <label>
          Provider
          <select
            aria-label="Default provider for Start"
            onChange={(event) =>
              onUpdate({
                defaultProvider:
                  event.target.value === ""
                    ? null
                    : (event.target.value as BoardProvider),
              })
            }
            value={provider ?? ""}
          >
            <option value="">
              First installed
              {availableProviders[0]
                ? ` (${providerLabel(availableProviders[0])})`
                : ""}
            </option>
            {(["claude", "codex"] as const).map((item) => (
              <option
                disabled={!availableProviders.includes(item)}
                key={item}
                value={item}
              >
                {providerLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select
            aria-label="Default model for Start"
            disabled={!effective}
            onChange={(event) =>
              onUpdate({ defaultModel: event.target.value || null })
            }
            value={workspace.defaultModel ?? ""}
          >
            <option value="">Provider default</option>
            {workspace.defaultModel &&
              !catalog?.models.some(
                (model) => model.id === workspace.defaultModel,
              ) && (
                <option value={workspace.defaultModel}>
                  {workspace.defaultModel}
                </option>
              )}
            {catalog?.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        <label className="board-settings-toggle">
          <input
            checked={workspace.startSetsInProgress}
            onChange={(event) =>
              onUpdate({ startSetsInProgress: event.target.checked })
            }
            type="checkbox"
          />
          Start moves the task to in progress
        </label>
      </div>
    </details>
  );
}

export function BoardView(props: BoardViewProps) {
  const {
    activity,
    attention,
    now,
    sessions,
    tasks,
    telemetry,
    workspace,
    worktrees,
  } = props;
  const [collapsed, setCollapsed] = useState(() =>
    rememberedCollapsed(workspace.id),
  );
  useEffect(
    () => setCollapsed(rememberedCollapsed(workspace.id)),
    [workspace.id],
  );
  const toggleLane = (lane: BoardLane) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      try {
        window.localStorage.setItem(
          collapsedStorageKey(workspace.id),
          JSON.stringify([...next]),
        );
      } catch {
        // A lane that forgets it was collapsed is a preference lost, not a bug.
      }
      return next;
    });

  const inputs: LaneInputs = { sessions, activity, attention, worktrees };
  const groups = boardLanes(tasks, inputs);

  const renderCard = (task: TaskDto, lane: BoardLane) => {
    const linked = taskSessions(task, sessions);
    const output = taskWorktrees(task, inputs);
    const launches = props.launches.filter(
      (launch) =>
        launch.taskId === task.id &&
        (launch.status === "error" ||
          !linked.some((session) => session.id === launch.sessionId)),
    );
    const waiting =
      lane === "needs_me" ? taskWaitingSince(task, inputs) : undefined;
    const cardLabel = [
      `#${task.number} ${task.title}`,
      LANE_LABEL[lane],
      waiting ? `waiting ${waitingLabel(waiting, now)}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const liveAgent = linked.some(
      (session) =>
        session.kind === "agent" &&
        (session.status === "running" || session.status === "starting"),
    );
    const startable = (lane === "queued" || lane === "parked") && !liveAgent;
    const starting = launches.some((launch) => launch.status === "starting");
    return (
      <article
        aria-label={cardLabel}
        className={`board-card lane-${lane} ${task.id === props.selectedTaskId ? "selected" : ""}`}
        data-task-number={task.number}
        key={task.id}
        onClick={() => props.onSelectTask(task)}
      >
        <div className="board-card-title">
          <span className="board-card-number">#{task.number}</span>
          <strong>{task.title}</strong>
          {task.priority !== "normal" && (
            <span className={`board-card-priority priority-${task.priority}`}>
              {task.priority}
            </span>
          )}
        </div>
        {linked.length > 0 && (
          <div className="board-card-sessions">
            {linked.map((session) => (
              <BoardSessionRow
                activity={activity.get(session.id)}
                attention={attention.get(session.id)}
                key={session.id}
                now={now}
                onOpen={() => props.onOpenSession(session)}
                session={session}
                telemetry={telemetry.get(session.id)}
              />
            ))}
          </div>
        )}
        {launches.map((launch) => (
          <div
            aria-busy={launch.status === "starting"}
            className={`board-launch-row board-launch-${launch.status}`}
            key={launch.key}
          >
            {launch.status === "starting" ? (
              <>
                <span aria-hidden="true" className="session-launch-spinner" />
                <span>Starting {launch.tool}…</span>
              </>
            ) : (
              <>
                <span role="alert">
                  {launch.tool} failed to start: {launch.error}
                </span>
                <button
                  className="quiet"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDismissLaunch(launch.key);
                  }}
                  type="button"
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        ))}
        {output.map((worktree) => (
          <div
            className="board-output"
            key={`${worktree.sessionId}:${worktree.repositoryId}`}
            title={`${worktree.branchName}\n${worktree.path}`}
          >
            <span>
              worktree {worktreeShortName(worktree)} ·{" "}
              {worktreeDeltaLabel(worktree)}
            </span>
            {worktree.pullRequest && (
              <button
                className="board-pr-link"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpenLink(worktree.pullRequest!.url);
                }}
                title={worktree.pullRequest.url}
                type="button"
              >
                PR #{worktree.pullRequest.number}
                {worktree.pullRequest.state !== "OPEN"
                  ? ` ${worktree.pullRequest.state.toLowerCase()}`
                  : worktree.pullRequest.isDraft
                    ? " draft"
                    : ""}
              </button>
            )}
          </div>
        ))}
        {(startable || (lane === "running" && task.status === "todo")) && (
          <div className="board-card-actions">
            {lane === "running" && task.status === "todo" && (
              <button
                className="quiet"
                disabled={props.busy}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onSetInProgress(task);
                }}
                title="The agent is running; the status still says todo"
                type="button"
              >
                Set in progress
              </button>
            )}
            {startable && (
              <span className="board-start-group">
                <button
                  aria-label={`Start ${task.title}`}
                  className="board-start"
                  disabled={!props.tmuxAvailable || starting}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onStart(task);
                  }}
                  type="button"
                >
                  Start
                </button>
                <button
                  aria-label={`Choose how to start ${task.title}`}
                  className="board-start-choose"
                  disabled={!props.tmuxAvailable || starting}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onStartWith(task);
                  }}
                  title="Choose provider and model"
                  type="button"
                >
                  ▾
                </button>
              </span>
            )}
          </div>
        )}
      </article>
    );
  };

  return (
    <div className="board-view">
      <div className="board-toolbar">
        <div>
          <strong>Tasks</strong>
          <span className="count-badge">{tasks.length}</span>
        </div>
        <div className="heading-actions">
          <BoardSettings
            availableProviders={props.availableProviders}
            modelCatalogs={props.modelCatalogs}
            onNeedModels={props.onNeedModels}
            onUpdate={props.onUpdateSettings}
            workspace={workspace}
          />
          <CreateButton label="Create task" onClick={props.onCreateTask} />
        </div>
      </div>
      <div className="board-lanes">
        {tasks.length === 0 && (
          <div className="empty large">
            <strong>No tasks yet</strong>
            <span>Use New to create a task.</span>
          </div>
        )}
        {tasks.length > 0 &&
          groups.map(({ lane, tasks: laneTasks }) => {
            const open = laneTasks.length > 0 && !collapsed.has(lane);
            return (
              <section
                aria-label={`${LANE_LABEL[lane]}, ${plural(laneTasks.length, "task")}`}
                className={`board-lane lane-${lane}`}
                data-lane={lane}
                key={lane}
              >
                <header className="board-lane-header">
                  <button
                    aria-expanded={open}
                    className="board-lane-toggle"
                    disabled={laneTasks.length === 0}
                    onClick={() => toggleLane(lane)}
                    type="button"
                  >
                    <span aria-hidden="true" className="board-lane-caret">
                      {open ? "▾" : "▸"}
                    </span>
                    <span
                      aria-hidden="true"
                      className={`board-lane-glyph lane-${lane}`}
                      title={LANE_GLYPH_LABEL[lane]}
                    />
                    {LANE_LABEL[lane]}
                    <span className="board-lane-count">{laneTasks.length}</span>
                  </button>
                </header>
                {open && (
                  <div className="board-lane-cards">
                    {laneTasks.map((task) => renderCard(task, lane))}
                  </div>
                )}
              </section>
            );
          })}
      </div>
    </div>
  );
}

/**
 * The board: tasks in derived lanes, each card a summary of its run.
 *
 * Its user is a dispatcher running several agents, not a worker moving their
 * own card, so a card answers "is this waiting on me, and for how long?"
 * before it answers "what stage was this filed under". The lanes come from
 * `board-lanes.ts`; this file only draws them and forwards clicks.
 */
import { useEffect, useState, type ReactNode } from "react";
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
  taskRelations,
  taskWaitingSince,
  unfinishedDependencies,
  type BoardLane,
  type LaneInputs,
} from "./board-lanes";
import {
  taskActions,
  type BoardLaunch,
  type BoardProvider,
} from "./task-actions";
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

export type { BoardLaunch, BoardProvider } from "./task-actions";

export interface BoardViewProps {
  /**
   * The workspace whose board this is, or none when it is every workspace's
   * at once (#35). Without one, capture, the settings and the create button
   * are gone, because each belongs to one workspace, and every card names
   * its workspace beside its number.
   */
  workspace?: WorkspaceDto;
  /** Every active workspace, for the labels and defaults cards read. */
  workspaces: readonly WorkspaceDto[];
  /** The scope's tasks, in service order. */
  tasks: TaskDto[];
  /** The scope's sessions, archived ones included. */
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
  /** Creates a `todo` with only a title. Resolves false when it failed. */
  onQuickCapture: (title: string) => Promise<boolean>;
  /** Spawns a session whose only job is to write this task's brief. */
  onDraftBrief: (task: TaskDto) => void;
  onOpenLink: (url: string) => void;
  onSetInProgress: (task: TaskDto) => void;
  /** Starts the top of Queued with the workspace's default provider. */
  onStartNext: (task: TaskDto) => void;
  /** Starts another provider on a task that already has a session. */
  onSecondOpinion: (task: TaskDto, provider: BoardProvider) => void;
  /** Types a short answer into a waiting session. Resolves false on failure. */
  onAnswer: (session: AgentSessionDto, text: string) => Promise<boolean>;
  onOpenWorktree: (worktree: SessionWorktreeDto) => void;
  onMarkDone: (task: TaskDto) => void;
  /** Sets the task blocked, which moves it to Parked. */
  onPark: (task: TaskDto) => void;
  onUpdateSettings: (changes: {
    startSetsInProgress?: boolean;
    autoHandoffPercent?: number | null;
    defaultProvider?: BoardProvider | null;
    defaultModel?: string | null;
  }) => void;
}

const COLLAPSED_BY_DEFAULT: ReadonlySet<BoardLane> = new Set(["done"]);

/** Collapsed lanes are remembered per workspace, and once for all of them. */
export const ALL_WORKSPACES_BOARD_KEY = "all";

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

/**
 * Warns, never locks. Starting a task whose hard dependency is unfinished is
 * sometimes exactly right, so the only thing asked is that it be deliberate.
 */
/** "No agent running · last one stopped 3h ago", for a card with no agent. */
export function noAgentLabel(endedAt: string | undefined, now: number) {
  if (!endedAt) return "No agent running";
  const age = waitingLabel(endedAt, now);
  return `No agent running · last one stopped ${age === "just now" ? age : `${age} ago`}`;
}

export function confirmStartDespite(task: TaskDto, waiting: TaskDto[]) {
  if (waiting.length === 0) return true;
  const names = waiting.map((item) => `#${item.number} ${item.title}`);
  return window.confirm(
    `${names.join(", ")} ${waiting.length === 1 ? "is" : "are"} not done yet. Start #${task.number} anyway?`,
  );
}

/**
 * A chip names the referenced task and carries its lane, so `after #10`
 * reads as done, running or queued at a glance. The lane is in the glyph's
 * shape and the label, never the colour alone.
 */
export function TaskChip({
  lane,
  onSelect,
  prefix,
  task,
}: {
  lane: BoardLane;
  onSelect: (task: TaskDto) => void;
  prefix?: string;
  task: TaskDto;
}) {
  return (
    <button
      aria-label={`${prefix ? `${prefix} ` : ""}#${task.number} ${task.title}, ${LANE_GLYPH_LABEL[lane]}`}
      className={`board-chip lane-${lane}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(task);
      }}
      title={`#${task.number} ${task.title} · ${LANE_LABEL[lane]}`}
      type="button"
    >
      <span aria-hidden="true" className={`board-lane-glyph lane-${lane}`} />
      {prefix ? `${prefix} ` : ""}#{task.number}
    </button>
  );
}

/**
 * The inspector's "Depends on / Unblocks" block. Both directions, the reverse
 * computed from every other brief.
 */
export function TaskRelationsBlock({
  laneOf,
  onSelect,
  task,
  tasks,
}: {
  laneOf: (task: TaskDto) => BoardLane;
  onSelect: (task: TaskDto) => void;
  task: TaskDto;
  tasks: TaskDto[];
}) {
  const relations = taskRelations(task, tasks);
  const rows: Array<[string, TaskDto[]]> = [
    ["Depends on", relations.dependsOn],
    ["Unblocks", relations.unblocks],
    ["Mentions", relations.mentions],
    ["Mentioned by", relations.mentionedBy],
  ];
  const shown = rows.filter(([, items]) => items.length > 0);
  if (shown.length === 0) return null;
  return (
    <section
      aria-label="Dependencies"
      className="task-inspector-section task-relations"
    >
      <h3>Depends on / Unblocks</h3>
      <dl>
        {shown.map(([label, items]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {items.map((item) => (
                <span className="task-relation" key={item.id}>
                  <TaskChip
                    lane={laneOf(item)}
                    onSelect={onSelect}
                    task={item}
                  />
                  <span className="task-relation-title">{item.title}</span>
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

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
  // A reason Daedalus generated restates the activity ("Codex needs
  // permission: Bash(…)" under "needs permission"), so the row shows what the
  // agent is blocked on instead. A reason the agent wrote is shown as is.
  const detail =
    view.attention && view.reasons.at(-1)?.generated && activity?.detail
      ? activity.detail
      : view.detail;
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
          {detail && <span className="board-session-detail"> · {detail}</span>}
        </span>
      )}
    </button>
  );
}

/**
 * The Needs me lane's reply box. Short answers only: it types the text and
 * presses Enter through `agent send`, exactly as the CLI does. Anything longer
 * belongs in the terminal, which is one click away beside it.
 */
function AnswerBox({
  children,
  onAnswer,
  onOpenTerminal,
  session,
}: {
  children?: ReactNode;
  onAnswer: (text: string) => Promise<boolean>;
  onOpenTerminal: () => void;
  session: AgentSessionDto;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const live = session.status === "running" || session.status === "starting";
  const send = async () => {
    const answer = text.trim();
    if (!answer || sending) return;
    setSending(true);
    try {
      if (await onAnswer(answer)) setText("");
    } finally {
      setSending(false);
    }
  };
  return (
    <div
      className="board-answer"
      onClick={(event) => event.stopPropagation()}
      role="group"
    >
      {live && (
        <input
          aria-label={`Answer ${session.name}`}
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void send();
            } else if (event.key === "Escape") setText("");
          }}
          placeholder="answer…"
          value={text}
        />
      )}
      <button className="quiet" onClick={onOpenTerminal} type="button">
        Terminal
      </button>
      {children}
    </div>
  );
}

/** Where the checkbox lands when first ticked. Late enough to get real work
 * out of a session, early enough that the note is written before the window
 * fills. */
const DEFAULT_AUTO_HANDOFF_PERCENT = 85;

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
  // Matched by id or by the model an alias resolves to, the same test the
  // core applies before a spawn. Undefined until the catalog has loaded.
  const defaultOffered =
    workspace.defaultModel && catalog
      ? catalog.models.some(
          (model) =>
            model.id === workspace.defaultModel ||
            model.resolvedModel === workspace.defaultModel,
        )
      : undefined;
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
              // A model belongs to a provider, so picking one while the
              // provider is still "first installed" pins that provider.
              onUpdate(
                event.target.value
                  ? {
                      defaultProvider: effective ?? null,
                      defaultModel: event.target.value,
                    }
                  : { defaultModel: null },
              )
            }
            value={workspace.defaultModel ?? ""}
          >
            <option value="">Provider default</option>
            {workspace.defaultModel && !defaultOffered && (
              <option value={workspace.defaultModel}>
                {workspace.defaultModel}
                {catalog ? " · not offered any more" : ""}
              </option>
            )}
            {catalog?.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        {workspace.defaultModel && catalog && !defaultOffered && (
          <small className="board-settings-warning" role="alert">
            {providerLabel(effective ?? "provider")} no longer offers{" "}
            {workspace.defaultModel}. Start and new sessions of it refuse until
            another model is picked or the default is cleared.
          </small>
        )}
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
        <label className="board-settings-toggle">
          <input
            checked={workspace.autoHandoffPercent !== null}
            onChange={(event) =>
              onUpdate({
                autoHandoffPercent: event.target.checked
                  ? DEFAULT_AUTO_HANDOFF_PERCENT
                  : null,
              })
            }
            type="checkbox"
          />
          Hand off to a new agent at
          <input
            aria-label="Context percent that triggers a handoff"
            className="board-settings-percent"
            disabled={workspace.autoHandoffPercent === null}
            max={100}
            min={10}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 10 && value <= 100)
                onUpdate({ autoHandoffPercent: value });
            }}
            step={5}
            type="number"
            value={workspace.autoHandoffPercent ?? DEFAULT_AUTO_HANDOFF_PERCENT}
          />
          % context
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
    workspaces,
    worktrees,
  } = props;
  const boardKey = workspace?.id ?? ALL_WORKSPACES_BOARD_KEY;
  const workspaceById = new Map(workspaces.map((item) => [item.id, item]));
  /** A card's workspace: the board's own, or looked up when it has none. */
  const workspaceOf = (task: TaskDto) =>
    workspace ?? workspaceById.get(task.workspaceId);
  const [collapsed, setCollapsed] = useState(() =>
    rememberedCollapsed(boardKey),
  );
  useEffect(() => setCollapsed(rememberedCollapsed(boardKey)), [boardKey]);
  const toggleLane = (lane: BoardLane) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      try {
        window.localStorage.setItem(
          collapsedStorageKey(boardKey),
          JSON.stringify([...next]),
        );
      } catch {
        // A lane that forgets it was collapsed is a preference lost, not a bug.
      }
      return next;
    });

  const [capture, setCapture] = useState("");
  const [capturing, setCapturing] = useState(false);
  const inputs: LaneInputs = { sessions, activity, attention, worktrees };
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const groups = boardLanes(tasks, inputs, {
    isWaiting: (task) => unfinishedDependencies(task, tasksById).length > 0,
  });
  const laneById = new Map(
    groups.flatMap((group) =>
      group.tasks.map((task) => [task.id, group.lane] as const),
    ),
  );
  const submitCapture = async () => {
    const title = capture.trim();
    if (!title || capturing) return;
    setCapturing(true);
    try {
      if (await props.onQuickCapture(title)) setCapture("");
    } finally {
      setCapturing(false);
    }
  };

  const renderCard = (task: TaskDto, lane: BoardLane) => {
    const {
      agentEndedAt,
      answerTarget,
      canPark,
      lastAgent,
      launches,
      linked,
      noAgent,
      offersSecondOpinion,
      otherProvider,
      output,
      reviewPullRequest,
      reviewWorktree,
      startable,
      starting,
      waitingOn,
    } = taskActions(task, lane, {
      ...inputs,
      launches: props.launches,
      availableProviders: props.availableProviders,
      tasksById,
    });
    const waiting =
      lane === "needs_me" ? taskWaitingSince(task, inputs) : undefined;
    // With every workspace on one board, `#12` is ambiguous: the number is
    // per workspace. The slug goes in front, as the CLI writes it.
    const workspaceLabel = workspace
      ? undefined
      : (workspaceById.get(task.workspaceId)?.slug ?? task.workspaceId);
    const cardLabel = [
      `${workspaceLabel ?? ""}#${task.number} ${task.title}`,
      LANE_LABEL[lane],
      waiting ? `waiting ${waitingLabel(waiting, now)}` : undefined,
      noAgent ? "no agent running" : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const secondOpinion = offersSecondOpinion && (
      <button
        className="quiet"
        disabled={!props.tmuxAvailable || !otherProvider || starting}
        onClick={(event) => {
          event.stopPropagation();
          if (otherProvider) props.onSecondOpinion(task, otherProvider);
        }}
        title={
          otherProvider
            ? `Start ${providerLabel(otherProvider)} on this task beside ${providerLabel(lastAgent!.provider)}`
            : "Needs a second provider installed"
        }
        type="button"
      >
        Second opinion
      </button>
    );
    const references = (task.references ?? []).flatMap((reference) => {
      const target = tasksById.get(reference.taskId);
      return target ? [{ reference, target }] : [];
    });
    return (
      <article
        aria-label={cardLabel}
        className={`board-card lane-${lane} ${task.id === props.selectedTaskId ? "selected" : ""}`}
        data-task-number={task.number}
        data-workspace-id={task.workspaceId}
        key={task.id}
        onClick={() => props.onSelectTask(task)}
      >
        <div className="board-card-title">
          {workspaceLabel !== undefined && (
            <span className="board-card-workspace" title="Workspace">
              {workspaceLabel}
            </span>
          )}
          <span className="board-card-number">#{task.number}</span>
          <strong>{task.title}</strong>
          {task.priority !== "normal" && (
            <span className={`board-card-priority priority-${task.priority}`}>
              {task.priority}
            </span>
          )}
        </div>
        {references.length > 0 && (
          <div aria-label="Referenced tasks" className="board-card-chips">
            {references.map(({ reference, target }) => (
              <TaskChip
                key={target.id}
                lane={laneById.get(target.id) ?? "queued"}
                onSelect={props.onSelectTask}
                prefix={
                  !reference.hard
                    ? undefined
                    : target.status === "done"
                      ? "after"
                      : "waiting on"
                }
                task={target}
              />
            ))}
          </div>
        )}
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
        {noAgent && (
          <div className="board-card-no-agent">
            {noAgentLabel(agentEndedAt, now)}
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
        {answerTarget && (
          <AnswerBox
            onAnswer={(text) => props.onAnswer(answerTarget, text)}
            onOpenTerminal={() => props.onOpenSession(answerTarget)}
            session={answerTarget}
          >
            {secondOpinion}
          </AnswerBox>
        )}
        {lane === "review" && (
          <div className="board-card-actions board-review-actions">
            {reviewWorktree && (
              <button
                className="quiet"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpenWorktree(reviewWorktree);
                }}
                title={reviewWorktree.path}
                type="button"
              >
                Open worktree
              </button>
            )}
            {reviewPullRequest && (
              <button
                className="quiet"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpenLink(reviewPullRequest.url);
                }}
                title={reviewPullRequest.url}
                type="button"
              >
                Open PR
              </button>
            )}
            <button
              disabled={props.busy}
              onClick={(event) => {
                event.stopPropagation();
                props.onMarkDone(task);
              }}
              title="Merging stays yours; this only records the verdict"
              type="button"
            >
              Mark done
            </button>
            {secondOpinion}
          </div>
        )}
        {(startable ||
          (offersSecondOpinion && lane !== "review" && !answerTarget) ||
          (lane === "running" && task.status === "todo")) && (
          <div className="board-card-actions">
            {!answerTarget && secondOpinion}
            {noAgent && (
              <button
                className="quiet"
                disabled={props.busy}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onMarkDone(task);
                }}
                title="No agent is running on this task; record it as done"
                type="button"
              >
                Mark done
              </button>
            )}
            {canPark && (
              <button
                className="quiet"
                disabled={props.busy}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onPark(task);
                }}
                title="Set the task blocked, which moves it to Parked"
                type="button"
              >
                Park
              </button>
            )}
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
            {startable && !task.description.trim() && (
              <button
                className="quiet"
                disabled={!props.tmuxAvailable || starting}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onDraftBrief(task);
                }}
                title="Start a session that reads the workspace and writes this brief"
                type="button"
              >
                Draft brief
              </button>
            )}
            {startable && (
              <span className="board-start-group">
                <button
                  aria-label={
                    waitingOn.length
                      ? `Start ${task.title}, waiting on ${waitingOn.map((item) => `#${item.number}`).join(", ")}`
                      : `Start ${task.title}`
                  }
                  className={`board-start${waitingOn.length ? " waiting" : ""}`}
                  disabled={!props.tmuxAvailable || starting}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (confirmStartDespite(task, waitingOn))
                      props.onStart(task);
                  }}
                  title={
                    waitingOn.length
                      ? `Waiting on ${waitingOn.map((item) => `#${item.number}`).join(", ")}`
                      : undefined
                  }
                  type="button"
                >
                  Start{waitingOn.length ? " ⚠" : ""}
                </button>
                <button
                  aria-label={`Choose how to start ${task.title}`}
                  className="board-start-choose"
                  disabled={!props.tmuxAvailable || starting}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (confirmStartDespite(task, waitingOn))
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
        {/* Settings, the create button and capture each write to one
            workspace, so the all-workspaces board has none of them: a task
            is captured on the board of the workspace it belongs to. */}
        {workspace ? (
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
        ) : (
          <small className="board-scope-note">
            {plural(workspaces.length, "workspace")} · capture and settings are
            on each workspace&apos;s own board
          </small>
        )}
      </div>
      <div className="board-lanes">
        {/* Deliberately not a <form>: Enter submitting through the browser's
            implicit-submission path is what wedged the explorer's renderer. */}
        {workspace && (
          <input
            aria-label="Quick capture: type a task title and press Enter"
            className="board-capture"
            disabled={capturing}
            onChange={(event) => setCapture(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitCapture();
              } else if (event.key === "Escape") setCapture("");
            }}
            placeholder="Capture a task… (Enter to add)"
            value={capture}
          />
        )}
        {tasks.length === 0 && (
          <div className="empty large">
            <strong>{workspace ? "No tasks yet" : "No tasks anywhere"}</strong>
            <span>
              {workspace
                ? "Use New to create a task."
                : "Pick a workspace and capture one."}
            </span>
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
                  {lane === "queued" && laneTasks[0] && (
                    <button
                      className="quiet board-start-next"
                      disabled={
                        !props.tmuxAvailable ||
                        props.availableProviders.length === 0
                      }
                      onClick={() => {
                        const next = laneTasks[0]!;
                        if (
                          confirmStartDespite(
                            next,
                            unfinishedDependencies(next, tasksById),
                          )
                        )
                          props.onStartNext(next);
                      }}
                      title={`Start ${workspace ? "" : (workspaceOf(laneTasks[0])?.slug ?? "")}#${laneTasks[0].number} ${laneTasks[0].title} with ${providerLabel(workspaceOf(laneTasks[0])?.defaultProvider ?? props.availableProviders[0] ?? "claude")}`}
                      type="button"
                    >
                      Start next
                    </button>
                  )}
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

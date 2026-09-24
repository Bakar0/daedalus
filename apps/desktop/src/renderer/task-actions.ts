/**
 * What can be done to a task right now, derived once and drawn in two places:
 * the board card and the drawer's action bar (#34). The card used to work
 * this out inline, so the drawer would have had to repeat it and the two
 * would drift. Now both read one description and only decide how to draw it.
 *
 * Pure, like `board-lanes.ts`: it reads the task, its lane, the workspace's
 * sessions and worktrees, and the Starts still in flight, and returns flags.
 * Nothing here calls the host.
 */
import type {
  AgentSessionDto,
  SessionWorktreeDto,
  TaskDto,
} from "@daedalus/protocol";
import {
  sessionWaitingSince,
  taskSessions,
  taskWorktrees,
  unfinishedDependencies,
  type BoardLane,
  type LaneInputs,
} from "./board-lanes";

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

export interface TaskActionInputs extends LaneInputs {
  /** Every launch in the workspace; the task's own are picked out here. */
  launches: readonly BoardLaunch[];
  /** Providers installed on this machine, in the order to prefer them. */
  availableProviders: readonly BoardProvider[];
  /** Every task in the workspace, for the dependency check. */
  tasksById: ReadonlyMap<string, TaskDto>;
}

export interface TaskActions {
  lane: BoardLane;
  /** Sessions with something to say about now: linked and not archived. */
  linked: AgentSessionDto[];
  /** What the task produced, archived sessions included. */
  output: SessionWorktreeDto[];
  /** This task's launches that no linked session represents yet. */
  launches: BoardLaunch[];
  /** A linked agent is running or starting. */
  liveAgent: boolean;
  /** A Start is in flight, so another one must wait. */
  starting: boolean;
  /** Start and its provider chooser apply. */
  startable: boolean;
  /** Hard dependencies that are not done. Start warns about them. */
  waitingOn: TaskDto[];
  /** Startable and the brief is empty, so an agent could write it. */
  canDraftBrief: boolean;
  /** The agent runs but the status still says to do. */
  canSetInProgress: boolean;
  /** The task is ready for review, so its verdict can be recorded. */
  canMarkDone: boolean;
  /** The most recently started linked agent, whatever its state. */
  lastAgent?: AgentSessionDto;
  /** The most recently started linked agent that is still alive. */
  liveSession?: AgentSessionDto;
  /** The installed provider that is not the last agent's. */
  otherProvider?: BoardProvider;
  /** A second provider can be started beside the last agent. */
  offersSecondOpinion: boolean;
  /** The linked session that has waited longest for the user. */
  answerTarget?: AgentSessionDto;
  /** The first worktree with commits ahead of its base branch. */
  reviewWorktree?: SessionWorktreeDto;
  reviewPullRequest?: NonNullable<SessionWorktreeDto["pullRequest"]>;
}

const isLive = (session: AgentSessionDto) =>
  session.status === "running" || session.status === "starting";

const byStartedDescending = (left: AgentSessionDto, right: AgentSessionDto) =>
  right.startedAt.localeCompare(left.startedAt);

export function taskActions(
  task: TaskDto,
  lane: BoardLane,
  inputs: TaskActionInputs,
): TaskActions {
  const linked = taskSessions(task, inputs.sessions);
  const output = taskWorktrees(task, inputs);
  // A launch stays visible while it is starting or failed, until a linked
  // session row exists to represent it.
  const launches = inputs.launches.filter(
    (launch) =>
      launch.taskId === task.id &&
      (launch.status === "error" ||
        !linked.some((session) => session.id === launch.sessionId)),
  );
  const agents = linked
    .filter((session) => session.kind === "agent")
    .sort(byStartedDescending);
  const liveAgent = agents.some(isLive);
  const startable = (lane === "queued" || lane === "parked") && !liveAgent;
  const starting = launches.some((launch) => launch.status === "starting");
  const waitingOn = unfinishedDependencies(task, inputs.tasksById);
  // The session that has waited longest is the one a reply box answers.
  const answerTarget =
    lane === "needs_me"
      ? linked
          .map((session) => ({
            session,
            since: sessionWaitingSince(session, inputs),
          }))
          .filter((item) => item.since)
          .sort((left, right) => left.since!.localeCompare(right.since!))[0]
          ?.session
      : undefined;
  const lastAgent = agents[0];
  const liveSession = agents.find(isLive);
  const otherProvider = lastAgent
    ? inputs.availableProviders.find(
        (provider) => provider !== lastAgent.provider,
      )
    : undefined;
  const offersSecondOpinion =
    Boolean(lastAgent) &&
    (lane === "needs_me" || lane === "running" || lane === "review");
  const reviewWorktree = output.find(
    (worktree) => (worktree.gitStatus?.ahead ?? 0) > 0,
  );
  const reviewPullRequest =
    output.find((worktree) => worktree.pullRequest)?.pullRequest ?? undefined;
  return {
    lane,
    linked,
    output,
    launches,
    liveAgent,
    starting,
    startable,
    waitingOn,
    canDraftBrief: startable && !task.description.trim(),
    canSetInProgress: lane === "running" && task.status === "todo",
    canMarkDone: lane === "review",
    lastAgent,
    liveSession,
    otherProvider,
    offersSecondOpinion,
    answerTarget,
    reviewWorktree,
    reviewPullRequest,
  };
}

/**
 * Which lane a task sits in on the board, derived and never stored.
 *
 * `Task.status` is the human's intent and only a person changes it. The lane
 * is a fold over that status and the observed state of the task's sessions and
 * worktrees, recomputed from every snapshot, so it can never lag reality by
 * more than one. This is the only place the rules live, and it is pure: the
 * board draws what this returns and decides nothing itself.
 */
import type {
  AgentActivityDto,
  AgentSessionDto,
  SessionAttentionDto,
  SessionWorktreeDto,
  TaskDto,
} from "@daedalus/protocol";

export type BoardLane =
  "needs_me" | "review" | "running" | "queued" | "parked" | "done";

/** Top to bottom. Needs me is pinned first because it is the urgent one. */
export const BOARD_LANES: readonly BoardLane[] = [
  "needs_me",
  "review",
  "running",
  "queued",
  "parked",
  "done",
];

export const LANE_LABEL: Record<BoardLane, string> = {
  needs_me: "Needs me",
  review: "Ready for review",
  running: "Running",
  queued: "Queued",
  parked: "Parked",
  done: "Done",
};

export interface LaneInputs {
  /** Every session in the workspace, archived ones included. */
  sessions: readonly AgentSessionDto[];
  activity: ReadonlyMap<string, AgentActivityDto>;
  attention: ReadonlyMap<string, SessionAttentionDto>;
  /** Every worktree in the workspace. */
  worktrees: readonly SessionWorktreeDto[];
}

const NEEDS_ME_ACTIVITIES = new Set<AgentActivityDto["activity"]>([
  "needs_permission",
  "needs_input",
  "error",
]);

const isLive = (session: AgentSessionDto) =>
  session.status === "running" || session.status === "starting";

/**
 * The sessions a card has a row for: linked to this task and not archived. An
 * archived session is filed away and has nothing left to say about now.
 */
export const taskSessions = (
  task: TaskDto,
  sessions: readonly AgentSessionDto[],
): AgentSessionDto[] =>
  sessions.filter(
    (session) => session.taskId === task.id && !session.archivedAt,
  );

/**
 * What the task produced. Archived sessions count here, because archiving a
 * session keeps its worktree and its commits are still the task's output.
 */
export const taskWorktrees = (
  task: TaskDto,
  inputs: Pick<LaneInputs, "sessions" | "worktrees">,
): SessionWorktreeDto[] => {
  const linked = new Set(
    inputs.sessions
      .filter((session) => session.taskId === task.id)
      .map((session) => session.id),
  );
  return inputs.worktrees.filter((worktree) => linked.has(worktree.sessionId));
};

/**
 * When a session started waiting on the user, or undefined when it is not.
 * An open attention reason counts whatever the session's lifecycle, because
 * the badge is explicit; an activity reading counts only while the session is
 * alive, so a stale "needs input" on a stopped session cannot pin a task here.
 */
export function sessionWaitingSince(
  session: AgentSessionDto,
  inputs: Pick<LaneInputs, "activity" | "attention">,
): string | undefined {
  const attention = inputs.attention.get(session.id);
  if (attention && attention.reasons.length > 0) return attention.raisedAt;
  const activity = inputs.activity.get(session.id);
  if (isLive(session) && activity && NEEDS_ME_ACTIVITIES.has(activity.activity))
    return activity.since;
  return undefined;
}

const sessionIsWorking = (
  session: AgentSessionDto,
  activity: ReadonlyMap<string, AgentActivityDto>,
) =>
  session.status === "starting" ||
  (isLive(session) && activity.get(session.id)?.activity === "working");

/**
 * The lane for one task. Precedence, first match wins:
 *
 * 1. Needs me: a linked session waits on the user.
 * 2. Running: a linked session is working.
 * 3. Ready for review: `in_progress`, and a linked worktree is ahead of its
 *    base branch. Nothing above matched, so nothing is working or waiting.
 * 4. The human's status: `todo` with no live agent is Queued, `blocked` is
 *    Parked, `done` and `cancelled` are Done.
 *
 * Two combinations fit none of the published rules: an `in_progress` task
 * with nothing ahead of base and nothing working, and a `todo` task whose
 * agent is alive but idle. Both go to Running, sorted after the tasks that
 * really are working. Somebody started them, and "is it still making
 * progress?" is the question Running answers; its card says "idle 2h".
 */
export function laneFor(task: TaskDto, inputs: LaneInputs): BoardLane {
  const linked = taskSessions(task, inputs.sessions);
  if (linked.some((session) => sessionWaitingSince(session, inputs)))
    return "needs_me";
  if (linked.some((session) => sessionIsWorking(session, inputs.activity)))
    return "running";
  if (
    task.status === "in_progress" &&
    taskWorktrees(task, inputs).some(
      (worktree) => (worktree.gitStatus?.ahead ?? 0) > 0,
    )
  )
    return "review";
  if (task.status === "done" || task.status === "cancelled") return "done";
  if (task.status === "blocked") return "parked";
  if (task.status === "todo") {
    const liveAgent = linked.some(
      (session) => session.kind === "agent" && isLive(session),
    );
    return liveAgent ? "running" : "queued";
  }
  return "running";
}

const latest = (values: Array<string | null | undefined>) =>
  values.reduce<string | undefined>(
    (best, value) => (value && (!best || value > best) ? value : best),
    undefined,
  );

/** How long the task has been waiting on the user, oldest reading first. */
export function taskWaitingSince(
  task: TaskDto,
  inputs: LaneInputs,
): string | undefined {
  return taskSessions(task, inputs.sessions)
    .map((session) => sessionWaitingSince(session, inputs))
    .filter((since): since is string => Boolean(since))
    .sort()[0];
}

/**
 * When the task's agents last stopped: a session that ended, or one that is
 * still alive but went idle or finished its turn.
 */
function lastStop(task: TaskDto, inputs: LaneInputs): string | undefined {
  return latest(
    inputs.sessions
      .filter((session) => session.taskId === task.id)
      .map((session) => {
        if (!isLive(session)) return session.endedAt ?? session.archivedAt;
        const activity = inputs.activity.get(session.id);
        return activity &&
          (activity.activity === "idle" || activity.activity === "done")
          ? activity.since
          : undefined;
      }),
  );
}

function lastActivity(task: TaskDto, inputs: LaneInputs): string | undefined {
  return latest(
    taskSessions(task, inputs.sessions).map(
      (session) =>
        inputs.activity.get(session.id)?.observedAt ?? session.startedAt,
    ),
  );
}

const PRIORITY_RANK: Record<TaskDto["priority"], number> = {
  high: 0,
  normal: 1,
  low: 2,
};

export interface BoardLaneGroup {
  lane: BoardLane;
  tasks: TaskDto[];
}

export interface BoardLaneOptions {
  /**
   * True when a task has a hard dependency that is not done. Such a task
   * sinks below the ready ones in Queued; it is a warning, never a lock.
   */
  isWaiting?: (task: TaskDto) => boolean;
}

const descending = (left?: string, right?: string) =>
  (right ?? "").localeCompare(left ?? "");

/**
 * Every lane in board order, each sorted by its own rule. `tasks` arrives in
 * the order the service returned it, which is creation order; that is the
 * "position" Queued falls back to.
 */
export function boardLanes(
  tasks: readonly TaskDto[],
  inputs: LaneInputs,
  options: BoardLaneOptions = {},
): BoardLaneGroup[] {
  const position = new Map(tasks.map((task, index) => [task.id, index]));
  const byLane = new Map<BoardLane, TaskDto[]>(
    BOARD_LANES.map((lane) => [lane, []]),
  );
  for (const task of tasks) byLane.get(laneFor(task, inputs))!.push(task);
  const order = (left: TaskDto, right: TaskDto) =>
    position.get(left.id)! - position.get(right.id)!;
  const working = (task: TaskDto) =>
    taskSessions(task, inputs.sessions).some((session) =>
      sessionIsWorking(session, inputs.activity),
    );
  const sorters: Record<BoardLane, (left: TaskDto, right: TaskDto) => number> =
    {
      // The longest wait first: it is the one that has cost the most.
      needs_me: (left, right) =>
        (taskWaitingSince(left, inputs) ?? "").localeCompare(
          taskWaitingSince(right, inputs) ?? "",
        ) || order(left, right),
      review: (left, right) =>
        descending(lastStop(left, inputs), lastStop(right, inputs)) ||
        order(left, right),
      running: (left, right) =>
        Number(working(right)) - Number(working(left)) ||
        descending(lastActivity(left, inputs), lastActivity(right, inputs)) ||
        order(left, right),
      queued: (left, right) =>
        Number(options.isWaiting?.(left) ?? false) -
          Number(options.isWaiting?.(right) ?? false) ||
        PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
        order(left, right),
      parked: (left, right) =>
        descending(left.updatedAt, right.updatedAt) || order(left, right),
      done: (left, right) =>
        descending(
          left.completedAt ?? left.updatedAt,
          right.completedAt ?? right.updatedAt,
        ) || order(left, right),
    };
  return BOARD_LANES.map((lane) => ({
    lane,
    tasks: [...byLane.get(lane)!].sort(sorters[lane]),
  }));
}

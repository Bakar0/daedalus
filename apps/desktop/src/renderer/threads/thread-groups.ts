import type {
  AgentActivityDto,
  AgentSessionDto,
  PullRequestRefDto,
  SessionAttentionDto,
  SessionWorktreeDto,
  TeamDto,
  WorkspaceDto,
} from "@daedalus/protocol";

/**
 * The Threads list's groups, in the order it shows them. A thread is in
 * exactly one: the first of these rules that holds, with Resolved first so a
 * finished thread never asks for anything again.
 */
export type ThreadGroup =
  "review" | "waiting" | "working" | "landing" | "idle" | "resolved";

export const THREAD_GROUPS: readonly {
  group: ThreadGroup;
  label: string;
}[] = [
  { group: "waiting", label: "Waiting on you" },
  { group: "review", label: "Ready for review" },
  { group: "working", label: "Working" },
  { group: "landing", label: "Landing" },
  { group: "idle", label: "Idle" },
  { group: "resolved", label: "Resolved" },
];

/** A thread idle this long is resolved on its own. */
export const THREAD_IDLE_RESOLVE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ThreadRow {
  session: AgentSessionDto;
  group: ThreadGroup;
  title: string;
  workspaceName: string;
  /** When its state last changed, for the row's time. */
  at: string;
  /** One line: what it is doing, or what it asks. */
  detail: string;
  pullRequest?: PullRequestRefDto;
  /** It failed, rather than asking: its dot is red. */
  failed: boolean;
}

export interface ThreadInputs {
  agents: readonly AgentSessionDto[];
  teams: readonly TeamDto[];
  workspaces: readonly WorkspaceDto[];
  activity: ReadonlyMap<string, AgentActivityDto>;
  attention: ReadonlyMap<string, SessionAttentionDto>;
  worktrees: readonly SessionWorktreeDto[];
  now: number;
}

/** The team a session leads, if any. */
export function ledTeam(
  teams: readonly TeamDto[],
  sessionId: string,
): TeamDto | undefined {
  return teams.find((team) => team.leadId === sessionId);
}

/**
 * The pull request a thread's work is in: an open one first, then the
 * newest merged one. Absent when none of its worktrees has one.
 */
function threadPullRequest(
  sessionId: string,
  worktrees: readonly SessionWorktreeDto[],
): PullRequestRefDto | undefined {
  const found = worktrees
    .filter((tree) => tree.sessionId === sessionId && tree.pullRequest)
    .map((tree) => tree.pullRequest!);
  return (
    found.find((pull) => pull.state === "OPEN") ??
    found.find((pull) => pull.state === "MERGED") ??
    found[0]
  );
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Which group a thread is in, and the line its row shows. */
export function classifyThread(
  session: AgentSessionDto,
  inputs: Pick<ThreadInputs, "activity" | "attention" | "worktrees" | "now">,
): Pick<ThreadRow, "group" | "at" | "detail" | "pullRequest" | "failed"> {
  const activity = inputs.activity.get(session.id);
  const attention = inputs.attention.get(session.id);
  const pullRequest = threadPullRequest(session.id, inputs.worktrees);
  const pr = pullRequest ? `PR #${pullRequest.number}` : "";
  const merged =
    pullRequest?.state === "MERGED" ||
    inputs.worktrees.some(
      (tree) => tree.sessionId === session.id && tree.landed,
    );
  const since = activity?.since ?? session.endedAt ?? session.startedAt;
  const base = { ...(pullRequest ? { pullRequest } : {}), failed: false };

  // Resolved: marked done, merged, put away, or quiet for a week.
  if (session.resolvedAt)
    return {
      ...base,
      group: "resolved",
      at: session.resolvedAt,
      detail: merged ? `${pr} merged` : "Marked done",
    };
  if (merged)
    return {
      ...base,
      group: "resolved",
      at: pullRequest?.mergedAt ?? since,
      detail: `${pr || "Pull request"} merged`,
    };
  if (session.archivedAt)
    return {
      ...base,
      group: "resolved",
      at: session.archivedAt,
      detail: "Archived",
    };
  const live = session.status === "running" || session.status === "starting";

  // Waiting on you: it asks, needs a permission, or failed.
  const failedToRun =
    session.status === "lost" ||
    (session.status === "exited" && (session.exitCode ?? 0) !== 0);
  if (
    attention ||
    activity?.activity === "needs_permission" ||
    activity?.activity === "needs_input" ||
    activity?.activity === "error" ||
    failedToRun
  ) {
    const errored = activity?.activity === "error";
    const asked = attention?.reasons.at(-1)?.text;
    const said = asked ?? activity?.detail ?? null;
    const detail = failedToRun
      ? session.lostReason
        ? `Stopped: ${oneLine(session.lostReason)}`
        : "Stopped unexpectedly"
      : errored
        ? said
          ? `Failed: ${oneLine(said)}`
          : "Failed"
        : said
          ? oneLine(said)
          : activity?.activity === "needs_permission"
            ? "Needs your permission"
            : "Needs your answer";
    return {
      ...base,
      group: "waiting",
      at: attention?.updatedAt ?? since,
      detail,
      failed: errored || failedToRun,
    };
  }

  if (
    live &&
    (activity?.activity === "working" || session.status === "starting")
  )
    return {
      ...base,
      group: "working",
      at: since,
      detail: activity?.detail ? oneLine(activity.detail) : "Working",
    };

  if (pullRequest?.state === "OPEN") {
    const checks =
      pullRequest.checks === "passing"
        ? " · checks passed"
        : pullRequest.checks === "failing"
          ? " · checks failing"
          : pullRequest.checks === "pending"
            ? " · checks running"
            : "";
    if (pullRequest.review === "approved")
      return {
        ...base,
        group: "landing",
        at: since,
        detail: `${pr} approved${checks}`,
      };
    if (!pullRequest.isDraft)
      return {
        ...base,
        group: "review",
        at: since,
        detail: `${pr} open${checks} · ready for your review`,
      };
  }

  if (inputs.now - Date.parse(since) >= THREAD_IDLE_RESOLVE_MS)
    return {
      ...base,
      group: "resolved",
      at: since,
      detail: "Idle for a week",
    };
  return {
    ...base,
    group: "idle",
    at: since,
    detail: !live
      ? "Stopped"
      : activity?.detail
        ? oneLine(activity.detail)
        : activity?.activity === "done"
          ? "Finished its turn"
          : "Idle",
  };
}

/** Rows grouped, newest change first within a group. */
function groupedRows(
  sessions: readonly AgentSessionDto[],
  inputs: ThreadInputs,
): ThreadRow[] {
  const names = new Map(inputs.workspaces.map((item) => [item.id, item.name]));
  const order = new Map(
    THREAD_GROUPS.map((item, index) => [item.group, index]),
  );
  return sessions
    .map((session) => ({
      session,
      title: session.name,
      workspaceName: names.get(session.workspaceId) ?? session.workspaceId,
      ...classifyThread(session, inputs),
    }))
    .sort(
      (a, b) =>
        order.get(a.group)! - order.get(b.group)! || b.at.localeCompare(a.at),
    );
}

/**
 * A lead's threads: the members of the team it leads, grouped, newest
 * change first within a group.
 */
export function threadRows(leadId: string, inputs: ThreadInputs): ThreadRow[] {
  const team = ledTeam(inputs.teams, leadId);
  if (!team) return [];
  return groupedRows(
    inputs.agents.filter((session) => session.teamId === team.id),
    inputs,
  );
}

/** How many threads wait on the user: the Threads button's dot. */
export function waitingCount(rows: readonly ThreadRow[]): number {
  return rows.filter((row) => row.group === "waiting").length;
}

/** A thread action in a session's menu. */
export type ThreadMenuItem =
  | { id: "thread-done"; label: string; resolved: boolean }
  | { id: "stop"; label: string };

/**
 * What a session's menu offers about threads: Mark done (or Reopen) and
 * Stop on a team's member.
 */
export function threadMenuItems(
  session: AgentSessionDto,
  context: { member: boolean },
): ThreadMenuItem[] {
  const thread = context.member;
  const live = session.status === "running" || session.status === "starting";
  const items: ThreadMenuItem[] = [];
  if (thread && !session.archivedAt)
    items.push({
      id: "thread-done",
      label: session.resolvedAt ? "Reopen thread" : "Mark done",
      resolved: !session.resolvedAt,
    });
  if (thread && live) items.push({ id: "stop", label: "Stop" });
  return items;
}

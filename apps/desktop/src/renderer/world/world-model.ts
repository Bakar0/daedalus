import type {
  AgentActivityDto,
  AgentSessionDto,
  SessionAttentionDto,
  SessionTelemetryDto,
  SessionWorktreeDto,
  ShippedPullRequestDto,
  TaskDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import {
  sessionIsLive,
  sessionName,
  sessionStatusView,
  type SessionTone,
} from "../session-view";

/**
 * The World view (#44) draws the snapshot as a place where agents walk
 * between stations. This file is the only part of it that reads DTOs, and it
 * knows nothing about offices: a theme turns places into scenery, so the
 * concept can be swapped without touching what an agent is doing.
 */

/** What kind of work a tool call is, as far as where to stand goes. */
export type WorldStation =
  "read" | "edit" | "run" | "ship" | "web" | "delegate" | "plan" | "think";

/** Everywhere an actor can stand. Every theme must place all of them. */
export type WorldPlace = WorldStation | "lounge" | "door";

export const WORLD_PLACES: readonly WorldPlace[] = [
  "read",
  "edit",
  "run",
  "ship",
  "web",
  "delegate",
  "plan",
  "think",
  "lounge",
  "door",
];

export interface WorldActor {
  sessionId: string;
  zoneId: string;
  name: string;
  provider: AgentSessionDto["provider"];
  /** "#44 All workspace 2d game world", when the session has a task. */
  taskLabel: string | null;
  /** The board's tone, so the World and the board never disagree. */
  mood: SessionTone;
  /** Short state word: "working", "needs permission", "idle". */
  label: string;
  place: WorldPlace;
  /** The tool line, or the question when the session is waiting on you. */
  detail: string | null;
  since: string | null;
  unconfirmed: boolean;
  contextPercent: number | null;
  model: string | null;
}

export interface WorldZone {
  id: string;
  name: string;
  /** Actors in this zone waiting on the user. */
  attention: number;
  /** Live actors in this zone, lost ones not counted: how busy it looks. */
  busy: number;
  /** One crate per branch with work on it, in the order they were started. */
  crates: WorldCrate[];
  /** The newest wins, oldest first, as many as a shelf holds. */
  trophies: WorldTrophy[];
  /** Every win this workspace has, for how grand its room is. */
  wins: number;
}

/**
 * Something the workspace finished, kept on its room's shelf: a task marked
 * done, gilded when it also merged a pull request, or a merged pull request
 * no done task accounts for. A task and its pull request are one win, so
 * splitting work into more pieces does not fill the shelf faster.
 */
export interface WorldTrophy {
  id: string;
  kind: "task" | "shipped-task" | "pull-request";
  /** "#44 All workspace 2d game world" or "PR #512 Ship the World". */
  label: string;
  /** "PR #512 merged", when a task shipped one. */
  detail: string | null;
  at: string;
}

/** How many trophies a shelf shows. */
export const SHELF_SIZE = 18;

/**
 * How grand a room is, from its wins: bare stone, then frescoes at 10,
 * then marble and bronze at 25. It only ever goes up.
 */
export function roomTier(wins: number): 0 | 1 | 2 {
  return wins >= 25 ? 2 : wins >= 10 ? 1 : 0;
}

/**
 * Where one branch's work is on its way out. A crate is packed while its
 * commits are only local, waits at the post once they are pushed or a pull
 * request is open, and flies off when the pull request merges. It stands
 * for a result, so it moves on git and pull request state, never on how
 * many commands an agent ran.
 */
export type WorldCrateStage =
  "packing" | "pushed" | "draft" | "open" | "merged";

export interface WorldCrate {
  /** The worktree's path: one crate per branch, for as long as it exists. */
  id: string;
  stage: WorldCrateStage;
  /** "#512" when there is a pull request, else the branch name. */
  label: string;
  url: string | null;
}

export interface WorldModel {
  zones: WorldZone[];
  actors: WorldActor[];
  /** What each workspace finished in the last seven days, busiest first. */
  week: WorldWeek[];
}

/**
 * One workspace's week, for the scroll at the Hermes Post. It lists what
 * was finished and counts nothing else: no streak, no day counter, so a
 * week off costs nothing.
 */
export interface WorldWeek {
  zoneId: string;
  name: string;
  /** Newest first. */
  trophies: WorldTrophy[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const TOOL_STATIONS: ReadonlyArray<[RegExp, WorldStation]> = [
  [
    /^(Read|Grep|Glob|LS|NotebookRead|view|read_file|list_dir|grep|find)$/,
    "read",
  ],
  [
    /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch|write_file|edit_file)$/,
    "edit",
  ],
  [/^(WebFetch|WebSearch|web_search|web_fetch)$/, "web"],
  [/^(Task|Agent|spawn_agent)$/, "delegate"],
  [/^(TodoWrite|update_plan|ExitPlanMode|EnterPlanMode)$/, "plan"],
  [
    /^(Bash|BashOutput|KillShell|KillBash|shell|exec_command|local_shell|unified_exec|write_stdin)$/,
    "run",
  ],
];

/** A command that moves work out of the building: commits, pushes, PRs. */
const SHIPPING = /^(git\s+(commit|push|tag|merge)|gh\s+(pr|release))\b/;

/**
 * Free-text details some observers write instead of a tool summary.
 * "Reading the config" is the transcript's; the rest are the same shape.
 */
const PHRASE_STATIONS: ReadonlyArray<[RegExp, WorldStation]> = [
  [/^(read|search|look|explor|inspect|scan)/i, "read"],
  [/^(edit|writ|updat|patch|refactor)/i, "edit"],
  [/^(run|test|build|install)/i, "run"],
  [/^(fetch|brows)/i, "web"],
  [/^(plan)/i, "plan"],
];

/**
 * Where a working agent stands, from the `detail` line. The line is ours:
 * `summarizeTool` writes "Name(argument)" or a bare name, so the tool is the
 * part before the parenthesis. Anything unrecognised is thinking at a desk,
 * which is also what an agent between tool calls is doing.
 */
export function stationForDetail(
  detail: string | null | undefined,
): WorldStation {
  const line = detail?.trim();
  if (!line) return "think";
  const call = /^([A-Za-z_][\w.:-]*)(?:\((.*)\))?$/s.exec(line);
  if (call) {
    const tool = call[1]!;
    const argument = call[2]?.trim() ?? "";
    if (tool.startsWith("mcp__")) return "web";
    for (const [pattern, station] of TOOL_STATIONS) {
      if (!pattern.test(tool)) continue;
      return station === "run" && SHIPPING.test(argument) ? "ship" : station;
    }
    return "think";
  }
  for (const [pattern, station] of PHRASE_STATIONS)
    if (pattern.test(line)) return station;
  return "think";
}

function placeFor(mood: SessionTone, activity?: AgentActivityDto): WorldPlace {
  switch (mood) {
    case "working":
    case "error":
      return stationForDetail(activity?.detail);
    case "attention":
      // Waiting at the station it asked from: a permission prompt carries the
      // tool it wants, so the agent stands at the terminal holding it up.
      return activity ? stationForDetail(activity.detail) : "think";
    case "lost":
      return "door";
    default:
      return "lounge";
  }
}

export interface WorldModelInput {
  workspaces: readonly WorkspaceDto[];
  sessions: readonly AgentSessionDto[];
  tasks: readonly TaskDto[];
  activity: ReadonlyMap<string, AgentActivityDto>;
  attention: ReadonlyMap<string, SessionAttentionDto>;
  telemetry: ReadonlyMap<string, SessionTelemetryDto>;
  worktrees: readonly SessionWorktreeDto[];
  shipped: readonly ShippedPullRequestDto[];
  /** Milliseconds since the epoch, for what "this week" means. */
  now: number;
}

/** Every workspace's wins, oldest first. */
export function trophiesByZone(
  tasks: readonly TaskDto[],
  shipped: readonly ShippedPullRequestDto[],
): Map<string, WorldTrophy[]> {
  const done = new Map(
    tasks
      .filter((task) => task.status === "done" && task.completedAt)
      .map((task) => [task.id, task]),
  );
  const pulls = new Map<string, ShippedPullRequestDto[]>();
  const trophies: Array<WorldTrophy & { zoneId: string }> = [];
  for (const pull of shipped) {
    if (pull.taskId && done.has(pull.taskId)) {
      pulls.set(pull.taskId, [...(pulls.get(pull.taskId) ?? []), pull]);
      continue;
    }
    trophies.push({
      zoneId: pull.workspaceId,
      id: pull.url,
      kind: "pull-request",
      label: `PR #${pull.number}${pull.title ? ` ${pull.title}` : ""}`,
      detail: null,
      at: pull.mergedAt,
    });
  }
  for (const task of done.values()) {
    const merged = pulls.get(task.id) ?? [];
    trophies.push({
      zoneId: task.workspaceId,
      id: task.id,
      kind: merged.length ? "shipped-task" : "task",
      label: `#${task.number} ${task.title}`,
      detail: merged.length
        ? `${merged.map((pull) => `PR #${pull.number}`).join(", ")} merged`
        : null,
      at: task.completedAt!,
    });
  }
  trophies.sort((left, right) => left.at.localeCompare(right.at));
  const byZone = new Map<string, WorldTrophy[]>();
  for (const { zoneId, ...trophy } of trophies)
    byZone.set(zoneId, [...(byZone.get(zoneId) ?? []), trophy]);
  return byZone;
}

/**
 * A worktree's crate, or none when there is nothing on its way out: no
 * commits ahead of base and no pull request, or a pull request closed
 * without merging.
 */
export function crateFor(worktree: SessionWorktreeDto): WorldCrate | null {
  const pull = worktree.pullRequest;
  const base = {
    id: worktree.path,
    label: pull ? `#${pull.number}` : worktree.branchName,
    url: pull?.url ?? null,
  };
  if (worktree.landed || pull?.state === "MERGED")
    return { ...base, stage: "merged" };
  if (pull?.state === "OPEN")
    return { ...base, stage: pull.isDraft ? "draft" : "open" };
  if (pull) return null;
  const status = worktree.gitStatus;
  if (!status || status.ahead === 0) return null;
  return { ...base, stage: (status.unpushed ?? 0) > 0 ? "packing" : "pushed" };
}

/**
 * Agents only, and only ones still in the building: a live session, or a lost
 * one standing at the door until someone revives or archives it. Exited and
 * archived sessions leave; the board and the Sessions list keep their history.
 */
export function buildWorldModel(input: WorldModelInput): WorldModel {
  const zoneIds = new Set(input.workspaces.map((item) => item.id));
  const tasks = new Map(input.tasks.map((item) => [item.id, item]));
  const actors: WorldActor[] = [];
  // Every session's workspace, the ended ones too: a branch outlives the
  // agent that pushed it.
  const sessionZones = new Map(
    input.sessions.map((item) => [item.id, item.workspaceId]),
  );
  const crates = new Map<string, WorldCrate[]>();
  for (const worktree of [...input.worktrees].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    const zoneId = sessionZones.get(worktree.sessionId);
    const crate = crateFor(worktree);
    if (!zoneId || !crate) continue;
    crates.set(zoneId, [...(crates.get(zoneId) ?? []), crate]);
  }
  for (const session of input.sessions) {
    if (session.kind !== "agent" || session.archivedAt) continue;
    if (!zoneIds.has(session.workspaceId)) continue;
    if (!sessionIsLive(session) && session.status !== "lost") continue;
    const activity = input.activity.get(session.id);
    const view = sessionStatusView(
      session,
      activity,
      input.attention.get(session.id),
    );
    const task = session.taskId ? tasks.get(session.taskId) : undefined;
    const telemetry = input.telemetry.get(session.id);
    actors.push({
      sessionId: session.id,
      zoneId: session.workspaceId,
      name: sessionName(session),
      provider: session.provider,
      taskLabel: task ? `#${task.number} ${task.title}` : null,
      mood: view.tone,
      label: view.label,
      place: placeFor(view.tone, activity),
      detail: view.detail,
      since: view.since,
      unconfirmed: view.unconfirmed,
      contextPercent: telemetry?.context?.usedPercent ?? null,
      model: telemetry?.model ?? null,
    });
  }
  const wins = trophiesByZone(input.tasks, input.shipped);
  return {
    zones: input.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      attention: actors.filter(
        (actor) => actor.zoneId === workspace.id && actor.mood === "attention",
      ).length,
      busy: actors.filter(
        (actor) => actor.zoneId === workspace.id && actor.mood !== "lost",
      ).length,
      crates: crates.get(workspace.id) ?? [],
      trophies: (wins.get(workspace.id) ?? []).slice(-SHELF_SIZE),
      wins: wins.get(workspace.id)?.length ?? 0,
    })),
    actors,
    week: input.workspaces
      .map((workspace) => ({
        zoneId: workspace.id,
        name: workspace.name,
        trophies: (wins.get(workspace.id) ?? [])
          .filter((trophy) => input.now - Date.parse(trophy.at) <= WEEK_MS)
          .reverse(),
      }))
      .filter((item) => item.trophies.length > 0)
      .sort((left, right) => right.trophies.length - left.trophies.length),
  };
}

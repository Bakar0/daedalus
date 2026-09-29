import type {
  AgentActivityDto,
  AgentSessionDto,
  SessionAttentionDto,
  SessionTelemetryDto,
  SessionWorktreeDto,
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
}

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
    })),
    actors,
  };
}

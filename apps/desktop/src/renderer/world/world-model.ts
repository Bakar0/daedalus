import type {
  AgentActivityDto,
  AgentSessionDto,
  SessionAttentionDto,
  SessionTelemetryDto,
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
    })),
    actors,
  };
}

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import agentTemplate from "../../../../routine-agents/AGENT.md" with { type: "text" };
import routineAgentSkillTemplate from "../../../../routine-agents/skills/daedalus-routine-agent/SKILL.md" with { type: "text" };
import routineSkillTemplate from "../../../../routine-agents/skills/daedalus-routine/SKILL.md" with { type: "text" };
import type {
  AgentActivityState,
  AgentSession,
  RoutineAgent,
  RoutineRun,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { claudeProjectKey, type AgentService } from "./agents";
import { routineAgentPrompt } from "./providers";
import {
  routineAgentFolder,
  ROUTINES_DIRECTORY,
  TEMPLATES_DIRECTORY,
} from "./routine-files";
import type { RoutineReportService } from "./routine-reports";
import type { RoutineService } from "./routines";
import type { WorkspaceService } from "./workspaces";

/** At most this many runs are typed and unfinished at once. */
export const MAX_RUNS_IN_FLIGHT = 3;
/** Delivery holds while the user has typed into the agent this recently. */
export const USER_TYPING_HOLD_MS = 60_000;
/** A drain waits this long for runs in flight before handing off anyway. */
export const DRAIN_LIMIT_MS = 10 * 60_000;
/** A handoff the agent never completed is finished by Daedalus after this. */
const HANDOFF_LIMIT_MS = 15 * 60_000;
/** Between two lines typed into the pane, at least this long. */
const DELIVERY_GAP_MS = 15_000;
/**
 * A line typed with no activity reading since is presumed lost after this,
 * so a session whose hooks do not report still gets its routines.
 */
const UNACKNOWLEDGED_DELIVERY_MS = 2 * 60_000;
/** A dead routine agent session is relaunched at most this often. */
const REVIVE_BACKOFF_MS = 5 * 60_000;

/** The skills a routine agent's session sees, written into its folder. */
const ROUTINE_AGENT_SKILLS = [
  { name: "daedalus-routine-agent", contents: routineAgentSkillTemplate },
  { name: "daedalus-routine", contents: routineSkillTemplate },
];

/** The folder name for an agent's name: lowercase, digits and dashes. */
export function routineAgentSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (!slug)
    throw new DaedalusError(
      "VALIDATION",
      "A routine agent's name needs at least one letter or digit",
    );
  return slug;
}

async function createIfMissing(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function writeIfChanged(path: string, contents: string): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === contents) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

/** The text of Claude's `idle_prompt` notification. */
const CLAUDE_IDLE_NOTICE = "Claude is waiting for your input";

/**
 * The text in the session's input box, if the pane shows one: the last
 * prompt line under Claude's composer rule. `undefined` when no prompt line
 * is found, which says nothing either way.
 */
export function composerText(screen: string): string | undefined {
  const lines = screen.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*[❯>]\s?(.*)$/.exec(lines[index]!);
    if (match && /^\s*─{8,}/.test(lines[index - 1] ?? ""))
      return match[1]!.replace(/ /g, " ").trim();
  }
  return undefined;
}

/**
 * The pane's own answer to "is it at its prompt": an input box is showing
 * and no turn is running (Claude shows "esc to interrupt" while it works).
 */
export function paneAtPrompt(screen: string): boolean {
  return (
    composerText(screen) !== undefined && !/esc to interrupt/i.test(screen)
  );
}

/**
 * Whether the session is at its prompt, where a typed line starts a turn
 * rather than landing in the middle of one. A Claude session that ended its
 * turn with background agents still running reports `working`, and that is
 * exactly the state routines are delivered in: the typed line starts a turn
 * alongside them. A badge the agent raised on itself is not a prompt to
 * answer, so it does not hold delivery; a real question or permission
 * dialog does, because a typed line would answer it.
 */
export function routineAgentAtPrompt(
  activity: AgentActivityState | undefined,
): boolean {
  if (!activity) return false;
  switch (activity.activity) {
    case "idle":
    case "done":
      return true;
    case "working":
      return /^Waiting for \d+ background agents?$/.test(activity.detail ?? "");
    case "needs_input":
      // A badge the agent raised on itself, or Claude's idle notice from a
      // session started before routine agents dropped it: neither is a
      // prompt.
      return (
        activity.source === "agent" || activity.detail === CLAUDE_IDLE_NOTICE
      );
    default:
      return false;
  }
}

export interface RoutineAgentOverview {
  agent: RoutineAgent;
  workspaceSlug: string;
  folder: string;
  /** The session's lifecycle, or null when it has none. */
  sessionStatus: AgentSession["status"] | null;
  sessionArchived: boolean;
  nextRunAt: string | null;
  runsInFlight: number;
  runsQueued: number;
  openReports: number;
  openUrgentReports: number;
  openReportTasks: number;
  routines: number;
  routineErrors: number;
  /**
   * Why queued runs are not being typed in, when they are not: said out
   * loud, because a queue that silently stops looks like a broken feature.
   */
  deliveryHold: string | null;
}

export interface RoutineAgentMemoryFile {
  /** Where it is shown from: the agent's folder, or the provider's memory. */
  source: "folder" | "memory";
  name: string;
  path: string;
  content: string;
  truncated: boolean;
}

const MEMORY_FILE_LIMIT = 64 * 1024;

export interface RoutineAgentTickInput {
  /** Context use per session, from telemetry. */
  contextPercent: (sessionId: string) => number | undefined;
  /** When the user last typed into a session's terminal, in ms. */
  lastInputAt: (sessionId: string) => number | undefined;
  activity: (sessionId: string) => AgentActivityState | undefined;
}

export interface RoutineAgentTickResult {
  queued: RoutineRun[];
  delivered: RoutineRun[];
  events: string[];
}

/**
 * Routine agents: named Claude sessions in an ordinary workspace that run
 * routines on a clock Daedalus keeps. The user creates one with a name and
 * gives it its purpose by asking it for routines.
 */
export class RoutineAgentService {
  private readonly lastRevive = new Map<string, number>();
  /** The last tick's reason for holding delivery, per agent. */
  private readonly holds = new Map<string, string | null>();

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly agents: AgentService,
    private readonly routines: RoutineService,
    private readonly reports: RoutineReportService,
    private readonly paths: {
      /** The `daedal` this home's sessions run, written into the skills. */
      daedal: string;
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(workspaceId?: string): RoutineAgent[] {
    return this.repositories.routineAgents.listRoutineAgents(workspaceId);
  }

  /**
   * An agent by id, or by name or slug. A name used in two workspaces needs
   * the workspace to tell them apart.
   */
  get(reference: string, workspaceId?: string): RoutineAgent {
    const store = this.repositories.routineAgents;
    const byId = store.findRoutineAgent(reference);
    if (byId) return byId;
    const matches = store.findRoutineAgentsByName(reference, workspaceId);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      throw new DaedalusError(
        "VALIDATION",
        `More than one routine agent is called '${reference}'; pass --workspace`,
      );
    throw new DaedalusError(
      "NOT_FOUND",
      `Routine agent '${reference}' was not found`,
    );
  }

  /**
   * The agent a command is about: the one named, else the one whose session
   * is running the command, else the only one there is.
   */
  resolve(
    reference?: string,
    sessionId?: string,
    workspaceId?: string,
  ): RoutineAgent {
    if (reference) return this.get(reference, workspaceId);
    if (sessionId) {
      const own =
        this.repositories.routineAgents.findRoutineAgentBySession(sessionId);
      if (own) return own;
    }
    const all = this.list(workspaceId);
    if (all.length === 1) return all[0]!;
    throw new DaedalusError(
      "VALIDATION",
      all.length === 0
        ? "No routine agent exists; create one with 'daedal agent spawn --workspace <w> --routine-agent --name <name>'"
        : "More than one routine agent exists; pass --agent <name>",
    );
  }

  async folder(agent: RoutineAgent): Promise<string> {
    const workspace = await this.workspaces.get(agent.workspaceId);
    return routineAgentFolder(workspace.path, agent.slug);
  }

  /** What a surface needs to show each agent at a glance. */
  async overviews(): Promise<RoutineAgentOverview[]> {
    const overviews: RoutineAgentOverview[] = [];
    for (const agent of this.list()) {
      const workspace = this.repositories.findWorkspace(agent.workspaceId);
      if (!workspace) continue;
      const session = agent.sessionId
        ? this.repositories.findAgent(agent.sessionId)
        : undefined;
      const inFlight = this.routines.inFlightRuns(agent);
      const open = this.repositories.routineAgents.listRoutineReports(
        agent.id,
        { states: ["open"] },
      );
      const { routines, errors } = await this.routines.read(agent);
      const enabled = new Set(
        routines.filter((routine) => routine.enabled).map((item) => item.name),
      );
      const next = this.repositories.routineAgents
        .listRoutineStates(agent.id)
        .filter((state) => enabled.has(state.name) && state.nextRunAt)
        .map((state) => state.nextRunAt!)
        .sort()[0];
      const running = inFlight.filter((run) => run.deliveredAt).length;
      overviews.push({
        agent,
        workspaceSlug: workspace.slug,
        folder: routineAgentFolder(workspace.path, agent.slug),
        sessionStatus: session?.status ?? null,
        sessionArchived: Boolean(session?.archivedAt),
        nextRunAt: agent.state === "on_duty" ? (next ?? null) : null,
        runsInFlight: running,
        runsQueued: inFlight.length - running,
        openReports: open.length,
        openUrgentReports: open.filter((report) => report.urgent).length,
        openReportTasks: new Set(
          open.flatMap((report) => (report.taskId ? [report.taskId] : [])),
        ).size,
        routines: routines.length,
        routineErrors: errors.length,
        deliveryHold:
          inFlight.length - running > 0
            ? (this.holds.get(agent.id) ?? null)
            : null,
      });
    }
    return overviews;
  }

  /**
   * The agent's AGENT.md and its provider memory, read-only. Only the agent
   * writes its memory; a surface shows it.
   */
  async memory(
    reference: string,
    claudeProjectsDirectory: string,
  ): Promise<RoutineAgentMemoryFile[]> {
    const agent = this.get(reference);
    const folder = await this.folder(agent);
    const read = async (
      source: RoutineAgentMemoryFile["source"],
      path: string,
    ): Promise<RoutineAgentMemoryFile | undefined> => {
      const text = await readFile(path, "utf8").catch(() => undefined);
      if (text === undefined) return undefined;
      return {
        source,
        name: basename(path),
        path,
        content: text.slice(0, MEMORY_FILE_LIMIT),
        truncated: text.length > MEMORY_FILE_LIMIT,
      };
    };
    const files: RoutineAgentMemoryFile[] = [];
    const agentFile = await read("folder", join(folder, "AGENT.md"));
    if (agentFile) files.push(agentFile);
    const memoryDirectory = join(
      claudeProjectsDirectory,
      claudeProjectKey(folder),
      "memory",
    );
    const entries = await readdir(memoryDirectory).catch(() => []);
    // The index first, then the memories it points at.
    const ordered = entries
      .filter((name) => name.endsWith(".md"))
      .sort((left, right) =>
        left === "MEMORY.md"
          ? -1
          : right === "MEMORY.md"
            ? 1
            : left.localeCompare(right),
      );
    for (const name of ordered) {
      const file = await read("memory", join(memoryDirectory, name));
      if (file) files.push(file);
    }
    return files;
  }

  /**
   * Creates a routine agent in a workspace and starts its session in
   * `worktrees/agents/<slug>`. It has no routines yet; the user gives it
   * those by talking to it.
   */
  async create(input: {
    workspace: string;
    name: string;
    model?: string;
  }): Promise<RoutineAgent> {
    const workspace = await this.workspaces.getActive(input.workspace);
    const name = input.name.trim();
    const slug = routineAgentSlug(name);
    if (
      this.list(workspace.id).some(
        (agent) =>
          agent.slug === slug ||
          agent.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new DaedalusError(
        "CONFLICT",
        `${workspace.name} already has a routine agent called '${name}'`,
      );
    const draft: RoutineAgent = {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      slug,
      name,
      model: input.model?.trim() || null,
      autoHandoffPercent: 60,
      state: "on_duty",
      sessionId: null,
      drainingSince: null,
      createdAt: this.now().toISOString(),
    };
    const session = await this.spawnSession(draft);
    const agent: RoutineAgent = { ...draft, sessionId: session.id };
    this.repositories.routineAgents.createRoutineAgent(agent);
    return agent;
  }

  /**
   * Writes the agent's own files. What the agent or the user edits is
   * created once; the skills are Daedalus's and are refreshed every start,
   * so an upgrade reaches an agent that has been running for weeks.
   */
  private async installFiles(
    folder: string,
    agent: RoutineAgent,
  ): Promise<void> {
    await createIfMissing(
      join(folder, "AGENT.md"),
      agentTemplate.replaceAll("{{name}}", agent.name),
    );
    await mkdir(join(folder, ROUTINES_DIRECTORY, TEMPLATES_DIRECTORY), {
      recursive: true,
    });
    for (const skill of ROUTINE_AGENT_SKILLS)
      await writeIfChanged(
        join(folder, ".claude", "skills", skill.name, "SKILL.md"),
        skill.contents.replaceAll("{{daedal}}", this.paths.daedal),
      );
    // A starting point the agent adds to and owns after. Its own commands
    // are allowed so a routine never waits on a prompt, and it cannot open a
    // question dialog, because in auto mode nobody is there to answer it.
    await createIfMissing(
      join(folder, ".claude", "settings.json"),
      `${JSON.stringify(
        {
          permissions: {
            allow: ["routine", "routine-agent", "attention", "notify"].flatMap(
              (command) => [
                `Bash(${this.paths.daedal} ${command}:*)`,
                `Bash(daedal ${command}:*)`,
              ],
            ),
            deny: ["AskUserQuestion"],
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  private async spawnSession(agent: RoutineAgent): Promise<AgentSession> {
    const workspace = await this.workspaces.getActive(agent.workspaceId);
    const folder = routineAgentFolder(workspace.path, agent.slug);
    await this.installFiles(folder, agent);
    return this.agents.spawn({
      workspace: workspace.id,
      name: agent.name,
      provider: "claude",
      ...(agent.model ? { model: agent.model } : {}),
      message: routineAgentPrompt(agent.name),
      routineAgentFolder: folder,
    });
  }

  private liveSession(agent: RoutineAgent): AgentSession | undefined {
    if (!agent.sessionId) return undefined;
    const session = this.repositories.findAgent(agent.sessionId);
    return session && !session.archivedAt ? session : undefined;
  }

  /** Starts a new session for the agent, in its folder. */
  private async launch(agent: RoutineAgent): Promise<RoutineAgent> {
    const session = await this.spawnSession(agent);
    const launched: RoutineAgent = {
      ...agent,
      sessionId: session.id,
      drainingSince: null,
    };
    this.repositories.routineAgents.updateRoutineAgent(launched);
    return launched;
  }

  pause(reference: string): RoutineAgent {
    const agent = this.get(reference);
    this.routines.skipUndelivered(agent, "Skipped: the agent was paused");
    const paused: RoutineAgent = {
      ...agent,
      state: "paused",
      drainingSince: null,
    };
    this.repositories.routineAgents.updateRoutineAgent(paused);
    return paused;
  }

  /**
   * Back on duty. An archived session is restored, which resumes the agent
   * by itself; a session that is gone is replaced on the next tick.
   */
  async resume(reference: string): Promise<RoutineAgent> {
    const agent = this.get(reference);
    const session = agent.sessionId
      ? this.repositories.findAgent(agent.sessionId)
      : undefined;
    if (session?.archivedAt) {
      await this.agents.restore(session.id);
      return this.get(agent.id);
    }
    const onDuty: RoutineAgent = { ...agent, state: "on_duty" };
    this.repositories.routineAgents.updateRoutineAgent(onDuty);
    return onDuty;
  }

  /**
   * Forgets the agent: its session is archived and its routine state, runs
   * and reports go. Its folder, with the routine files and AGENT.md, and the
   * tasks it made stay where they are.
   */
  async remove(
    reference: string,
    options: { force?: boolean },
  ): Promise<RoutineAgent> {
    if (!options.force)
      throw new DaedalusError(
        "VALIDATION",
        "Removing a routine agent requires --force",
      );
    const agent = this.get(reference);
    const session = this.liveSession(agent);
    if (session) await this.agents.archive(session.id, true);
    this.repositories.routineAgents.deleteRoutineAgent(agent.id);
    return agent;
  }

  update(
    reference: string,
    changes: {
      name?: string;
      model?: string | null;
      autoHandoffPercent?: number;
    },
  ): RoutineAgent {
    const agent = this.get(reference);
    if (
      changes.autoHandoffPercent !== undefined &&
      (!Number.isInteger(changes.autoHandoffPercent) ||
        changes.autoHandoffPercent < 10 ||
        changes.autoHandoffPercent > 100)
    )
      throw new DaedalusError(
        "VALIDATION",
        "The handoff percent is a whole number from 10 to 100",
      );
    // The slug names the folder, which never moves; only the name changes.
    const updated: RoutineAgent = {
      ...agent,
      name: changes.name?.trim() || agent.name,
      model:
        changes.model === undefined
          ? agent.model
          : changes.model?.trim() || null,
      autoHandoffPercent:
        changes.autoHandoffPercent ?? agent.autoHandoffPercent,
    };
    this.repositories.routineAgents.updateRoutineAgent(updated);
    return updated;
  }

  /**
   * One pass of the clock for every routine agent. The desktop host calls
   * this on its 1.2 s tick; nothing fires while the app is closed. Each agent
   * is handled on its own, so one that fails does not hold up another.
   */
  async tick(input: RoutineAgentTickInput): Promise<RoutineAgentTickResult> {
    const result: RoutineAgentTickResult = {
      queued: [],
      delivered: [],
      events: [],
    };
    for (const agent of this.list()) {
      try {
        await this.tickAgent(agent, input, result);
      } catch (error) {
        result.events.push(
          `${agent.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }

  private async tickAgent(
    initial: RoutineAgent,
    input: RoutineAgentTickInput,
    result: RoutineAgentTickResult,
  ): Promise<void> {
    let agent = initial;
    const now = this.now();
    this.reports.sweep(agent);
    result.queued.push(
      ...(await this.routines.schedule(agent, {
        queue: agent.state !== "paused",
      })),
    );
    if (agent.state === "paused") return this.hold(agent, null);
    const session = this.liveSession(agent);
    if (!session || session.status === "exited" || session.status === "lost") {
      const last = this.lastRevive.get(agent.id) ?? 0;
      if (now.getTime() - last < REVIVE_BACKOFF_MS) return;
      this.lastRevive.set(agent.id, now.getTime());
      if (session?.status === "lost") {
        await this.agents.reviveLost(session.id);
        result.events.push(`${agent.name}: revived its lost session`);
      } else {
        agent = await this.launch(agent);
        result.events.push(`${agent.name}: started a new session`);
      }
      return;
    }
    if (session.status !== "running") return;
    const delivered = this.routines.deliveredRuns(agent);

    if (agent.state === "on_duty") {
      const percent = input.contextPercent(session.id);
      if (percent !== undefined && percent >= agent.autoHandoffPercent) {
        agent = {
          ...agent,
          state: "draining",
          drainingSince: now.toISOString(),
        };
        this.repositories.routineAgents.updateRoutineAgent(agent);
        result.events.push(`${agent.name}: draining for a full context`);
      }
    }

    if (agent.state === "draining") {
      const drainingFor =
        now.getTime() - Date.parse(agent.drainingSince ?? now.toISOString());
      if (!session.handoffRequestedAt) {
        if (delivered.length === 0 || drainingFor >= DRAIN_LIMIT_MS) {
          await this.agents.requestHandoff(session.id);
          result.events.push(`${agent.name}: asked for a handoff`);
        }
      } else if (
        now.getTime() - Date.parse(session.handoffRequestedAt) >=
        HANDOFF_LIMIT_MS
      ) {
        // The agent never ran the handoff. Its state is all outside the
        // conversation, so a successor without a note loses little.
        const { session: successor } = await this.agents.continueSession({
          id: session.id,
        });
        result.events.push(
          `${agent.name}: handed off without a note to ${successor.id}`,
        );
      }
      return;
    }

    if (session.handoffRequestedAt)
      return this.hold(agent, `${agent.name} is handing off`);
    if (delivered.length >= MAX_RUNS_IN_FLIGHT)
      return this.hold(agent, `${MAX_RUNS_IN_FLIGHT} runs already in flight`);
    const typedAt = input.lastInputAt(session.id);
    if (typedAt !== undefined && now.getTime() - typedAt < USER_TYPING_HOLD_MS)
      return this.hold(agent, "you typed in its terminal in the last minute");
    const busy = new Set(delivered.map((run) => run.routine));
    const next = this.routines
      .inFlightRuns(agent)
      .filter((run) => !run.deliveredAt && !busy.has(run.routine))
      .sort((left, right) => left.id - right.id)[0];
    if (!next) return this.hold(agent, null);
    const screen = await this.agents.screen(session.id).catch(() => "");
    // Text left in the input box would be sent along with the routine line,
    // so a draft holds delivery until it is sent or cleared.
    const draft = composerText(screen);
    if (draft)
      return this.hold(
        agent,
        `unsent text in ${agent.name}'s input box: "${draft.slice(0, 40)}${draft.length > 40 ? "…" : ""}"`,
      );
    const activity = input.activity(session.id);
    // A reading that decayed to unknown says nothing; the pane does. An
    // empty input box with no turn running is a prompt.
    const unknown = !activity || activity.activity === "unknown";
    if (!routineAgentAtPrompt(activity) && !(unknown && paneAtPrompt(screen)))
      return this.hold(
        agent,
        activity?.activity === "needs_permission"
          ? `${agent.name} is waiting on a permission prompt`
          : activity?.activity === "needs_input"
            ? `${agent.name} is waiting for an answer in its terminal`
            : `${agent.name} is busy`,
      );
    const lastDelivery = Math.max(
      0,
      ...this.routines
        .runs(agent, { limit: 20 })
        .map((run) => (run.deliveredAt ? Date.parse(run.deliveredAt) : 0)),
    );
    if (now.getTime() - lastDelivery < DELIVERY_GAP_MS)
      return this.hold(agent, null);
    // The last line has not been seen yet: the pane may still be taking it.
    if (
      lastDelivery &&
      (!activity || Date.parse(activity.observedAt) <= lastDelivery) &&
      now.getTime() - lastDelivery < UNACKNOWLEDGED_DELIVERY_MS
    )
      return this.hold(agent, null);
    this.hold(agent, null);
    await this.agents.send(session.id, `/daedalus-routine ${next.id}`);
    result.delivered.push(this.routines.markDelivered(next, session.id));
  }

  private hold(agent: RoutineAgent, reason: string | null): void {
    this.holds.set(
      agent.id,
      agent.state === "paused" ? `${agent.name} is paused` : reason,
    );
  }
}

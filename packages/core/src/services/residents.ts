import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import residentBriefTemplate from "../../../../residents/workspace/BRIEF.md" with { type: "text" };
import residentCharterTemplate from "../../../../residents/workspace/CHARTER.md" with { type: "text" };
import residentServicesTemplate from "../../../../residents/workspace/SERVICES.md" with { type: "text" };
import residentToolsTemplate from "../../../../residents/workspace/TOOLS.md" with { type: "text" };
import residentSkillTemplate from "../../../../residents/skills/daedalus-resident/SKILL.md" with { type: "text" };
import routineSkillTemplate from "../../../../residents/skills/daedalus-routine/SKILL.md" with { type: "text" };
import type {
  AgentActivityState,
  AgentSession,
  Resident,
  RoutineRun,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { claudeProjectKey, type AgentService } from "./agents";
import type { FindingService } from "./findings";
import { residentPrompt } from "./providers";
import { ROUTINES_DIRECTORY, TEMPLATES_DIRECTORY } from "./routine-files";
import type { RoutineService } from "./routines";
import type { WorkspaceService } from "./workspaces";

/** At most this many runs are typed and unfinished at once. */
export const MAX_RUNS_IN_FLIGHT = 3;
/** Delivery holds while the user has typed into the resident this recently. */
export const USER_TYPING_HOLD_MS = 60_000;
/** A drain waits this long for runs in flight before handing off anyway. */
export const DRAIN_LIMIT_MS = 10 * 60_000;
/** A handoff the resident never completed is finished by Daedalus after this. */
const HANDOFF_LIMIT_MS = 15 * 60_000;
/** The hour a resident starts each day with a fresh context. */
export const FRESH_CONTEXT_HOUR = 4;
/** Between two lines typed into the pane, at least this long. */
const DELIVERY_GAP_MS = 15_000;
/**
 * A line typed with no activity reading since is presumed lost after this,
 * so a session whose hooks do not report still gets its routines.
 */
const UNACKNOWLEDGED_DELIVERY_MS = 2 * 60_000;
/** A dead resident session is relaunched at most this often. */
const REVIVE_BACKOFF_MS = 5 * 60_000;

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The skills a resident's session sees, written into its own workspace. */
const RESIDENT_SKILLS = [
  { name: "daedalus-resident", contents: residentSkillTemplate },
  { name: "daedalus-routine", contents: routineSkillTemplate },
];

const fill = (template: string, name: string) =>
  template.replaceAll("{{name}}", name);

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

/**
 * Whether the session is at its prompt, where a typed line starts a turn
 * rather than landing in the middle of one. A Claude session that ended its
 * turn with background agents still running reports `working`, and that is
 * exactly the state routines are delivered in: the typed line starts a turn
 * alongside them. A badge the agent raised on itself is not a prompt to
 * answer, so it does not hold delivery; a real question or permission
 * dialog does, because a typed line would answer it.
 */
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
      return match[1]!.replace(/\u00a0/g, " ").trim();
  }
  return undefined;
}

export function residentAtPrompt(
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
      // A badge the resident raised on itself, or Claude's idle notice from
      // a session started before residents dropped it: neither is a prompt.
      return (
        activity.source === "agent" || activity.detail === CLAUDE_IDLE_NOTICE
      );
    default:
      return false;
  }
}

/** The most recent fresh-context boundary at or before `now`. */
export function freshContextBoundary(now: Date): Date {
  const boundary = new Date(now.getTime());
  boundary.setHours(FRESH_CONTEXT_HOUR, 0, 0, 0);
  if (boundary.getTime() > now.getTime())
    boundary.setDate(boundary.getDate() - 1);
  return boundary;
}

/**
 * What the resident's lantern shows, most pressing first: an urgent finding,
 * any open finding, a routine in flight, or nothing to say.
 */
export type ResidentLamp = "urgent" | "findings" | "running" | "quiet";

export interface ResidentOverview {
  resident: Resident;
  workspaceSlug: string;
  workspacePath: string;
  /** The session's lifecycle, or null when it has none on duty. */
  sessionStatus: AgentSession["status"] | null;
  lamp: ResidentLamp;
  nextRunAt: string | null;
  runsInFlight: number;
  runsQueued: number;
  openFindings: number;
  openFindingTasks: number;
  routineErrors: number;
}

export interface ResidentMemoryFile {
  /** Where it is shown from: the workspace, or the provider's memory. */
  source: "workspace" | "memory";
  name: string;
  path: string;
  content: string;
  truncated: boolean;
}

const MEMORY_FILE_LIMIT = 64 * 1024;

export interface ResidentTickInput {
  /** Context use per session, from telemetry. */
  contextPercent: (sessionId: string) => number | undefined;
  /** When the user last typed into a session's terminal, in ms. */
  lastInputAt: (sessionId: string) => number | undefined;
  activity: (sessionId: string) => AgentActivityState | undefined;
}

export interface ResidentTickResult {
  queued: RoutineRun[];
  delivered: RoutineRun[];
  events: string[];
}

export class ResidentService {
  private readonly lastRevive = new Map<string, number>();

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly agents: AgentService,
    private readonly routines: RoutineService,
    private readonly findings: FindingService,
    private readonly paths: {
      /** Where resident workspaces live, apart from the user's projects. */
      root: string;
      /** The `daedal` this home's sessions run, written into the skills. */
      daedal: string;
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): Resident[] {
    return this.repositories.residents.listResidents();
  }

  get(reference: string): Resident {
    const resident = this.repositories.residents.findResident(reference);
    if (!resident)
      throw new DaedalusError(
        "NOT_FOUND",
        `Resident '${reference}' was not found`,
      );
    return resident;
  }

  /** What a surface needs to show each resident at a glance. */
  async overviews(): Promise<ResidentOverview[]> {
    const overviews: ResidentOverview[] = [];
    for (const resident of this.list()) {
      const workspace = this.repositories.findWorkspace(resident.workspaceId);
      if (!workspace) continue;
      const session = this.liveSession(resident);
      const inFlight = this.routines.inFlightRuns(resident);
      const open = this.repositories.residents.listFindings(resident.id, {
        states: ["open"],
      });
      const { routines, errors } = await this.routines.read(resident);
      const enabled = new Set(
        routines.filter((routine) => routine.enabled).map((item) => item.name),
      );
      const next = this.repositories.residents
        .listRoutineStates(resident.id)
        .filter((state) => enabled.has(state.name) && state.nextRunAt)
        .map((state) => state.nextRunAt!)
        .sort()[0];
      const running = inFlight.filter((run) => run.deliveredAt).length;
      overviews.push({
        resident,
        workspaceSlug: workspace.slug,
        workspacePath: workspace.path,
        sessionStatus: session?.status ?? null,
        lamp: open.some((finding) => finding.severity === "urgent")
          ? "urgent"
          : open.length
            ? "findings"
            : running
              ? "running"
              : "quiet",
        nextRunAt: resident.state === "on_duty" ? (next ?? null) : null,
        runsInFlight: running,
        runsQueued: inFlight.length - running,
        openFindings: open.length,
        openFindingTasks: new Set(
          open.flatMap((finding) => (finding.taskId ? [finding.taskId] : [])),
        ).size,
        routineErrors: errors.length,
      });
    }
    return overviews;
  }

  /**
   * The resident's files and its provider memory, read-only. Only the
   * resident writes its memory; a surface shows it.
   */
  async memory(
    reference: string,
    claudeProjectsDirectory: string,
  ): Promise<ResidentMemoryFile[]> {
    const resident = this.get(reference);
    const workspace = await this.workspaces.get(resident.workspaceId);
    const read = async (
      source: ResidentMemoryFile["source"],
      path: string,
    ): Promise<ResidentMemoryFile | undefined> => {
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
    const files: ResidentMemoryFile[] = [];
    for (const name of ["SERVICES.md", "TOOLS.md", "CHARTER.md"]) {
      const file = await read("workspace", join(workspace.path, name));
      if (file) files.push(file);
    }
    const memoryDirectory = join(
      claudeProjectsDirectory,
      claudeProjectKey(workspace.path),
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
   * The resident a command is about: the one named, else the one whose
   * session is running the command, else the only one there is.
   */
  resolve(reference?: string, sessionId?: string): Resident {
    if (reference) return this.get(reference);
    if (sessionId) {
      const own = this.repositories.residents.findResidentBySession(sessionId);
      if (own) return own;
    }
    const all = this.list();
    if (all.length === 1) return all[0]!;
    throw new DaedalusError(
      "VALIDATION",
      all.length === 0
        ? "No resident exists; create one with 'daedal resident create <slug>'"
        : "More than one resident exists; pass --resident <slug>",
    );
  }

  async create(input: {
    slug: string;
    name?: string;
    provider?: "claude" | "codex";
    model?: string;
  }): Promise<Resident> {
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG.test(slug))
      throw new DaedalusError(
        "VALIDATION",
        "A resident slug uses lowercase letters, digits and dashes",
      );
    // The routine skill is a Claude slash command in the workspace; Codex
    // would need its own delivery line and skill location first.
    if (input.provider && input.provider !== "claude")
      throw new DaedalusError(
        "VALIDATION",
        "A resident runs on Claude for now",
      );
    if (this.repositories.residents.findResident(slug))
      throw new DaedalusError("CONFLICT", `Resident '${slug}' already exists`);
    const name =
      input.name?.trim() || `${slug.slice(0, 1).toUpperCase()}${slug.slice(1)}`;
    const workspace = await this.workspaces.create({
      name,
      slug,
      path: join(this.paths.root, slug),
    });
    const resident: Resident = {
      id: crypto.randomUUID(),
      slug,
      name,
      workspaceId: workspace.id,
      provider: input.provider ?? "claude",
      model: input.model?.trim() || null,
      autoHandoffPercent: 60,
      state: "stopped",
      sessionId: null,
      drainingSince: null,
      createdAt: this.now().toISOString(),
    };
    await this.installFiles(workspace.path, resident, { brief: true });
    this.repositories.residents.createResident(resident);
    return resident;
  }

  /**
   * Writes the resident's own files. Content the resident or the user edits
   * is created once; the skills are Daedalus's and are refreshed every
   * start, so an upgrade reaches a resident that has been running for weeks.
   */
  private async installFiles(
    path: string,
    resident: Resident,
    options: { brief?: boolean } = {},
  ): Promise<void> {
    await createIfMissing(
      join(path, "CHARTER.md"),
      fill(residentCharterTemplate, resident.name),
    );
    await createIfMissing(join(path, "SERVICES.md"), residentServicesTemplate);
    await createIfMissing(join(path, "TOOLS.md"), residentToolsTemplate);
    // The workspace was just created with the generic brief; a resident's
    // brief is written for the agents its tasks start, so it replaces it.
    if (options.brief)
      await writeFile(
        join(path, "BRIEF.md"),
        fill(residentBriefTemplate, resident.name),
        "utf8",
      );
    await mkdir(join(path, ROUTINES_DIRECTORY, TEMPLATES_DIRECTORY), {
      recursive: true,
    });
    for (const skill of RESIDENT_SKILLS)
      await writeIfChanged(
        join(path, ".claude", "skills", skill.name, "SKILL.md"),
        skill.contents.replaceAll("{{daedal}}", this.paths.daedal),
      );
    // A starting point the resident adds to during setup and owns after.
    // Its own commands are allowed so they never wait on a prompt, and it
    // cannot ask the user a question, because nobody is there to answer.
    await createIfMissing(
      join(path, ".claude", "settings.json"),
      `${JSON.stringify(
        {
          permissions: {
            allow: ["routine", "finding", "attention", "notify"].flatMap(
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

  private liveSession(resident: Resident): AgentSession | undefined {
    if (!resident.sessionId) return undefined;
    const session = this.repositories.findAgent(resident.sessionId);
    return session && !session.archivedAt ? session : undefined;
  }

  async start(reference: string): Promise<Resident> {
    const resident = this.get(reference);
    const session = this.liveSession(resident);
    if (
      session &&
      (session.status === "running" || session.status === "starting")
    ) {
      const onDuty = { ...resident, state: "on_duty" as const };
      this.repositories.residents.updateResident(onDuty);
      return onDuty;
    }
    return this.launch(resident);
  }

  private async launch(resident: Resident): Promise<Resident> {
    const workspace = await this.workspaces.getActive(resident.workspaceId);
    await this.installFiles(workspace.path, resident);
    const session = await this.agents.spawn({
      workspace: workspace.id,
      name: resident.name,
      provider: resident.provider,
      ...(resident.model ? { model: resident.model } : {}),
      message: residentPrompt(resident.name),
      resident: true,
    });
    const onDuty: Resident = {
      ...resident,
      state: "on_duty",
      sessionId: session.id,
      drainingSince: null,
    };
    this.repositories.residents.updateResident(onDuty);
    return onDuty;
  }

  /** Archives the session. Routines, tasks and memory all stay. */
  async stop(reference: string): Promise<Resident> {
    const resident = this.get(reference);
    const session = this.liveSession(resident);
    if (session) await this.agents.archive(session.id, true);
    this.routines.skipUndelivered(
      resident,
      "Skipped: the resident was stopped",
    );
    const stopped: Resident = {
      ...resident,
      state: "stopped",
      drainingSince: null,
    };
    this.repositories.residents.updateResident(stopped);
    return stopped;
  }

  /**
   * Stops the resident and forgets it. Its workspace goes too, and its files
   * only with `deleteFiles`, under the same guards as removing a workspace.
   */
  async remove(
    reference: string,
    options: { deleteFiles?: boolean; force?: boolean },
  ): Promise<{ resident: Resident; filesDeleted: boolean }> {
    if (!options.force)
      throw new DaedalusError(
        "VALIDATION",
        "Removing a resident requires --force",
      );
    const resident = await this.stop(reference);
    this.repositories.residents.deleteResident(resident.id);
    const { filesDeleted } = await this.workspaces.remove(
      resident.workspaceId,
      { deleteFiles: options.deleteFiles, force: true },
    );
    return { resident, filesDeleted };
  }

  pause(reference: string): Resident {
    const resident = this.get(reference);
    if (resident.state === "stopped")
      throw new DaedalusError("CONFLICT", `${resident.name} is stopped`);
    this.routines.skipUndelivered(resident, "Skipped: the resident was paused");
    const paused: Resident = {
      ...resident,
      state: "paused",
      drainingSince: null,
    };
    this.repositories.residents.updateResident(paused);
    return paused;
  }

  async resume(reference: string): Promise<Resident> {
    const resident = this.get(reference);
    if (resident.state === "stopped") return this.start(resident.id);
    const onDuty: Resident = { ...resident, state: "on_duty" };
    this.repositories.residents.updateResident(onDuty);
    return onDuty;
  }

  update(
    reference: string,
    changes: {
      name?: string;
      model?: string | null;
      autoHandoffPercent?: number;
    },
  ): Resident {
    const resident = this.get(reference);
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
    const updated: Resident = {
      ...resident,
      name: changes.name?.trim() || resident.name,
      model:
        changes.model === undefined
          ? resident.model
          : changes.model?.trim() || null,
      autoHandoffPercent:
        changes.autoHandoffPercent ?? resident.autoHandoffPercent,
    };
    this.repositories.residents.updateResident(updated);
    return updated;
  }

  /**
   * One pass of the clock for every resident. The desktop host calls this on
   * its 1.2 s tick; nothing fires while the app is closed. Each resident is
   * handled on its own, so one that fails does not hold up another.
   */
  async tick(input: ResidentTickInput): Promise<ResidentTickResult> {
    const result: ResidentTickResult = {
      queued: [],
      delivered: [],
      events: [],
    };
    for (const resident of this.list()) {
      if (resident.state === "stopped") continue;
      try {
        await this.tickResident(resident, input, result);
      } catch (error) {
        result.events.push(
          `${resident.slug}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }

  private async tickResident(
    initial: Resident,
    input: ResidentTickInput,
    result: ResidentTickResult,
  ): Promise<void> {
    let resident = initial;
    const now = this.now();
    this.findings.sweep(resident);
    result.queued.push(
      ...(await this.routines.schedule(resident, {
        queue: resident.state !== "paused",
      })),
    );
    let session = this.liveSession(resident);
    if (!session || session.status === "exited" || session.status === "lost") {
      if (resident.state === "paused") return;
      const last = this.lastRevive.get(resident.id) ?? 0;
      if (now.getTime() - last < REVIVE_BACKOFF_MS) return;
      this.lastRevive.set(resident.id, now.getTime());
      if (session?.status === "lost") {
        await this.agents.reviveLost(session.id);
        result.events.push(`${resident.slug}: revived its lost session`);
      } else {
        resident = await this.launch(resident);
        result.events.push(`${resident.slug}: started a new session`);
      }
      return;
    }
    if (session.status !== "running") return;
    const delivered = this.routines.deliveredRuns(resident);

    if (resident.state === "on_duty") {
      const percent = input.contextPercent(session.id);
      const staleContext =
        Date.parse(session.startedAt) < freshContextBoundary(now).getTime();
      if (
        (percent !== undefined && percent >= resident.autoHandoffPercent) ||
        staleContext
      ) {
        resident = {
          ...resident,
          state: "draining",
          drainingSince: now.toISOString(),
        };
        this.repositories.residents.updateResident(resident);
        result.events.push(
          `${resident.slug}: draining for a ${staleContext ? "daily fresh context" : "full context"}`,
        );
      }
    }

    if (resident.state === "draining") {
      const drainingFor =
        now.getTime() - Date.parse(resident.drainingSince ?? now.toISOString());
      if (!session.handoffRequestedAt) {
        if (delivered.length === 0 || drainingFor >= DRAIN_LIMIT_MS) {
          await this.agents.requestHandoff(session.id);
          result.events.push(`${resident.slug}: asked for a handoff`);
        }
      } else if (
        now.getTime() - Date.parse(session.handoffRequestedAt) >=
        HANDOFF_LIMIT_MS
      ) {
        // The resident never ran the handoff. Its state is all outside the
        // conversation, so a successor without a note loses little.
        const { session: successor } = await this.agents.continueSession({
          id: session.id,
        });
        result.events.push(
          `${resident.slug}: handed off without a note to ${successor.id}`,
        );
      }
      return;
    }

    if (resident.state !== "on_duty" || session.handoffRequestedAt) return;
    if (delivered.length >= MAX_RUNS_IN_FLIGHT) return;
    const typedAt = input.lastInputAt(session.id);
    if (typedAt !== undefined && now.getTime() - typedAt < USER_TYPING_HOLD_MS)
      return;
    const activity = input.activity(session.id);
    if (!residentAtPrompt(activity)) return;
    const lastDelivery = Math.max(
      0,
      ...this.routines
        .runs(resident, { limit: 20 })
        .map((run) => (run.deliveredAt ? Date.parse(run.deliveredAt) : 0)),
    );
    if (now.getTime() - lastDelivery < DELIVERY_GAP_MS) return;
    // The last line has not been seen yet: the pane may still be taking it.
    if (
      lastDelivery &&
      Date.parse(activity!.observedAt) <= lastDelivery &&
      now.getTime() - lastDelivery < UNACKNOWLEDGED_DELIVERY_MS
    )
      return;
    const busy = new Set(delivered.map((run) => run.routine));
    const next = this.routines
      .inFlightRuns(resident)
      .filter((run) => !run.deliveredAt && !busy.has(run.routine))
      .sort((left, right) => left.id - right.id)[0];
    if (!next) return;
    // Text left in the input box would be sent along with the routine line,
    // so a draft holds delivery until it is sent or cleared.
    const draft = composerText(
      await this.agents.screen(session.id).catch(() => ""),
    );
    if (draft) return;
    await this.agents.send(session.id, `/daedalus-routine ${next.id}`);
    result.delivered.push(this.routines.markDelivered(next, session.id));
  }
}

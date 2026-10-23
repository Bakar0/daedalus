import { mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { writeFileAtomic } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { AgentActivity, AgentSession, SessionWorktree } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import { cloudHostWorkspace } from "./cloud-launch";
import {
  applySnapshot,
  caseCollisions,
  changedLinks,
  changedPaths,
  fetchBundle,
  isRepository,
  lastRef,
  markLast,
  resolveRef,
  snapshotRepository,
  steersAgent,
  unchangedSince,
  writeBundle,
  type RepositorySnapshot,
} from "./move-git";
import {
  claudeProjectKey,
  isPodAccess,
  LocalMoveSide,
  must,
  PodMoveSide,
  podWorkingDirectory,
  type MoveSide,
} from "./move-side";
import {
  appendedTranscript,
  lastPermissionMode,
  safeTranscriptPath,
  sentFile,
  readTranscript,
  rewriteTranscript,
  writeTranscript,
  type ClaudePermissionMode,
  type SentTranscriptFile,
  type TranscriptFiles,
} from "./move-transcript";
import type { SessionHosts } from "./session-hosts";
import type { WorkspaceService } from "./workspaces";

export type MoveTarget = "cloud" | "local";

/** A move in progress, for the session's card. */
export interface SessionMoveState {
  sessionId: string;
  to: MoveTarget;
  /** `moved` stays, with `notice`, until the user dismisses it. */
  phase: "waiting" | "stopping" | "copying" | "starting" | "failed" | "moved";
  detail?: string;
  /** Set when `failed`. */
  message?: string;
  /** Set when `moved` and the user should know something about the result. */
  notice?: string;
}

export type SessionMoveResult =
  | { status: "moved"; session: AgentSession; notice?: string }
  | { status: "needsApproval"; paths: string[] };

/** What the cloud service does for a move; `CloudService` has it. */
export interface MoveCloud {
  /**
   * Makes or wakes the workspace's cloud copy and waits for its runner;
   * returns its host id.
   */
  prepareForSession(workspaceReference: string): Promise<string>;
}

export interface SessionMovesOptions {
  config: DaedalusConfig;
  repositories: SqliteRepositories;
  workspaces: WorkspaceService;
  agents: AgentService;
  hosts: SessionHosts;
  cloud: MoveCloud;
  /** What the session is doing, as the durable activity record says. */
  activity: (sessionId: string) => Promise<AgentActivity | undefined>;
  /** How long a move waits for the session's turn to end. */
  turnTimeoutMs?: number;
  pollMs?: number;
  /** How long a failed move stays on the card. */
  failedForMs?: number;
  /** The pod's workspace root as commands see it; tests use a folder. */
  podRoot?: string;
}

/**
 * What a session that moved to the cloud needs to come back: the folder it
 * had on this Mac, and the conversation files as they were sent, which the
 * pod may only add to. Kept on this Mac, so nothing the pod says decides it.
 */
interface MoveRecord {
  macWorkingDirectory: string;
  transcript: SentTranscriptFile[];
}

/** Shown on the session after it comes back from the cloud. */
export const MOVED_BACK_NOTICE =
  "Back on this Mac in ask-before-acting mode, since the cloud wrote part of this conversation. Press Shift+Tab in the session to switch modes.";

/** A transcript, its subagents and saved tool output. */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
/** One repository's bundle, which the Mac holds in memory while it travels. */
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POD_PROJECTS = ".home/.claude/projects";
/**
 * A session the cloud wrote part of comes back asking before it acts: what
 * the pod added to its conversation is not this Mac's (move-design.md).
 */
const MOVED_BACK_PERMISSION_MODE: ClaudePermissionMode = "default";
const POD_SCRATCH = ".daedalus-move";
const BUSY: readonly (AgentActivity | undefined)[] = [
  "working",
  "needs_permission",
];

/**
 * Moves a Claude session between this Mac and its workspace's cloud pod: it
 * waits for the session's turn to end, stops it, carries its repositories
 * (commits, staged, unstaged and untracked changes, never ignored files) and
 * its conversation to the other side, and resumes it there. The session
 * keeps its id and its place; only its host changes. Until the other side is
 * running, nothing on the side it left is changed, so a failure resumes it
 * where it was.
 */
export class SessionMoves {
  readonly #moves = new Map<
    string,
    SessionMoveState & { cancel: AbortController }
  >();
  readonly #listeners = new Set<() => void>();
  readonly #local = new LocalMoveSide();

  constructor(private readonly options: SessionMovesOptions) {}

  list(): SessionMoveState[] {
    return [...this.#moves.values()].map(({ cancel: _cancel, ...state }) => ({
      ...state,
    }));
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The folder a cloud session left this Mac from, or undefined for one that
   * never ran here.
   */
  async movedFrom(sessionId: string): Promise<string | undefined> {
    return (await this.#record(sessionId))?.macWorkingDirectory;
  }

  /**
   * Gives up the way back for a session that stays on this Mac as it left
   * it, its cloud work left behind.
   */
  async forget(sessionId: string): Promise<void> {
    await rm(this.#recordPath(sessionId), { force: true });
  }

  /** Clears a finished move's notice from the session. */
  dismiss(sessionId: string): void {
    if (this.#moves.get(sessionId)?.phase !== "moved") return;
    this.#moves.delete(sessionId);
    this.#changed();
  }

  /** Stops a move that is still waiting for the turn to end. */
  cancel(sessionId: string): void {
    const move = this.#moves.get(sessionId);
    if (!move || move.phase !== "waiting")
      throw new DaedalusError(
        "CONFLICT",
        "Only a move that waits for the turn to end can be cancelled",
      );
    move.cancel.abort();
  }

  async move(input: {
    sessionId: string;
    to: MoveTarget;
    approved?: string[];
  }): Promise<SessionMoveResult> {
    const { sessionId, to } = input;
    if (to !== "cloud" && to !== "local")
      throw new DaedalusError(
        "VALIDATION",
        "A session moves to cloud or local",
      );
    const existing = this.#moves.get(sessionId);
    if (existing && existing.phase !== "failed" && existing.phase !== "moved")
      throw new DaedalusError("CONFLICT", "This session is already moving");
    const state = {
      sessionId,
      to,
      phase: "waiting" as SessionMoveState["phase"],
      cancel: new AbortController(),
    } as SessionMoveState & { cancel: AbortController };
    this.#moves.set(sessionId, state);
    this.#changed();
    try {
      const result =
        to === "cloud"
          ? await this.#toCloud(sessionId, state)
          : await this.#toLocal(sessionId, state, input.approved ?? []);
      if (result.status === "moved" && result.notice)
        this.#update(state, {
          phase: "moved",
          detail: undefined,
          notice: result.notice,
        });
      else {
        this.#moves.delete(sessionId);
        this.#changed();
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#update(state, { phase: "failed", message });
      setTimeout(() => {
        if (this.#moves.get(sessionId) === state) {
          this.#moves.delete(sessionId);
          this.#changed();
        }
      }, this.options.failedForMs ?? 30_000).unref?.();
      throw error;
    }
  }

  async #toCloud(
    sessionId: string,
    state: SessionMoveState & { cancel: AbortController },
  ): Promise<SessionMoveResult> {
    const { repositories, workspaces, agents, cloud } = this.options;
    const agent = this.#movable(await agents.get(sessionId));
    if (agent.hostId)
      throw new DaedalusError(
        "CONFLICT",
        "This session already runs in the cloud",
      );
    const workspace = await workspaces.getActive(agent.workspaceId);
    const folder = inside(workspace.path, agent.workingDirectory);
    const worktrees = repositories
      .listSessionWorktrees({ sessionId })
      .map((worktree) => ({
        worktree,
        pod: inside(workspace.path, worktree.path),
      }));

    this.#update(state, { detail: "Starting the cloud workspace" });
    const hostId = await cloud.prepareForSession(workspace.id);
    const pod = this.#pod(hostId);

    // The pod's copy must be what this session left there, or nothing.
    for (const { worktree, pod: dir } of worktrees) {
      const exists = (await pod.run(".", "test", ["-e", dir])).exitCode === 0;
      if (exists && !(await isRepository(pod, dir)))
        throw new DaedalusError(
          "CONFLICT",
          `${dir} in the cloud workspace is not this session's copy of ${repositoryName(worktree)}`,
        );
      if (exists && !(await unchangedSince(pod, dir, sessionId)))
        throw new DaedalusError(
          "CONFLICT",
          `The cloud workspace's copy of ${repositoryName(worktree)} changed since this session left it`,
        );
    }

    const stopped = await this.#stopAfterTurn(agent, state);
    const scratch = `${POD_SCRATCH}/${sessionId}`;
    const localScratch = join(
      this.options.config.home,
      "tmp",
      "moves",
      sessionId,
    );
    try {
      this.#update(state, { phase: "copying", detail: undefined });
      await mkdir(localScratch, { recursive: true, mode: 0o700 });
      const sent: { dir: string; local: string; work: string }[] = [];
      for (const [index, { worktree, pod: dir }] of worktrees.entries()) {
        this.#update(state, { detail: `Copying ${repositoryName(worktree)}` });
        const snapshot = await snapshotRepository(this.#local, worktree.path);
        const podIsRepository = await isRepository(pod, dir);
        const podLast = podIsRepository
          ? await resolveRef(pod, dir, lastRef(sessionId))
          : undefined;
        const bundle = join(localScratch, `${index}.bundle`);
        await writeBundle(
          this.#local,
          worktree.path,
          sessionId,
          snapshot,
          podLast ? [podLast] : [],
          bundle,
        );
        const podBundle = `${scratch}/${index}.bundle`;
        await pod.writeFile(podBundle, await readLimited(bundle));
        if (!podIsRepository)
          await must(pod, ".", "git", [
            "init",
            "--quiet",
            "--",
            pod.absolute(dir),
          ]);
        const fetched = await fetchBundle(pod, dir, sessionId, podBundle);
        sameSnapshot(fetched, snapshot);
        await applySnapshot(pod, dir, worktree.branchName, fetched, podLast);
        sent.push({ dir, local: worktree.path, work: snapshot.work });
      }

      this.#update(state, { detail: "Copying the conversation" });
      const macProjects = agents.claudeProjectsDirectory(agent);
      const transcript = await readTranscript(
        this.#local,
        macProjects,
        claudeProjectKey(agent.workingDirectory),
        agent.providerSessionId!,
        MAX_TRANSCRIPT_BYTES,
      );
      const main = transcript.files[0]!;
      const text = new TextDecoder().decode(main.contents);
      const permissionMode =
        lastPermissionMode(text) ?? this.#defaultPermissionMode();
      const podFolder = podWorkingDirectory(folder);
      const podTranscript = withMain(
        transcript,
        rewriteTranscript(text, {
          from: agent.workingDirectory,
          to: podFolder,
          strict: false,
        }),
      );
      await writeTranscript(
        pod,
        POD_PROJECTS,
        claudeProjectKey(podFolder),
        podTranscript,
      );

      // Both copies now agree; the next move in either direction checks
      // against this.
      for (const { dir, local, work } of sent) {
        await markLast(pod, dir, sessionId, work);
        await markLast(this.#local, local, sessionId, work);
      }
      await this.#saveRecord(sessionId, {
        macWorkingDirectory: agent.workingDirectory,
        transcript: transcript.files.map((file, index) =>
          sentFile(
            file.path,
            file.contents,
            podTranscript.files[index]!.contents,
          ),
        ),
      });

      this.#update(state, { phase: "starting", detail: undefined });
      const moved = await agents.resumeAfterMove(
        {
          ...stopped,
          hostId,
          workingDirectory: folder,
        },
        permissionMode,
      );
      return { status: "moved", session: moved };
    } catch (error) {
      await this.#resumeWhereItWas(stopped, agent, error);
      throw error;
    } finally {
      await rm(localScratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await pod.remove(scratch).catch(() => undefined);
    }
  }

  async #toLocal(
    sessionId: string,
    state: SessionMoveState & { cancel: AbortController },
    approved: string[],
  ): Promise<SessionMoveResult> {
    const { repositories, workspaces, agents, cloud } = this.options;
    const agent = this.#movable(await agents.get(sessionId));
    const cloudId = agent.hostId ? cloudHostWorkspace(agent.hostId) : undefined;
    if (!cloudId)
      throw new DaedalusError(
        "CONFLICT",
        "This session already runs on this Mac",
      );
    const record = await this.#record(sessionId);
    if (!record)
      throw new DaedalusError(
        "CONFLICT",
        "Only a session that moved to the cloud from this Mac can move back yet",
      );
    const workspace = await workspaces.getActive(agent.workspaceId);
    const worktrees = repositories
      .listSessionWorktrees({ sessionId })
      .map((worktree) => ({
        worktree,
        pod: inside(workspace.path, worktree.path),
      }));
    if (
      inside(workspace.path, record.macWorkingDirectory) !==
      agent.workingDirectory
    )
      throw new DaedalusError(
        "CONFLICT",
        "This session's folder in the cloud is not the one it left this Mac from",
      );

    // This Mac's copy must be what the session left behind.
    for (const { worktree } of worktrees)
      if (!(await unchangedSince(this.#local, worktree.path, sessionId)))
        throw new DaedalusError(
          "CONFLICT",
          `This Mac's copy of ${repositoryName(worktree)} changed since the session moved to the cloud`,
        );

    this.#update(state, { detail: "Waking the cloud workspace" });
    if ((await cloud.prepareForSession(workspace.id)) !== agent.hostId)
      throw new DaedalusError(
        "CONFLICT",
        "This session's cloud workspace is no longer this workspace's",
      );
    const pod = this.#pod(agent.hostId!);

    // Asked before the session stops: what in the pod would steer an agent
    // or run on this Mac. Checked again on the bundle itself below.
    const allowed = new Set(approved);
    const asking: string[] = [];
    for (const { worktree, pod: dir } of worktrees) {
      const last = await resolveRef(
        this.#local,
        worktree.path,
        lastRef(sessionId),
      );
      if (!(await isRepository(pod, dir)))
        throw new DaedalusError(
          "CONFLICT",
          `The cloud workspace no longer has this session's copy of ${repositoryName(worktree)}`,
        );
      const now = await snapshotRepository(pod, dir);
      for (const path of await this.#steering(pod, dir, last!, now))
        if (!allowed.has(displayPath(worktree, path)))
          asking.push(displayPath(worktree, path));
    }
    if (asking.length) {
      this.#moves.delete(sessionId);
      this.#changed();
      return { status: "needsApproval", paths: [...new Set(asking)].sort() };
    }

    const stopped = await this.#stopAfterTurn(agent, state);
    const scratch = `${POD_SCRATCH}/${sessionId}`;
    const localScratch = join(
      this.options.config.home,
      "tmp",
      "moves",
      sessionId,
    );
    try {
      this.#update(state, { phase: "copying", detail: undefined });
      await mkdir(localScratch, { recursive: true, mode: 0o700 });
      const received: {
        worktree: SessionWorktree;
        dir: string;
        snapshot: RepositorySnapshot;
        last: string;
      }[] = [];
      for (const [index, { worktree, pod: dir }] of worktrees.entries()) {
        this.#update(state, { detail: `Copying ${repositoryName(worktree)}` });
        const last = (await resolveRef(
          this.#local,
          worktree.path,
          lastRef(sessionId),
        ))!;
        const snapshot = await snapshotRepository(pod, dir);
        const podBundle = `${scratch}/${index}.bundle`;
        await must(pod, ".", "mkdir", ["-p", "--", scratch]);
        await writeBundle(pod, dir, sessionId, snapshot, [last], podBundle);
        const bytes = await pod.readFile(podBundle);
        if (!bytes)
          throw new DaedalusError(
            "DEPENDENCY",
            "The cloud workspace wrote no bundle",
          );
        const bundle = join(localScratch, `${index}.bundle`);
        await this.#local.writeFile(bundle, bytes);
        const fetched = await fetchBundle(
          this.#local,
          worktree.path,
          sessionId,
          bundle,
        );
        for (const commit of [fetched.head, fetched.index, fetched.work]) {
          const collisions = await caseCollisions(
            this.#local,
            worktree.path,
            commit,
          );
          if (collisions.length)
            throw new DaedalusError(
              "CONFLICT",
              `The cloud copy of ${repositoryName(worktree)} has names that differ only in case, which this Mac cannot hold apart: ${collisions.slice(0, 5).join(", ")}`,
            );
        }
        for (const path of await this.#steering(
          this.#local,
          worktree.path,
          last,
          fetched,
        ))
          if (!allowed.has(displayPath(worktree, path)))
            throw new DaedalusError(
              "CONFLICT",
              `${displayPath(worktree, path)} changed in the cloud after it was approved; move the session again`,
            );
        received.push({ worktree, dir, snapshot: fetched, last });
      }

      this.#update(state, { detail: "Copying the conversation" });
      const podFolder = podWorkingDirectory(agent.workingDirectory);
      const transcript = await readTranscript(
        pod,
        POD_PROJECTS,
        claudeProjectKey(podFolder),
        agent.providerSessionId!,
        MAX_TRANSCRIPT_BYTES,
      );
      const macProjects = agents.claudeProjectsDirectory(agent);
      const macKey = claudeProjectKey(record.macWorkingDirectory);
      const macCopies = new Map<string, Uint8Array | undefined>();
      for (const sent of record.transcript)
        macCopies.set(
          sent.path,
          await this.#local.readFile(
            join(macProjects, macKey, ...sent.path.split("/")),
          ),
        );
      const rewritten = appendedTranscript({
        pod: transcript,
        sent: record.transcript,
        mac: (path) => macCopies.get(path),
        rewrite: (text) =>
          rewriteTranscript(text, {
            from: podFolder,
            to: record.macWorkingDirectory,
            permissionMode: MOVED_BACK_PERMISSION_MODE,
            strict: true,
          }),
      });

      // Nothing on this Mac changed until here.
      for (const { worktree, dir, snapshot, last } of received) {
        await applySnapshot(
          this.#local,
          worktree.path,
          worktree.branchName,
          snapshot,
          last,
        );
        await markLast(this.#local, worktree.path, sessionId, snapshot.work);
        await markLast(pod, dir, sessionId, snapshot.work);
      }
      await writeTranscript(this.#local, macProjects, macKey, rewritten);

      this.#update(state, { phase: "starting", detail: undefined });
      const moved = await agents.resumeAfterMove(
        {
          ...stopped,
          hostId: null,
          workingDirectory: record.macWorkingDirectory,
        },
        MOVED_BACK_PERMISSION_MODE,
      );
      await rm(this.#recordPath(sessionId), { force: true });
      return { status: "moved", session: moved, notice: MOVED_BACK_NOTICE };
    } catch (error) {
      await this.#resumeWhereItWas(stopped, agent, error);
      throw error;
    } finally {
      await rm(localScratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await pod.remove(scratch).catch(() => undefined);
    }
  }

  /** Paths that steer an agent and differ from what this Mac last had. */
  async #steering(
    side: MoveSide,
    dir: string,
    last: string,
    now: RepositorySnapshot,
  ): Promise<string[]> {
    // The commit too: what it holds is the branch's content on this Mac,
    // which a reset or a stash puts back in the working tree.
    const paths = new Set([
      ...(await changedPaths(side, dir, last, now.head)),
      ...(await changedPaths(side, dir, last, now.work)),
      ...(await changedPaths(side, dir, last, now.index)),
    ]);
    const links = new Set<string>();
    for (const commit of [now.head, now.index, now.work])
      for (const path of await changedLinks(side, dir, last, commit))
        links.add(`${path} (symbolic link)`);
    return [...[...paths].filter(steersAgent), ...links];
  }

  #movable(agent: AgentSession): AgentSession {
    if (agent.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        "Restore the session before moving it",
      );
    if (agent.kind !== "agent" || agent.provider !== "claude")
      throw new DaedalusError("VALIDATION", "Only a Claude session can move");
    if (!agent.providerSessionId)
      throw new DaedalusError(
        "CONFLICT",
        "This session has no conversation to carry",
      );
    // It names files on both sides.
    if (!UUID.test(agent.providerSessionId))
      throw new DaedalusError(
        "CONFLICT",
        "This session's conversation id is not one a move can carry",
      );
    return agent;
  }

  #pod(hostId: string): PodMoveSide {
    const host = this.options.hosts.get(hostId);
    if (!isPodAccess(host))
      throw new DaedalusError(
        "DEPENDENCY",
        "The cloud workspace cannot take files from this Mac",
      );
    return new PodMoveSide(host, MAX_BUNDLE_BYTES, this.options.podRoot);
  }

  /** Waits for the session's turn to end, then stops it. */
  async #stopAfterTurn(
    agent: AgentSession,
    state: SessionMoveState & { cancel: AbortController },
  ): Promise<AgentSession> {
    if (agent.status !== "running" && agent.status !== "starting") return agent;
    this.#update(state, {
      phase: "waiting",
      detail: "Waiting for the turn to end",
    });
    const deadline = Date.now() + (this.options.turnTimeoutMs ?? 30 * 60_000);
    while (BUSY.includes(await this.options.activity(agent.id))) {
      if (state.cancel.signal.aborted)
        throw new DaedalusError("CONFLICT", "The move was cancelled");
      if (Date.now() > deadline)
        throw new DaedalusError(
          "CONFLICT",
          "The session's turn did not end; try the move again when it is idle",
        );
      await Bun.sleep(this.options.pollMs ?? 1_000);
    }
    if (state.cancel.signal.aborted)
      throw new DaedalusError("CONFLICT", "The move was cancelled");
    this.#update(state, { phase: "stopping", detail: undefined });
    return this.options.agents.stopForMove(agent.id);
  }

  /** After a failed move: the session runs where it was, as it was. */
  async #resumeWhereItWas(
    stopped: AgentSession,
    before: AgentSession,
    cause: unknown,
  ): Promise<void> {
    if (before.status !== "running" && before.status !== "starting") return;
    const current = this.options.repositories.findAgent(stopped.id);
    if (
      current &&
      (current.status === "running" || current.status === "starting")
    )
      return;
    try {
      await this.options.agents.resumeAfterMove({
        ...stopped,
        hostId: before.hostId,
        workingDirectory: before.workingDirectory,
      });
    } catch (error) {
      throw new DaedalusError(
        "DEPENDENCY",
        `${cause instanceof Error ? cause.message : String(cause)}; the session did not start again where it was: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #defaultPermissionMode(): ClaudePermissionMode {
    return this.options.config.agents.claude?.permissionMode === "inherit"
      ? "default"
      : "auto";
  }

  #recordPath(sessionId: string): string {
    return join(this.options.config.home, "session-moves", `${sessionId}.json`);
  }

  async #record(sessionId: string): Promise<MoveRecord | undefined> {
    try {
      const value = JSON.parse(
        await readFile(this.#recordPath(sessionId), "utf8"),
      ) as Partial<MoveRecord>;
      if (
        typeof value.macWorkingDirectory !== "string" ||
        !isAbsolute(value.macWorkingDirectory) ||
        !Array.isArray(value.transcript) ||
        !value.transcript.every(
          (file) =>
            typeof file?.path === "string" &&
            safeTranscriptPath(file.path) &&
            Number.isSafeInteger(file.macLength) &&
            Number.isSafeInteger(file.podLength) &&
            typeof file.macSha256 === "string" &&
            typeof file.podSha256 === "string",
        )
      )
        return undefined;
      return {
        macWorkingDirectory: value.macWorkingDirectory,
        transcript: value.transcript,
      };
    } catch {
      return undefined;
    }
  }

  async #saveRecord(sessionId: string, record: MoveRecord): Promise<void> {
    await writeFileAtomic(
      this.#recordPath(sessionId),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600, ensureDir: true },
    );
  }

  #update(state: SessionMoveState, change: Partial<SessionMoveState>): void {
    Object.assign(state, change);
    for (const key of ["detail", "message"] as const)
      if (state[key] === undefined) delete state[key];
    this.#changed();
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** A path under `root` as a relative one, `.` for the root itself. */
function inside(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new DaedalusError(
      "CONFLICT",
      `${path} is outside the workspace folder, so it cannot move`,
    );
  return rel || ".";
}

const repositoryName = (worktree: SessionWorktree): string =>
  worktree.path.split("/").at(-1) ?? worktree.path;

const displayPath = (worktree: SessionWorktree, path: string): string =>
  `${repositoryName(worktree)}/${path}`;

function sameSnapshot(a: RepositorySnapshot, b: RepositorySnapshot): void {
  if (a.head !== b.head || a.index !== b.index || a.work !== b.work)
    throw new DaedalusError(
      "DEPENDENCY",
      "The cloud workspace read a different snapshot from the one sent",
    );
}

function withMain(transcript: TranscriptFiles, text: string): TranscriptFiles {
  const [main, ...rest] = transcript.files;
  return {
    files: [
      { path: main!.path, contents: new TextEncoder().encode(text) },
      ...rest,
    ],
  };
}

async function readLimited(path: string): Promise<Uint8Array> {
  const file = Bun.file(path);
  if (file.size > MAX_BUNDLE_BYTES)
    throw new DaedalusError(
      "CONFLICT",
      `A repository's bundle is ${file.size} bytes; a move carries at most ${MAX_BUNDLE_BYTES}`,
    );
  return new Uint8Array(await file.arrayBuffer());
}

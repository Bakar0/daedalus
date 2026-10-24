import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathExists, writeFileAtomic } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type {
  AgentActivity,
  AgentSession,
  Workspace,
  WorkspaceRepository,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import { podSessionInstructions } from "./cloud-folder";
import { podLibrary } from "./cloud-worktrees";
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
  writeBundle,
  type RepositorySnapshot,
} from "./move-git";
import {
  claudeProjectKey,
  isPodAccess,
  LocalMoveSide,
  must,
  POD_CLAUDE_PROJECTS,
  PodMoveSide,
  podWorkingDirectory,
  type MoveSide,
} from "./move-side";
import {
  appendedTranscript,
  lastPermissionMode,
  readTranscript,
  rewriteTranscript,
  safeTranscriptPath,
  sentFile,
  sha256,
  writeTranscript,
  type ClaudePermissionMode,
  type SentTranscriptFile,
  type TranscriptFiles,
} from "./move-transcript";
import type { SessionHosts } from "./session-hosts";
import {
  applyFromPod,
  insideFolders,
  changedSteering,
  listMacFiles,
  listPodFiles,
  packInPod,
  packMac,
  podHashes,
  safeWorkspacePath,
  unpackFromPod,
  unpackInPod,
} from "./workspace-move-files";
import { sessionInstructionsTemplate } from "./workspace-content";
import type { WorkspaceService } from "./workspaces";

export type WorkspacePlaceName = "mac" | "cloud";

/** A workspace move in progress, for the workspace's header. */
export interface WorkspaceMoveState {
  workspaceId: string;
  to: WorkspacePlaceName;
  /** `moved` stays, with `notice`, until the user dismisses it. */
  phase: "waiting" | "stopping" | "copying" | "starting" | "failed" | "moved";
  detail?: string;
  /** Set when `failed`. */
  message?: string;
  /** Set when `moved` and the user should know something about the result. */
  notice?: string;
}

export interface MoveSessionName {
  id: string;
  name: string;
}

export interface TooBig {
  what: string;
  bytes: number;
  maxBytes: number;
}

/**
 * - `moved`: done; every session that ran runs on the other side.
 * - `needsApproval`: moving home would bring files that steer agents or run
 *   on this Mac; ask, then move again with `approved`.
 * - `busy`: sessions wait for the user to answer a permission question, so
 *   their turn will not end on its own; ask, then move with `stopWorking`.
 * - `needsStopped`: Codex or custom sessions run, which the cloud cannot.
 * - `needsSmaller`: something is over a cap; nothing changed.
 */
export type WorkspaceMoveResult =
  | { status: "moved"; workspace: Workspace; notice?: string }
  | { status: "needsApproval"; paths: string[] }
  | { status: "busy"; sessions: MoveSessionName[] }
  | { status: "needsStopped"; sessions: MoveSessionName[] }
  | { status: "needsSmaller"; items: TooBig[] };

/** What the cloud service does for a workspace move; `CloudService` has it. */
export interface WorkspaceMoveCloud {
  /** Makes or wakes the workspace's cloud copy; its host id. */
  prepareForSession(workspaceReference: string): Promise<string>;
  /** Deletes the copy, its pod and volumes, and the link to it. */
  delete(workspaceReference: string): Promise<unknown>;
}

export interface WorkspaceMovesOptions {
  config: DaedalusConfig;
  repositories: SqliteRepositories;
  workspaces: WorkspaceService;
  agents: AgentService;
  hosts: SessionHosts;
  cloud: WorkspaceMoveCloud;
  /** Closes the integrated terminals open in a folder. */
  terminals: { closeInside(folder: string): Promise<void> };
  /** What a session is doing, as the durable activity record says. */
  activity: (sessionId: string) => Promise<AgentActivity | undefined>;
  /** How long a move waits for working sessions' turns to end. */
  turnTimeoutMs?: number;
  pollMs?: number;
  /** How long a failed move stays on the header. */
  failedForMs?: number;
  /** The pod's workspace root as commands see it; tests use a folder. */
  podRoot?: string;
}

/** One repository's bundles in a move. */
export const MAX_REPOSITORY_BYTES = 1024 * 1024 * 1024;
/** The files outside git, as one archive. */
export const MAX_FILES_BYTES = 256 * 1024 * 1024;
/** Everything a move carries. */
export const MAX_MOVE_BYTES = 2 * 1024 * 1024 * 1024;
/** A session's transcript, its subagents and saved tool output. */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

/** Shown on the workspace after it comes home. */
export const MOVED_HOME_NOTICE =
  "Back on this Mac. Its Claude sessions ask before acting, since the cloud wrote part of their conversations; press Shift+Tab in a session to switch modes.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POD_PROJECTS = POD_CLAUDE_PROJECTS;
const POD_SCRATCH = ".daedalus-move";
/** A session the cloud wrote part of comes home asking before it acts. */
const MOVED_HOME_PERMISSION_MODE: ClaudePermissionMode = "default";
const LIVE = ["running", "starting"];

/** One git worktree of the workspace as a move carries it. */
interface Tree {
  /** Names its refs on both sides: the session's id, or `ref-<repository>`. */
  key: string;
  repository: WorkspaceRepository;
  /** Relative to the workspace folder, the same on both sides. */
  path: string;
  /** Undefined for a detached checkout: a repository's reference. */
  branch?: string;
}

/**
 * What a workspace that moved to the cloud needs to come home: each Claude
 * session's folder and conversation as sent, which the pod may only add to,
 * and the branch each worktree was on. Kept on this Mac, so nothing the pod
 * says decides it.
 */
interface WorkspaceMoveRecord {
  sessions: Record<
    string,
    { macWorkingDirectory: string; transcript: SentTranscriptFile[] }
  >;
  branches: Record<string, string>;
}

class TooBigError extends Error {
  constructor(readonly items: TooBig[]) {
    super(items.map((item) => `${item.what} is too big`).join("; "));
  }
}

/**
 * Moves a whole workspace between this Mac and its cloud copy (see
 * workspace-move-design.md): it waits for the sessions' turns to end, stops
 * them, carries every git worktree (commits, staged, unstaged and untracked
 * changes, never ignored files), the other files of the folder and every
 * Claude conversation, then switches the workspace and its sessions to the
 * other side in one transaction and resumes what ran. Until that switch,
 * nothing on the side it left is changed, so a failure resumes every session
 * where it was. Everything from the pod is untrusted.
 */
export class WorkspaceMoves {
  readonly #moves = new Map<
    string,
    WorkspaceMoveState & { cancel: AbortController }
  >();
  readonly #listeners = new Set<() => void>();
  readonly #local = new LocalMoveSide();

  constructor(private readonly options: WorkspaceMovesOptions) {}

  list(): WorkspaceMoveState[] {
    return [...this.#moves.values()].map(({ cancel: _cancel, ...state }) => ({
      ...state,
    }));
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Whether the workspace is moving now. */
  moving(workspaceId: string): boolean {
    const phase = this.#moves.get(workspaceId)?.phase;
    return phase !== undefined && phase !== "failed" && phase !== "moved";
  }

  /** Clears a finished move's notice. */
  dismiss(workspaceId: string): void {
    if (this.#moves.get(workspaceId)?.phase !== "moved") return;
    this.#moves.delete(workspaceId);
    this.#changed();
  }

  /** Stops a move that still waits for turns to end. */
  cancel(workspaceId: string): void {
    const move = this.#moves.get(workspaceId);
    if (!move || move.phase !== "waiting")
      throw new DaedalusError(
        "CONFLICT",
        "Only a move that waits for turns to end can be cancelled",
      );
    move.cancel.abort();
  }

  async move(input: {
    workspace: string;
    to: WorkspacePlaceName;
    approved?: string[];
    stopWorking?: boolean;
  }): Promise<WorkspaceMoveResult> {
    const { to } = input;
    if (to !== "cloud" && to !== "mac")
      throw new DaedalusError(
        "VALIDATION",
        "A workspace moves to cloud or mac",
      );
    const workspace = await this.options.workspaces.getActive(input.workspace);
    if (this.moving(workspace.id))
      throw new DaedalusError("CONFLICT", "This workspace is already moving");
    const place = this.options.repositories.workspacePlace(workspace.id).place;
    if (place === to)
      throw new DaedalusError(
        "CONFLICT",
        to === "cloud"
          ? "This workspace already runs in the cloud"
          : "This workspace already runs on this Mac",
      );
    const state = {
      workspaceId: workspace.id,
      to,
      phase: "waiting" as WorkspaceMoveState["phase"],
      cancel: new AbortController(),
    } as WorkspaceMoveState & { cancel: AbortController };
    this.#moves.set(workspace.id, state);
    this.#changed();
    try {
      const result =
        to === "cloud"
          ? await this.#toCloud(workspace, state, input.stopWorking ?? false)
          : await this.#toMac(
              workspace,
              state,
              input.approved ?? [],
              input.stopWorking ?? false,
            );
      if (result.status === "moved" && result.notice)
        this.#update(state, {
          phase: "moved",
          detail: undefined,
          notice: result.notice,
        });
      else {
        this.#moves.delete(workspace.id);
        this.#changed();
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#update(state, { phase: "failed", message });
      setTimeout(() => {
        if (this.#moves.get(workspace.id) === state) {
          this.#moves.delete(workspace.id);
          this.#changed();
        }
      }, this.options.failedForMs ?? 30_000).unref?.();
      throw error;
    }
  }

  async #toCloud(
    workspace: Workspace,
    state: WorkspaceMoveState & { cancel: AbortController },
    stopWorking: boolean,
  ): Promise<WorkspaceMoveResult> {
    const { repositories, agents, cloud, config } = this.options;
    const sessions = this.#sessions(workspace).filter(
      (session) => !session.hostId,
    );
    const live = sessions.filter((session) => LIVE.includes(session.status));
    const cannot = live.filter(
      (session) =>
        session.kind === "agent" &&
        (session.provider !== "claude" ||
          !UUID.test(session.providerSessionId ?? "")),
    );
    if (cannot.length)
      return this.#answer(workspace, {
        status: "needsStopped",
        sessions: cannot.map(nameOf),
      });
    const asking = await this.#asking(live, stopWorking);
    if (asking) return this.#answer(workspace, asking);
    // Codex and custom sessions stay this Mac's rows; they cannot run there.
    const folders = new Map(
      sessions
        .filter((session) => isClaude(session) || session.kind === "terminal")
        .map((session) => [
          session.id,
          inside(workspace.path, session.workingDirectory),
        ]),
    );

    const trees = await this.#macTrees(workspace);
    const skip = new Set(trees.map((tree) => tree.path));
    const files = await listMacFiles(workspace.path, skip);
    // The metadata the session instructions point to goes along.
    const metadata = await stat(join(workspace.path, WORKSPACE_METADATA)).catch(
      () => undefined,
    );
    if (metadata?.isFile())
      files.push({ path: WORKSPACE_METADATA, bytes: metadata.size });
    const fileBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    if (fileBytes > MAX_FILES_BYTES)
      return this.#answer(workspace, {
        status: "needsSmaller",
        items: [
          {
            what: "Files outside git",
            bytes: fileBytes,
            maxBytes: MAX_FILES_BYTES,
          },
        ],
      });

    this.#update(state, { detail: "Starting the cloud workspace" });
    const hostId = await cloud.prepareForSession(workspace.id);
    const pod = this.#pod(hostId);

    const stopped = await this.#stopAll(live, state, stopWorking);
    await this.options.terminals.closeInside(workspace.path);
    const localScratch = this.#localScratch(workspace.id);
    try {
      this.#update(state, { phase: "copying", detail: undefined });
      await rm(localScratch, { recursive: true, force: true });
      await mkdir(localScratch, { recursive: true, mode: 0o700 });
      await must(pod, ".", "mkdir", ["-p", "--", POD_SCRATCH]);
      const record: WorkspaceMoveRecord = { sessions: {}, branches: {} };
      let total = 0;

      // Git: every worktree into the pod's library for its repository.
      const marks: { tree: Tree; work: string; mac: string }[] = [];
      for (const [repository, group] of byRepository(trees)) {
        const library = podLibrary(repository);
        if (!(await isRepository(pod, library)))
          await must(pod, ".", "git", [
            "init",
            "--bare",
            "--quiet",
            "--",
            pod.absolute(library),
          ]);
        await this.#clearPodTrees(pod, library, group);
        const bases = await lastCommits(pod, library);
        let bytes = 0;
        for (const tree of group) {
          this.#update(state, { detail: `Copying ${tree.path}` });
          const mac = join(workspace.path, tree.path);
          const snapshot = await snapshotRepository(this.#local, mac);
          const bundle = join(localScratch, `${tree.key}.bundle`);
          await writeBundle(
            this.#local,
            mac,
            tree.key,
            snapshot,
            bases,
            bundle,
          );
          const size = Bun.file(bundle).size;
          bytes += size;
          total += size;
          if (bytes > MAX_REPOSITORY_BYTES)
            throw new TooBigError([
              {
                what: repository.name,
                bytes,
                maxBytes: MAX_REPOSITORY_BYTES,
              },
            ]);
          if (total > MAX_MOVE_BYTES)
            throw new TooBigError([
              { what: "The move", bytes: total, maxBytes: MAX_MOVE_BYTES },
            ]);
          const podBundle = `${POD_SCRATCH}/${tree.key}.bundle`;
          await pod.writeFile(
            podBundle,
            new Uint8Array(await Bun.file(bundle).arrayBuffer()),
          );
          const fetched = await fetchBundle(pod, library, tree.key, podBundle);
          sameSnapshot(fetched, snapshot);
          const previous = await this.#podTree(pod, library, tree, fetched);
          await applySnapshot(pod, tree.path, tree.branch, fetched, previous);
          bases.push(fetched.head);
          if (tree.branch) record.branches[tree.key] = tree.branch;
          marks.push({ tree, work: snapshot.work, mac });
        }
      }

      // The other files, replacing the pod's.
      this.#update(state, { detail: "Copying the workspace's files" });
      const archive = join(localScratch, "files.tar");
      await packMac(this.#local, workspace.path, files, archive);
      const archiveBytes = Bun.file(archive).size;
      if (archiveBytes > MAX_FILES_BYTES)
        throw new TooBigError([
          {
            what: "Files outside git",
            bytes: archiveBytes,
            maxBytes: MAX_FILES_BYTES,
          },
        ]);
      const podArchive = `${POD_SCRATCH}/files.tar`;
      await pod.writeFile(
        podArchive,
        new Uint8Array(await Bun.file(archive).arrayBuffer()),
      );
      await unpackInPod(pod, skip, podArchive);
      // Daedalus's own session instructions name the folder's paths: the
      // pod gets them for its own.
      const macInstructions = sessionInstructionsTemplate(workspace.path);
      for (const { path } of files)
        if (
          SESSION_INSTRUCTIONS.test(path) &&
          (await readFile(join(workspace.path, path), "utf8").catch(
            () => undefined,
          )) === macInstructions
        )
          await pod.writeFile(
            path,
            new TextEncoder().encode(podSessionInstructions()),
          );

      // Every Claude conversation, its folders rewritten for the pod.
      this.#update(state, { detail: "Copying the conversations" });
      const modes = new Map<string, ClaudePermissionMode>();
      for (const session of sessions) {
        if (!isClaude(session)) continue;
        const folder = folders.get(session.id)!;
        const transcript = await this.#readOptional(
          this.#local,
          agents.claudeProjectsDirectory(session),
          claudeProjectKey(session.workingDirectory),
          session.providerSessionId!,
        );
        const sent: SentTranscriptFile[] = [];
        if (transcript) {
          const main = transcript.files[0]!;
          const text = new TextDecoder().decode(main.contents);
          modes.set(
            session.id,
            lastPermissionMode(text) ?? this.#defaultPermissionMode(),
          );
          const podFolder = podWorkingDirectory(folder);
          const podTranscript = withMain(
            transcript,
            rewriteTranscript(text, {
              from: session.workingDirectory,
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
          transcript.files.forEach((file, index) =>
            sent.push(
              sentFile(
                file.path,
                file.contents,
                podTranscript.files[index]!.contents,
              ),
            ),
          );
        }
        record.sessions[session.id] = {
          macWorkingDirectory: session.workingDirectory,
          transcript: sent,
        };
      }

      // Both sides now agree; the move home checks against this.
      for (const { tree, work, mac } of marks) {
        await markLast(pod, tree.path, tree.key, work);
        await markLast(this.#local, mac, tree.key, work);
      }
      await this.#saveRecord(workspace.id, record);

      repositories.setWorkspacePlace(
        workspace.id,
        { place: "cloud", notice: null },
        [...folders].map(([id, workingDirectory]) => ({
          id,
          hostId,
          workingDirectory,
        })),
      );

      this.#update(state, { phase: "starting", detail: undefined });
      const failed: string[] = [];
      for (const session of stopped) {
        const folder = folders.get(session.id);
        if (folder === undefined) continue;
        try {
          const permissionMode =
            session.kind === "agent" ? modes.get(session.id) : undefined;
          await agents.resumeAfterMove(
            { ...session, hostId, workingDirectory: folder },
            permissionMode ? { permissionMode } : {},
          );
        } catch (error) {
          failed.push(`${session.name}: ${messageOf(error)}`);
        }
      }
      return {
        status: "moved",
        workspace: await this.options.workspaces.getActive(workspace.id),
        ...(failed.length
          ? { notice: `Did not start in the cloud: ${failed.join("; ")}` }
          : {}),
      };
    } catch (error) {
      await this.#resumeWhereTheyWere(stopped, error);
      if (error instanceof TooBigError)
        return this.#answer(workspace, {
          status: "needsSmaller",
          items: error.items,
        });
      throw error;
    } finally {
      await rm(localScratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await pod.remove(POD_SCRATCH).catch(() => undefined);
    }
  }

  async #toMac(
    workspace: Workspace,
    state: WorkspaceMoveState & { cancel: AbortController },
    approved: string[],
    stopWorking: boolean,
  ): Promise<WorkspaceMoveResult> {
    const { repositories, agents, cloud } = this.options;
    const cloudId = repositories.cloudWorkspaceId(workspace.id);
    if (!cloudId)
      throw new DaedalusError(
        "CONFLICT",
        "This workspace's cloud copy is not linked to the account this Mac is signed in to",
      );
    this.#update(state, { detail: "Waking the cloud workspace" });
    const hostId = await cloud.prepareForSession(workspace.id);
    if (cloudHostWorkspace(hostId) !== cloudId)
      throw new DaedalusError(
        "CONFLICT",
        "The cloud workspace is no longer this workspace's",
      );
    const pod = this.#pod(hostId);
    const record = (await this.#record(workspace.id)) ?? {
      sessions: {},
      branches: {},
    };
    const sessions = this.#sessions(workspace).filter(
      (session) => session.hostId === hostId,
    );
    const live = sessions.filter((session) => LIVE.includes(session.status));
    const asking = await this.#asking(live, stopWorking);
    if (asking) return this.#answer(workspace, asking);

    const trees = await this.#podTrees(workspace, pod, record);
    // A repository's reference checkout is read-only: this Mac's stays.
    const skip = new Set([
      ...trees.map((tree) => tree.path),
      ...this.#referencePaths(workspace),
    ]);

    // Asked before anything stops: what in the pod would steer an agent or
    // run on this Mac. Checked again on what arrives.
    const allowed = new Set(approved);
    const steering = new Set<string>();
    for (const tree of trees) {
      const base = await this.#base(tree, pod);
      const now = await snapshotRepository(pod, tree.path);
      for (const path of await steeringIn(pod, tree.path, base, now))
        steering.add(`${tree.path}/${path}`);
    }
    // The pod's find compares names exactly; this Mac folds them.
    const podFiles = (await listPodFiles(pod, skip)).filter(
      (path) => safeWorkspacePath(path) && !insideFolders(path, skip),
    );
    const hashes = await podHashes(pod, podFiles.filter(steersAgent));
    // Daedalus's own session instructions, as the pod got them, come home
    // as this Mac's: nothing to ask about.
    const podInstructions = sha256(
      new TextEncoder().encode(podSessionInstructions()),
    );
    for (const [path, hash] of hashes)
      if (SESSION_INSTRUCTIONS.test(path) && hash === podInstructions)
        hashes.delete(path);
    for (const path of await changedSteering(workspace.path, hashes))
      steering.add(path);
    const unapproved = [...steering].filter((path) => !allowed.has(path));
    if (unapproved.length)
      return this.#answer(workspace, {
        status: "needsApproval",
        paths: unapproved.sort(),
      });

    const stopped = await this.#stopAll(live, state, stopWorking);
    const localScratch = this.#localScratch(workspace.id);
    try {
      this.#update(state, { phase: "copying", detail: undefined });
      await rm(localScratch, { recursive: true, force: true });
      await mkdir(localScratch, { recursive: true, mode: 0o700 });
      await must(pod, ".", "mkdir", ["-p", "--", POD_SCRATCH]);
      let total = 0;

      // Git: each worktree's snapshot into this Mac's library, checked.
      const received: { tree: Tree; snapshot: RepositorySnapshot }[] = [];
      for (const [repository, group] of byRepository(trees)) {
        const library = repository.canonicalPath;
        const bases = [
          ...(await lastCommits(this.#local, library)),
          ...(await this.#macBase(repository).then(
            (base) => [base],
            () => [],
          )),
        ];
        let bytes = 0;
        for (const tree of group) {
          this.#update(state, { detail: `Copying ${tree.path}` });
          const snapshot = await snapshotRepository(pod, tree.path);
          const podBundle = `${POD_SCRATCH}/${tree.key}.bundle`;
          await writeBundle(
            pod,
            tree.path,
            tree.key,
            snapshot,
            bases,
            podBundle,
          );
          const contents = await pod.readFile(podBundle);
          if (!contents)
            throw new DaedalusError(
              "DEPENDENCY",
              "The cloud workspace wrote no bundle",
            );
          bytes += contents.length;
          total += contents.length;
          if (bytes > MAX_REPOSITORY_BYTES)
            throw new TooBigError([
              {
                what: repository.name,
                bytes,
                maxBytes: MAX_REPOSITORY_BYTES,
              },
            ]);
          if (total > MAX_MOVE_BYTES)
            throw new TooBigError([
              { what: "The move", bytes: total, maxBytes: MAX_MOVE_BYTES },
            ]);
          const bundle = join(localScratch, `${tree.key}.bundle`);
          await this.#local.writeFile(bundle, contents);
          const fetched = await fetchBundle(
            this.#local,
            library,
            tree.key,
            bundle,
          );
          for (const commit of [fetched.head, fetched.index, fetched.work]) {
            const collisions = await caseCollisions(
              this.#local,
              library,
              commit,
            );
            if (collisions.length)
              throw new DaedalusError(
                "CONFLICT",
                `The cloud copy of ${tree.path} has names that differ only in case, which this Mac cannot hold apart: ${collisions.slice(0, 5).join(", ")}`,
              );
          }
          const base = await this.#base(tree, this.#local, library);
          for (const path of await steeringIn(
            this.#local,
            library,
            base,
            fetched,
          ))
            if (!allowed.has(`${tree.path}/${path}`))
              throw new DaedalusError(
                "CONFLICT",
                `${tree.path}/${path} changed in the cloud after it was approved; move the workspace again`,
              );
          bases.push(fetched.head);
          received.push({ tree, snapshot: fetched });
        }
      }

      // The other files, checked in a scratch folder.
      this.#update(state, { detail: "Copying the workspace's files" });
      const podArchive = `${POD_SCRATCH}/files.tar`;
      await packInPod(pod, podFiles, podArchive);
      const archiveBytes = Number(
        /^\s*(\d+)/.exec(
          await must(pod, ".", "wc", ["-c", "--", podArchive]),
        )?.[1] ?? Number.NaN,
      );
      if (!(archiveBytes <= MAX_FILES_BYTES))
        throw new TooBigError([
          {
            what: "Files outside git",
            bytes: archiveBytes,
            maxBytes: MAX_FILES_BYTES,
          },
        ]);
      const contents = await pod.readFile(podArchive);
      if (!contents)
        throw new DaedalusError(
          "DEPENDENCY",
          "The cloud workspace wrote no archive of its files",
        );
      const archive = join(localScratch, "files.tar");
      await this.#local.writeFile(archive, contents);
      const unpacked = join(localScratch, "files");
      await mkdir(unpacked, { recursive: true, mode: 0o700 });
      const arrived = await unpackFromPod(this.#local, archive, unpacked, {
        expected: new Set(podFiles),
        skip,
        maxBytes: MAX_FILES_BYTES,
      });
      const macInstructions = sessionInstructionsTemplate(workspace.path);
      // Daedalus's own, as the approval left them out: a session born in the
      // cloud has no copy here to compare with.
      const own = new Set<string>();
      for (const path of arrived)
        if (
          SESSION_INSTRUCTIONS.test(path) &&
          (await readFile(join(unpacked, path), "utf8")) ===
            podSessionInstructions()
        ) {
          await writeFile(join(unpacked, path), macInstructions);
          own.add(path);
        }
      for (const path of arrived)
        if (
          steersAgent(path) &&
          !allowed.has(path) &&
          !own.has(path) &&
          !(await sameFile(join(workspace.path, path), join(unpacked, path)))
        )
          throw new DaedalusError(
            "CONFLICT",
            `${path} changed in the cloud after it was approved; move the workspace again`,
          );

      // Every Claude conversation: the pod may only add to what was sent.
      this.#update(state, { detail: "Copying the conversations" });
      const conversations: {
        session: AgentSession;
        projects: string;
        key: string;
        files: TranscriptFiles;
      }[] = [];
      // Sessions that never had a turn: nothing to resume on this Mac.
      const fresh = new Set<string>();
      for (const session of sessions) {
        if (!isClaude(session)) continue;
        const macFolder = macPath(workspace, session.workingDirectory);
        const sent = record.sessions[session.id];
        if (sent && sent.macWorkingDirectory !== macFolder)
          throw new DaedalusError(
            "CONFLICT",
            `${session.name}'s folder in the cloud is not the one it left this Mac from`,
          );
        const podFolder = podWorkingDirectory(session.workingDirectory);
        const transcript = await this.#readOptional(
          pod,
          POD_PROJECTS,
          claudeProjectKey(podFolder),
          session.providerSessionId!,
        );
        if (!transcript) {
          if (sent?.transcript.length)
            throw new DaedalusError(
              "CONFLICT",
              `${session.name}'s conversation is no longer in the cloud workspace`,
            );
          fresh.add(session.id);
          continue;
        }
        const projects = agents.claudeProjectsDirectory(session);
        const key = claudeProjectKey(macFolder);
        const macCopies = new Map<string, Uint8Array | undefined>();
        for (const file of sent?.transcript ?? [])
          macCopies.set(
            file.path,
            await this.#local.readFile(
              join(projects, key, ...file.path.split("/")),
            ),
          );
        conversations.push({
          session,
          projects,
          key,
          files: appendedTranscript({
            pod: transcript,
            sent: sent?.transcript ?? [],
            mac: (path) => macCopies.get(path),
            rewrite: (text) =>
              rewriteTranscript(text, {
                from: podFolder,
                to: macFolder,
                permissionMode: MOVED_HOME_PERMISSION_MODE,
                strict: true,
              }),
          }),
        });
      }

      // Nothing in the workspace folder changed until here.
      this.#update(state, { detail: "Laying the workspace down" });
      for (const { tree, snapshot } of received) {
        const mac = join(workspace.path, tree.path);
        const previous = await this.#macTree(tree, mac, snapshot);
        await applySnapshot(this.#local, mac, tree.branch, snapshot, previous);
      }
      await applyFromPod(
        workspace.path,
        unpacked,
        arrived,
        await listMacFiles(workspace.path, skip),
        skip,
      );
      for (const { projects, key, files } of conversations)
        await writeTranscript(this.#local, projects, key, files);
      for (const { tree, snapshot } of received) {
        await markLast(
          this.#local,
          join(workspace.path, tree.path),
          tree.key,
          snapshot.work,
        );
        await markLast(pod, tree.path, tree.key, snapshot.work);
      }

      const moving = sessions.map((session) => ({
        id: session.id,
        hostId: null,
        workingDirectory: macPath(workspace, session.workingDirectory),
      }));
      repositories.setWorkspacePlace(
        workspace.id,
        { place: "mac", notice: null },
        moving,
      );
      await rm(this.#recordPath(workspace.id), { force: true });

      this.#update(state, { phase: "starting", detail: undefined });
      const failed: string[] = [];
      for (const session of stopped)
        try {
          await agents.resumeAfterMove(
            {
              ...session,
              hostId: null,
              workingDirectory: macPath(workspace, session.workingDirectory),
            },
            session.kind === "agent"
              ? {
                  permissionMode: MOVED_HOME_PERMISSION_MODE,
                  fresh: fresh.has(session.id),
                }
              : {},
          );
        } catch (error) {
          failed.push(`${session.name}: ${messageOf(error)}`);
        }
      // A cloud copy exists only while its workspace is in the cloud: the
      // gateway counts every copy against the account's limit. One the
      // gateway would not delete now goes in the next orphan cleanup.
      await cloud.delete(workspace.id).catch(() => undefined);
      return {
        status: "moved",
        workspace: await this.options.workspaces.getActive(workspace.id),
        notice: [
          MOVED_HOME_NOTICE,
          ...(failed.length
            ? [`Did not start on this Mac: ${failed.join("; ")}`]
            : []),
        ].join(" "),
      };
    } catch (error) {
      await this.#resumeWhereTheyWere(stopped, error);
      if (error instanceof TooBigError)
        return this.#answer(workspace, {
          status: "needsSmaller",
          items: error.items,
        });
      throw error;
    } finally {
      await rm(localScratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await pod.remove(POD_SCRATCH).catch(() => undefined);
    }
  }

  /**
   * The workspace's sessions: a move takes every one, archived ones too, so
   * a session restored later finds its conversation where the workspace is.
   */
  #sessions(workspace: Workspace): AgentSession[] {
    return this.options.repositories.listAgents({ workspaceId: workspace.id });
  }

  /**
   * Sessions whose turn will not end on its own: they wait on the user.
   * Working ones are waited for instead.
   */
  async #asking(
    live: AgentSession[],
    stopWorking: boolean,
  ): Promise<WorkspaceMoveResult | undefined> {
    if (stopWorking) return undefined;
    const waiting: AgentSession[] = [];
    for (const session of live)
      if ((await this.options.activity(session.id)) === "needs_permission")
        waiting.push(session);
    return waiting.length
      ? { status: "busy", sessions: waiting.map(nameOf) }
      : undefined;
  }

  /** The worktrees on this Mac a move to the cloud carries. */
  async #macTrees(workspace: Workspace): Promise<Tree[]> {
    const { repositories } = this.options;
    const attached = repositories
      .listWorkspaceRepositories(workspace.id)
      .filter((repository) => repository.status === "ready");
    const trees: Tree[] = [];
    const add = async (
      key: string,
      repository: WorkspaceRepository,
      absolute: string,
      detached: boolean,
    ) => {
      if (!(await pathExists(absolute))) return;
      if (!(await isRepository(this.#local, absolute))) return;
      const branch = detached
        ? undefined
        : (
            await this.#local.run(absolute, "git", ["branch", "--show-current"])
          ).stdout.trim() || undefined;
      trees.push({
        key,
        repository,
        path: inside(workspace.path, absolute),
        ...(branch ? { branch } : {}),
      });
    };
    for (const repository of attached)
      if (repository.referencePath)
        await add(
          referenceKey(repository),
          repository,
          repository.referencePath,
          true,
        );
    for (const worktree of repositories.listSessionWorktrees({
      workspaceId: workspace.id,
    })) {
      const repository = attached.find(
        (item) => item.id === worktree.repositoryId,
      );
      if (repository)
        await add(worktree.sessionId, repository, worktree.path, false);
    }
    return trees;
  }

  /** Where the workspace's repositories have their reference checkouts. */
  #referencePaths(workspace: Workspace): string[] {
    return this.options.repositories
      .listWorkspaceRepositories(workspace.id)
      .flatMap((repository) =>
        repository.referencePath
          ? [inside(workspace.path, repository.referencePath)]
          : [],
      );
  }

  /**
   * The session worktrees in the pod a move home carries: those this Mac
   * knows of, on the branch this Mac recorded, never one the pod names.
   */
  async #podTrees(
    workspace: Workspace,
    pod: PodMoveSide,
    record: WorkspaceMoveRecord,
  ): Promise<Tree[]> {
    const { repositories } = this.options;
    const attached = repositories
      .listWorkspaceRepositories(workspace.id)
      .filter((repository) => repository.status === "ready");
    const trees: Tree[] = [];
    const add = async (tree: Tree) => {
      if (await this.#linkedInPod(pod, tree)) trees.push(tree);
    };
    for (const worktree of repositories.listSessionWorktrees({
      workspaceId: workspace.id,
    })) {
      const repository = attached.find(
        (item) => item.id === worktree.repositoryId,
      );
      if (repository)
        await add({
          key: worktree.sessionId,
          repository,
          path: inside(workspace.path, worktree.path),
          branch: record.branches[worktree.sessionId] ?? worktree.branchName,
        });
    }
    return trees;
  }

  /** Whether a pod folder is a worktree of the pod's library for its repository. */
  async #linkedInPod(pod: PodMoveSide, tree: Tree): Promise<boolean> {
    if (!(await isRepository(pod, tree.path))) return false;
    const library = podLibrary(tree.repository);
    if (!(await isRepository(pod, library))) return false;
    // Both as git resolves them, links and all.
    const commonDir = async (dir: string) =>
      (
        await pod.run(dir, "git", [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).stdout.trim();
    const common = await commonDir(tree.path);
    return common !== "" && common === (await commonDir(library));
  }

  /**
   * Removes the pod's worktrees of `library` this move does not carry, and
   * detaches the rest, so no branch is held where another tree needs it.
   */
  async #clearPodTrees(
    pod: PodMoveSide,
    library: string,
    trees: Tree[],
  ): Promise<void> {
    const listing = await must(pod, library, "git", [
      "worktree",
      "list",
      "--porcelain",
    ]);
    // git lists worktrees by their real paths.
    const root = await must(pod, ".", "pwd", ["-P"]);
    const keep = new Set(trees.map((tree) => tree.path));
    for (const line of listing.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice("worktree ".length);
      const rel = path.startsWith(`${root}/`)
        ? path.slice(root.length + 1)
        : undefined;
      if (rel === undefined || rel.startsWith(".daedalus/")) continue;
      if (keep.has(rel))
        await pod
          .run(rel, "git", ["checkout", "--quiet", "--detach"])
          .catch(() => undefined);
      else
        await pod.run(library, "git", ["worktree", "remove", "--force", path]);
    }
    await pod.run(library, "git", ["worktree", "prune"]);
  }

  /**
   * Makes the pod's worktree for `tree` if it has none of the library's, and
   * returns the working tree both sides last agreed on, if it has one.
   */
  async #podTree(
    pod: PodMoveSide,
    library: string,
    tree: Tree,
    snapshot: RepositorySnapshot,
  ): Promise<string | undefined> {
    if (await this.#linkedInPod(pod, tree))
      return resolveRef(pod, tree.path, lastRef(tree.key));
    await pod.remove(tree.path);
    await must(pod, ".", "mkdir", ["-p", "--", dirname(tree.path)]);
    await must(pod, library, "git", [
      "worktree",
      "add",
      "--force",
      "--detach",
      pod.absolute(tree.path),
      snapshot.head,
    ]);
    return undefined;
  }

  /**
   * The same on this Mac: a worktree the cloud made gets one of the Mac's
   * library; a folder there that is anything else is never replaced.
   */
  async #macTree(
    tree: Tree,
    mac: string,
    snapshot: RepositorySnapshot,
  ): Promise<string | undefined> {
    if (await pathExists(mac)) {
      if (!(await isRepository(this.#local, mac)))
        throw new DaedalusError(
          "CONFLICT",
          `${tree.path} on this Mac is not a git worktree, so the cloud's copy cannot replace it`,
        );
      return resolveRef(this.#local, mac, lastRef(tree.key));
    }
    await mkdir(dirname(mac), { recursive: true });
    await must(this.#local, ".", "git", [
      ...librarySource(tree.repository),
      "worktree",
      "add",
      "--force",
      "--detach",
      mac,
      snapshot.head,
    ]);
    return undefined;
  }

  /**
   * What a pod worktree's steering files are compared with: the working
   * tree both sides last agreed on, or for a worktree the cloud made, the
   * repository's base on this Mac.
   */
  async #base(tree: Tree, side: MoveSide, dir = tree.path): Promise<string> {
    const last = await resolveRef(
      this.#local,
      tree.repository.canonicalPath,
      lastRef(tree.key),
    );
    const base = last ?? (await this.#macBase(tree.repository).catch(() => ""));
    if (
      base &&
      (await side.run(dir, "git", ["cat-file", "-e", `${base}^{commit}`]))
        .exitCode === 0
    )
      return base;
    return EMPTY_TREE;
  }

  async #macBase(repository: WorkspaceRepository): Promise<string> {
    return must(this.#local, repository.canonicalPath, "git", [
      "rev-parse",
      "--verify",
      `${repository.baseCommit ?? repository.baseBranch ?? "HEAD"}^{commit}`,
    ]);
  }

  async #readOptional(
    side: MoveSide,
    projects: string,
    key: string,
    conversationId: string,
  ): Promise<TranscriptFiles | undefined> {
    if (
      !(await side.readFile(
        side.join(projects, key, `${conversationId}.jsonl`),
      ))
    )
      return undefined;
    return readTranscript(
      side,
      projects,
      key,
      conversationId,
      MAX_TRANSCRIPT_BYTES,
    );
  }

  #pod(hostId: string): PodMoveSide {
    const host = this.options.hosts.get(hostId);
    if (!isPodAccess(host))
      throw new DaedalusError(
        "DEPENDENCY",
        "The cloud workspace cannot take files from this Mac",
      );
    return new PodMoveSide(host, MAX_REPOSITORY_BYTES, this.options.podRoot);
  }

  /**
   * Waits for every working session's turn to end (or not, with
   * `stopWorking`), then stops every live one.
   */
  async #stopAll(
    live: AgentSession[],
    state: WorkspaceMoveState & { cancel: AbortController },
    stopWorking: boolean,
  ): Promise<AgentSession[]> {
    if (!stopWorking && live.length) {
      const deadline = Date.now() + (this.options.turnTimeoutMs ?? 30 * 60_000);
      for (;;) {
        const working: AgentSession[] = [];
        for (const session of live) {
          const activity = await this.options.activity(session.id);
          if (activity === "working" || activity === "needs_permission")
            working.push(session);
        }
        if (!working.length) break;
        this.#update(state, {
          phase: "waiting",
          detail:
            working.length === 1
              ? `Waiting for ${working[0]!.name} to end its turn`
              : `Waiting for ${working.length} sessions to end their turns`,
        });
        if (state.cancel.signal.aborted)
          throw new DaedalusError("CONFLICT", "The move was cancelled");
        if (Date.now() > deadline)
          throw new DaedalusError(
            "CONFLICT",
            "Sessions in this workspace did not end their turns; move it again when they are idle, or stop them",
          );
        await Bun.sleep(this.options.pollMs ?? 1_000);
      }
    }
    if (state.cancel.signal.aborted)
      throw new DaedalusError("CONFLICT", "The move was cancelled");
    this.#update(state, { phase: "stopping", detail: undefined });
    const stopped: AgentSession[] = [];
    try {
      for (const session of live)
        stopped.push(await this.options.agents.stopForMove(session.id));
    } catch (error) {
      await this.#resumeWhereTheyWere(stopped, error);
      throw error;
    }
    return stopped;
  }

  /** After a failed move: every session runs where it was, as it was. */
  async #resumeWhereTheyWere(
    stopped: AgentSession[],
    cause: unknown,
  ): Promise<void> {
    const failed: string[] = [];
    for (const session of stopped) {
      const current = this.options.repositories.findAgent(session.id);
      if (current && LIVE.includes(current.status)) continue;
      try {
        await this.options.agents.resumeAfterMove(session);
      } catch (error) {
        failed.push(`${session.name}: ${messageOf(error)}`);
      }
    }
    if (failed.length)
      throw new DaedalusError(
        "DEPENDENCY",
        `${messageOf(cause)}; these sessions did not start again where they were: ${failed.join("; ")}`,
      );
  }

  /** An answer that changes nothing: the move is over. */
  #answer(
    workspace: Workspace,
    result: WorkspaceMoveResult,
  ): WorkspaceMoveResult {
    this.#moves.delete(workspace.id);
    this.#changed();
    return result;
  }

  #defaultPermissionMode(): ClaudePermissionMode {
    return this.options.config.agents.claude?.permissionMode === "inherit"
      ? "default"
      : "auto";
  }

  #localScratch(workspaceId: string): string {
    return join(
      this.options.config.home,
      "tmp",
      "workspace-moves",
      workspaceId,
    );
  }

  #recordPath(workspaceId: string): string {
    return join(
      this.options.config.home,
      "workspace-moves",
      `${encodeURIComponent(workspaceId)}.json`,
    );
  }

  async #record(workspaceId: string): Promise<WorkspaceMoveRecord | undefined> {
    try {
      const value = JSON.parse(
        await readFile(this.#recordPath(workspaceId), "utf8"),
      ) as Partial<WorkspaceMoveRecord>;
      const sessions = value.sessions;
      const branches = value.branches;
      if (
        typeof sessions !== "object" ||
        sessions === null ||
        typeof branches !== "object" ||
        branches === null ||
        !Object.values(branches).every((branch) => typeof branch === "string")
      )
        return undefined;
      for (const entry of Object.values(sessions))
        if (
          typeof entry?.macWorkingDirectory !== "string" ||
          !isAbsolute(entry.macWorkingDirectory) ||
          !Array.isArray(entry.transcript) ||
          !entry.transcript.every(
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
      return { sessions, branches };
    } catch {
      return undefined;
    }
  }

  async #saveRecord(
    workspaceId: string,
    record: WorkspaceMoveRecord,
  ): Promise<void> {
    await writeFileAtomic(
      this.#recordPath(workspaceId),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600, ensureDir: true },
    );
  }

  #update(
    state: WorkspaceMoveState,
    change: Partial<WorkspaceMoveState>,
  ): void {
    Object.assign(state, change);
    for (const key of ["detail", "message"] as const)
      if (state[key] === undefined) delete state[key];
    this.#changed();
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** git's empty tree: what a worktree with no base on this Mac starts from. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A session folder's instruction file, which Daedalus writes. */
const SESSION_INSTRUCTIONS = /^worktrees\/[^/]+\/[^/]+\/AGENTS\.md$/;
/** The workspace's metadata, which the pod gets but never sends back. */
const WORKSPACE_METADATA = ".daedalus/workspace.json";

const referenceKey = (repository: WorkspaceRepository): string =>
  `ref-${repository.id}`;

/** How git names this Mac's library of a repository. */
const librarySource = (repository: WorkspaceRepository): string[] =>
  repository.libraryRepositoryId
    ? ["--git-dir", repository.canonicalPath]
    : ["-C", repository.canonicalPath];

const isClaude = (session: AgentSession): boolean =>
  session.kind === "agent" &&
  session.provider === "claude" &&
  UUID.test(session.providerSessionId ?? "");

const nameOf = (session: AgentSession): MoveSessionName => ({
  id: session.id,
  name: session.name,
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function byRepository(trees: Tree[]): Map<WorkspaceRepository, Tree[]> {
  const groups = new Map<WorkspaceRepository, Tree[]>();
  for (const tree of trees) {
    const group = groups.get(tree.repository) ?? [];
    group.push(tree);
    groups.set(tree.repository, group);
  }
  return groups;
}

/** The commits a side's library last agreed on, for any worktree. */
async function lastCommits(side: MoveSide, library: string): Promise<string[]> {
  const result = await side.run(library, "git", [
    "for-each-ref",
    "--format=%(objectname)",
    "refs/daedalus/moves/",
  ]);
  return result.exitCode === 0
    ? [...new Set(result.stdout.split("\n").filter(Boolean))]
    : [];
}

/** Paths that steer an agent and differ from `base`, links among them. */
async function steeringIn(
  side: MoveSide,
  dir: string,
  base: string,
  now: RepositorySnapshot,
): Promise<string[]> {
  const paths = new Set<string>();
  for (const commit of [now.head, now.index, now.work])
    for (const path of await changedPaths(side, dir, base, commit))
      if (steersAgent(path)) paths.add(path);
  for (const commit of [now.head, now.index, now.work])
    for (const path of await changedLinks(side, dir, base, commit))
      paths.add(`${path} (symbolic link)`);
  return [...paths];
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

/** A session's folder on this Mac from its folder in the pod. */
function macPath(workspace: Workspace, folder: string): string {
  if (isAbsolute(folder)) return folder;
  const path = join(workspace.path, folder);
  inside(workspace.path, path);
  return path;
}

/** Whether two files hold the same bytes; false when `a` is missing. */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    readFile(a).catch(() => undefined),
    readFile(b),
  ]);
  if (!left) return false;
  return Buffer.compare(left, right) === 0;
}

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

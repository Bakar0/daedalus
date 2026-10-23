import { mkdir, rm } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { findExecutable, runCommand } from "@daedalus/platform";
import type {
  AgentSession,
  SessionWorktree,
  Workspace,
  WorkspaceRepository,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { DaedalusConfig } from "../config";
import { GIT_NETWORK_ENVIRONMENT } from "./git-commands";
import { publishedBranchName } from "./git-status-monitor";
import {
  isPodAccess,
  LocalMoveSide,
  must,
  PodMoveSide,
  type MoveSide,
} from "./move-side";
import { requireReady } from "./repository-library";
import type { SessionHosts } from "./session-hosts";
import type { WorkspaceService } from "./workspaces";

/** A bundle of one branch, which this Mac holds in memory while it travels. */
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const POD_SCRATCH = ".daedalus-move";

export interface CloudWorktreesOptions {
  config: DaedalusConfig;
  repositories: SqliteRepositories;
  workspaces: WorkspaceService;
  hosts: SessionHosts;
  /** The pod's workspace root as commands see it; tests use a folder. */
  podRoot?: string;
}

/**
 * Session worktrees of a workspace in the cloud. Git runs in the pod,
 * against the pod's library of each repository (`.daedalus/library/<id>.git`,
 * as a workspace move makes it); the registry records each worktree at the
 * path it has relative to the workspace, as on this Mac. Pushing brings the
 * branch to this Mac as a bundle, checked, and pushes from here with this
 * Mac's credentials and hooks: the pod never has them.
 */
export class CloudWorktrees {
  readonly #local = new LocalMoveSide();

  constructor(private readonly options: CloudWorktreesOptions) {}

  async create(input: {
    session: AgentSession;
    repository: WorkspaceRepository;
    branch: string;
  }): Promise<SessionWorktree> {
    const { session, repository, branch } = input;
    requireReady(repository);
    if (repository.access !== "write")
      throw new DaedalusError(
        "CONFLICT",
        `Repository '${repository.name}' is attached as reference-only`,
      );
    const workspace = await this.options.workspaces.getActive(
      session.workspaceId,
    );
    const pod = this.#pod(session);
    const library = podLibrary(repository);
    await must(this.#local, ".", "git", [
      "check-ref-format",
      "--branch",
      branch,
    ]);
    if (branch === repository.baseBranch)
      throw new DaedalusError(
        "CONFLICT",
        `${branch} is the base branch; name a branch for the change`,
      );
    // Taken here or in the pod, it could not come home.
    const sides: [MoveSide, string][] = [
      [this.#local, repository.canonicalPath],
    ];
    if (await this.#isPodRepository(pod, library)) sides.push([pod, library]);
    for (const [side, dir] of sides)
      if (
        (
          await side.run(dir, "git", [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${branch}`,
          ])
        ).exitCode === 0
      )
        throw new DaedalusError(
          "CONFLICT",
          `A branch named '${branch}' already exists in ${repository.name}; choose another name`,
        );
    const base = await this.#sendBase(pod, repository);
    const path = posix.join(session.workingDirectory, repository.name);
    if (
      (await pod.run(".", "test", ["-e", path])).exitCode === 0 ||
      path.startsWith("..")
    )
      throw new DaedalusError(
        "CONFLICT",
        `${path} already exists in the cloud workspace`,
      );
    await must(pod, library, "git", [
      "worktree",
      "add",
      "-b",
      branch,
      pod.absolute(path),
      base,
    ]);
    const worktree: SessionWorktree = {
      sessionId: session.id,
      repositoryId: repository.id,
      path: join(workspace.path, path),
      branchName: branch,
      createdAt: new Date().toISOString(),
    };
    try {
      this.options.repositories.createSessionWorktree(worktree);
    } catch (error) {
      await pod
        .run(library, "git", [
          "worktree",
          "remove",
          "--force",
          pod.absolute(path),
        ])
        .catch(() => undefined);
      throw error;
    }
    return worktree;
  }

  async remove(input: {
    session: AgentSession;
    worktree: SessionWorktree;
    repository: WorkspaceRepository;
    force?: boolean;
  }): Promise<SessionWorktree> {
    const workspace = await this.options.workspaces.getActive(
      input.session.workspaceId,
    );
    const pod = this.#pod(input.session);
    const path = podPath(workspace, input.worktree.path);
    if (await this.#isPodRepository(pod, path))
      await must(pod, podLibrary(input.repository), "git", [
        "worktree",
        "remove",
        ...(input.force ? ["--force"] : []),
        pod.absolute(path),
      ]);
    this.options.repositories.deleteSessionWorktree(
      input.session.id,
      input.repository.id,
    );
    return input.worktree;
  }

  /**
   * Pushes the worktree's branch, as this Mac recorded it, never a name the
   * pod gives: its commits come here as a bundle, checked as everything
   * from the pod is, into a ref of this session's, and are pushed from this
   * Mac's library to the branch's upstream (or its own name) on origin.
   * Never forced.
   */
  async push(input: {
    session: AgentSession;
    worktree: SessionWorktree;
    repository: WorkspaceRepository;
  }): Promise<{ worktree: SessionWorktree; alreadyUpToDate: boolean }> {
    const { session, worktree, repository } = input;
    const branch = worktree.branchName;
    if (branch === repository.baseBranch)
      throw new DaedalusError(
        "CONFLICT",
        `The ${repository.name} working tree is on ${branch}; Daedalus only pushes a session's own branch`,
      );
    const workspace = await this.options.workspaces.getActive(
      session.workspaceId,
    );
    const pod = this.#pod(session);
    const path = podPath(workspace, worktree.path);
    const library = repository.canonicalPath;
    const incoming = `refs/daedalus/push/${session.id}`;
    const scratch = join(
      this.options.config.home,
      "tmp",
      "cloud-push",
      session.id,
    );
    const podBundle = `${POD_SCRATCH}/push-${session.id}.bundle`;
    try {
      const tip = (
        await must(pod, path, "git", [
          "rev-parse",
          "--verify",
          `refs/heads/${branch}^{commit}`,
        ])
      ).trim();
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tip))
        throw new DaedalusError(
          "DEPENDENCY",
          "git gave no commit for the branch",
        );
      const has = async (commit: string) =>
        (
          await this.#local.run(library, "git", [
            "cat-file",
            "-e",
            `${commit}^{commit}`,
          ])
        ).exitCode === 0;
      if (!(await has(tip))) {
        // What this Mac has, left out of the bundle when the pod has it too.
        const known = (
          await this.#local.run(library, "git", [
            "for-each-ref",
            "--format=%(objectname)",
            `refs/heads/${branch}`,
            `refs/remotes/origin/${branch}`,
            "refs/daedalus/",
          ])
        ).stdout
          .split("\n")
          .filter(Boolean);
        const bases: string[] = [];
        for (const commit of new Set(known))
          if (
            (
              await pod.run(path, "git", [
                "cat-file",
                "-e",
                `${commit}^{commit}`,
              ])
            ).exitCode === 0
          )
            bases.push(`^${commit}`);
        await must(pod, ".", "mkdir", ["-p", "--", POD_SCRATCH]);
        await must(pod, path, "git", [
          "bundle",
          "create",
          pod.absolute(podBundle),
          `refs/heads/${branch}`,
          ...bases,
        ]);
        const bytes = await pod.readFile(podBundle);
        if (!bytes)
          throw new DaedalusError(
            "DEPENDENCY",
            "The cloud workspace wrote no bundle",
          );
        await mkdir(scratch, { recursive: true, mode: 0o700 });
        const bundle = join(scratch, "branch.bundle");
        await this.#local.writeFile(bundle, bytes);
        await must(this.#local, library, "git", [
          "bundle",
          "verify",
          "--quiet",
          bundle,
        ]);
        await must(this.#local, library, "git", [
          "-c",
          "transfer.fsckObjects=true",
          "-c",
          "fetch.fsckObjects=true",
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          bundle,
          `+refs/heads/${branch}:${incoming}`,
        ]);
        // Only what the pod named for this branch, and nothing else.
        if ((await resolved(this.#local, library, incoming)) !== tip)
          throw new DaedalusError(
            "DEPENDENCY",
            "The cloud workspace sent a different commit from its branch",
          );
      }
      return await this.#pushFrom(library, branch, repository, worktree, tip);
    } finally {
      await this.#local
        .run(library, "git", ["update-ref", "-d", incoming])
        .catch(() => undefined);
      await rm(scratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await pod.remove(podBundle).catch(() => undefined);
    }
  }

  async #pushFrom(
    library: string,
    branch: string,
    repository: WorkspaceRepository,
    worktree: SessionWorktree,
    commit: string,
  ): Promise<{ worktree: SessionWorktree; alreadyUpToDate: boolean }> {
    const git = findExecutable("git");
    if (!git)
      throw new DaedalusError("DEPENDENCY", "git is not available on PATH");
    const destination =
      (await publishedBranchName(
        git,
        library,
        branch,
        repository.baseBranch,
      )) ?? branch;
    const result = await runCommand(
      git,
      ["push", "origin", `${commit}:refs/heads/${destination}`],
      { cwd: library, env: GIT_NETWORK_ENVIRONMENT },
    );
    if (result.exitCode !== 0)
      throw new DaedalusError(
        "CONFLICT",
        `Could not push ${branch}: ${(result.stderr || result.stdout).trim()}`,
      );
    // What origin has now, for the next push to leave out.
    await this.#local
      .run(library, "git", [
        "update-ref",
        `refs/remotes/origin/${destination}`,
        commit,
      ])
      .catch(() => undefined);
    return {
      worktree,
      alreadyUpToDate: /Everything up-to-date/i.test(
        `${result.stderr}\n${result.stdout}`,
      ),
    };
  }

  /**
   * The repository's base, as this Mac has it, in the pod's library: sent
   * as a bundle when the pod has not got it, the pod's library made first
   * for a repository attached after the move.
   */
  async #sendBase(
    pod: PodMoveSide,
    repository: WorkspaceRepository,
  ): Promise<string> {
    const library = podLibrary(repository);
    const base = await must(this.#local, repository.canonicalPath, "git", [
      "rev-parse",
      "--verify",
      `${repository.baseCommit ?? repository.baseBranch ?? "HEAD"}^{commit}`,
    ]);
    if (!(await this.#isPodRepository(pod, library)))
      await must(pod, ".", "git", [
        "init",
        "--bare",
        "--quiet",
        "--",
        pod.absolute(library),
      ]);
    if (
      (await pod.run(library, "git", ["cat-file", "-e", `${base}^{commit}`]))
        .exitCode === 0
    )
      return base;
    const ref = `refs/daedalus/base/${repository.id}`;
    const scratch = join(
      this.options.config.home,
      "tmp",
      "cloud-base",
      repository.id,
    );
    const podBundle = `${POD_SCRATCH}/base-${repository.id}.bundle`;
    try {
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      const bundle = join(scratch, "base.bundle");
      await must(this.#local, repository.canonicalPath, "git", [
        "update-ref",
        ref,
        base,
      ]);
      await must(this.#local, repository.canonicalPath, "git", [
        "bundle",
        "create",
        bundle,
        ref,
      ]);
      const file = Bun.file(bundle);
      if (file.size > MAX_BUNDLE_BYTES)
        throw new DaedalusError(
          "CONFLICT",
          `${repository.name} is ${file.size} bytes as a bundle; a cloud workspace takes at most ${MAX_BUNDLE_BYTES}`,
        );
      await pod.writeFile(podBundle, new Uint8Array(await file.arrayBuffer()));
      await must(pod, library, "git", [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        pod.absolute(podBundle),
        `+${ref}:${ref}`,
      ]);
      return base;
    } finally {
      await this.#local
        .run(repository.canonicalPath, "git", ["update-ref", "-d", ref])
        .catch(() => undefined);
      await rm(scratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await pod.remove(podBundle).catch(() => undefined);
    }
  }

  async #isPodRepository(pod: PodMoveSide, dir: string): Promise<boolean> {
    if ((await pod.run(".", "test", ["-d", dir])).exitCode !== 0) return false;
    return (
      (await pod.run(dir, "git", ["rev-parse", "--git-dir"])).exitCode === 0
    );
  }

  #pod(session: AgentSession): PodMoveSide {
    if (!session.hostId)
      throw new DaedalusError("CONFLICT", "This session runs on this Mac");
    const host = this.options.hosts.get(session.hostId);
    if (!isPodAccess(host))
      throw new DaedalusError(
        "DEPENDENCY",
        "The cloud workspace cannot take files from this Mac",
      );
    return new PodMoveSide(host, MAX_BUNDLE_BYTES, this.options.podRoot);
  }
}

/** The commit a ref names, or undefined. */
async function resolved(
  side: LocalMoveSide,
  dir: string,
  ref: string,
): Promise<string | undefined> {
  const result = await side.run(dir, "git", [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/** The pod's bare library for an attached repository. */
export const podLibrary = (repository: WorkspaceRepository): string =>
  `.daedalus/library/${repository.id}.git`;

/** A worktree's registry path as the pod's workspace-relative one. */
function podPath(workspace: Workspace, path: string): string {
  const rel = relative(workspace.path, path);
  if (!rel || rel.startsWith("..") || rel.startsWith("/"))
    throw new DaedalusError(
      "CONFLICT",
      `${path} is outside the workspace folder`,
    );
  return rel;
}

import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ensureDirectory,
  findExecutable,
  isPathInside,
  pathExists,
  removeDirectory,
  runCommand,
  standardExecutableFallbacks,
} from "@daedalus/platform";
import type {
  AgentSession,
  ChangedFile,
  SessionWorktree,
  WorkspaceRepository,
  WorktreeCommit,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import {
  checkedOutBranch,
  parsePorcelainStatus,
  parseChangedFiles,
  publishedBranchName,
  pullRequestAnswerHoldsHead,
  type GitStatusMonitor,
} from "./git-status-monitor";
import {
  GH_EXECUTABLE_FALLBACKS,
  GIT_NETWORK_ENVIRONMENT,
} from "./git-commands";
import { requireReady, type RepositoryLibrary } from "./repository-library";
import type { WorkspaceFiles } from "./workspace-files";
import type { WorkspaceService } from "./workspaces";

const isAtOrInside = (folder: string, path: string): boolean =>
  resolve(path) === resolve(folder) || isPathInside(folder, path);

// What a working tree is holding that exists nowhere else — the only thing
// that makes removing it destructive.
//
// This is deliberately not `gitStatus.ahead`. A row shows "ahead 2" to say how
// far the agent has moved from the branch it started on, which stays true
// after the branch is pushed; safety asks whether those commits are reachable
// from anything on the remote, and pushing is exactly what makes them so.
// Measuring removability with `ahead` produced a guard that told the user to
// push and then refused just the same afterwards.
async function worktreeHeldWork(
  repository: WorkspaceRepository,
  worktree: SessionWorktree,
): Promise<{ uncommittedFiles: number; unreachableCommits: number }> {
  const git = findExecutable("git");
  // Nothing readable is nothing to lose: a tree whose directory is gone, or a
  // machine with no git, must not become permanently unremovable.
  if (!git || !(await pathExists(worktree.path)))
    return { uncommittedFiles: 0, unreachableCommits: 0 };
  // Also read-only, and also asked while an agent may be working in the tree.
  const run = (args: string[]) =>
    runCommand(git, ["--no-optional-locks", "-C", worktree.path, ...args]);
  const status = await run([
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.exitCode !== 0)
    return { uncommittedFiles: 0, unreachableCommits: 0 };
  const branch =
    (await checkedOutBranch(git, worktree.path)) ?? worktree.branchName;
  const published = await publishedBranchName(
    git,
    worktree.path,
    branch,
    repository.baseBranch,
  );
  const elsewhere: string[] = [];
  for (const reference of new Set([
    repository.baseBranch ? `refs/remotes/origin/${repository.baseBranch}` : "",
    repository.baseBranch ? `refs/heads/${repository.baseBranch}` : "",
    `refs/remotes/origin/${branch}`,
    published ? `refs/remotes/origin/${published}` : "",
  ])) {
    if (!reference) continue;
    const resolved = await run(["rev-parse", "--verify", "--quiet", reference]);
    if (resolved.exitCode === 0) elsewhere.push(reference);
  }
  const uncommittedFiles = parsePorcelainStatus(status.stdout).changedFiles;
  // With nothing to compare against there is nothing to call unique. Counting
  // `HEAD` alone would report the repository's whole history, which would make
  // an untouched working tree permanently unremovable.
  if (elsewhere.length === 0)
    return { uncommittedFiles, unreachableCommits: 0 };
  const unique = await run([
    "rev-list",
    "--count",
    "HEAD",
    "--not",
    ...elsewhere,
  ]);
  const unreachableCommits =
    unique.exitCode === 0 ? Number.parseInt(unique.stdout.trim(), 10) || 0 : 0;
  // A squash merge lands the work as one new commit, so the branch's own
  // commits never become ancestors of the base branch, and GitHub then
  // deletes the remote branch, which `fetch --prune` follows. Git alone ends
  // up calling merged work unique. The pull request is the one record that
  // says the work landed, so a merged one whose head holds this tree's HEAD
  // counts as the work being elsewhere.
  if (
    unreachableCommits > 0 &&
    (await mergedPullRequestHolds(
      git,
      worktree.path,
      published ?? branch,
      repository.baseBranch,
    ))
  )
    return { uncommittedFiles, unreachableCommits: 0 };
  return { uncommittedFiles, unreachableCommits };
}

// Whether `branch` has a merged pull request whose head contains this tree's
// HEAD. Any failure, including no `gh`, is `false`: the guard then keeps the
// tree, which is the answer that cannot lose work.
async function mergedPullRequestHolds(
  git: string,
  path: string,
  branch: string,
  baseBranch: string | null,
): Promise<boolean> {
  const gh = findExecutable("gh", GH_EXECUTABLE_FALLBACKS);
  if (!gh) return false;
  const response = await runCommand(
    gh,
    ["pr", "view", branch, "--json", "number,state,headRefOid"],
    { cwd: path, env: { GH_PROMPT_DISABLED: "1" } },
  ).catch(() => undefined);
  if (!response || response.exitCode !== 0) return false;
  return pullRequestAnswerHoldsHead(git, path, response.stdout, baseBranch);
}

/** A commit, or its parent, as a diff may ask for one. */
const COMMIT_REF = /^[0-9a-f]{7,64}\^?$/;

/**
 * Where a worktree's commits start: the merge-base with
 * `origin/<baseBranch>`, so commits that landed on the base branch since the
 * tree branched are not listed as its own. Null when there is no base branch
 * or git cannot find the merge-base; the caller then lists from HEAD.
 */
async function changesBase(
  git: string,
  path: string,
  baseBranch: string | null,
): Promise<string | null> {
  if (!baseBranch) return null;
  const result = await runCommand(git, [
    "--no-optional-locks",
    "-C",
    path,
    "merge-base",
    "HEAD",
    `refs/remotes/origin/${baseBranch}`,
  ]);
  const commit = result.stdout.trim();
  return result.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(commit)
    ? commit
    : null;
}

/**
 * Editors that install a command-line launcher, in the order to try them. A
 * packaged app inherits no shell PATH, so each also names where its app
 * bundle keeps the launcher when the user never put it on PATH.
 */
const EDITOR_LAUNCHERS: Array<{
  name: string;
  command: string;
  fallbacks: string[];
}> = [
  {
    name: "VS Code",
    command: "code",
    fallbacks: [
      ...standardExecutableFallbacks("code"),
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ],
  },
  {
    name: "Cursor",
    command: "cursor",
    fallbacks: [
      ...standardExecutableFallbacks("cursor"),
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    ],
  },
  {
    name: "Zed",
    command: "zed",
    fallbacks: [
      ...standardExecutableFallbacks("zed"),
      "/Applications/Zed.app/Contents/MacOS/cli",
    ],
  },
];

/**
 * The git worktrees Daedalus makes for agent sessions: creating one on a
 * fresh branch, pushing and opening it, reading its commits, and removing it
 * only when that loses nothing, or when the user says so.
 */
export class SessionWorktrees {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly files: WorkspaceFiles,
    private readonly library: RepositoryLibrary,
    private readonly gitStatus: GitStatusMonitor,
    /**
     * Closes the integrated terminals opened at or inside a folder, before
     * Daedalus deletes it. A shell left in a deleted folder cannot be moved
     * out, and every command that checks its directory then fails there.
     */
    private readonly closeTerminalsIn: (
      folder: string,
    ) => Promise<void> = async () => {},
  ) {}

  /** Whether a running integrated terminal was opened at or inside `folder`. */
  private hasLiveTerminalIn(folder: string): boolean {
    return this.repositories
      .listIntegratedTerminals()
      .some(
        (terminal) =>
          (terminal.status === "running" || terminal.status === "starting") &&
          isAtOrInside(folder, terminal.workingDirectory),
      );
  }

  // Pushing publishes an agent's branch, so it is never implicit: nothing in
  // Daedalus pushes on its own, and the branch is always the worktree's own.
  async pushSessionWorktree(input: {
    session: string;
    repository: string;
  }): Promise<{ worktree: SessionWorktree; alreadyUpToDate: boolean }> {
    const session = this.repositories.findAgent(input.session);
    if (!session)
      throw new DaedalusError(
        "NOT_FOUND",
        `Agent session '${input.session}' was not found`,
      );
    const repository = this.repositories
      .listWorkspaceRepositories(session.workspaceId)
      .find(
        (item) =>
          item.id === input.repository || item.name === input.repository,
      );
    if (!repository)
      throw new DaedalusError(
        "NOT_FOUND",
        `Repository '${input.repository}' is not attached to this session's workspace`,
      );
    const worktree = this.repositories
      .listSessionWorktrees({ sessionId: session.id })
      .find((item) => item.repositoryId === repository.id);
    if (!worktree)
      throw new DaedalusError(
        "NOT_FOUND",
        `Session '${session.id}' has no ${repository.name} working tree`,
      );
    if (!(await pathExists(worktree.path)))
      throw new DaedalusError(
        "NOT_FOUND",
        `The ${repository.name} working tree is no longer on disk`,
      );
    const git = findExecutable("git");
    if (!git)
      throw new DaedalusError("DEPENDENCY", "git is not available on PATH");
    // The branch the work is on now, which is not always the one Daedalus
    // named: pushing the recorded name would publish a branch the agent left.
    const branch = await checkedOutBranch(git, worktree.path);
    if (!branch)
      throw new DaedalusError(
        "CONFLICT",
        `The ${repository.name} working tree is on a detached HEAD; there is no branch to push`,
      );
    if (branch === repository.baseBranch)
      throw new DaedalusError(
        "CONFLICT",
        `The ${repository.name} working tree is on ${branch}; Daedalus only pushes a session's own branch`,
      );
    // A branch that already publishes under another name, typically one with
    // an open pull request, keeps publishing there rather than starting a
    // second remote branch beside it.
    const destination =
      (await publishedBranchName(
        git,
        worktree.path,
        branch,
        repository.baseBranch,
      )) ?? branch;
    const result = await runCommand(
      git,
      [
        "-C",
        worktree.path,
        "push",
        "--set-upstream",
        "origin",
        `${branch}:${destination}`,
      ],
      { env: GIT_NETWORK_ENVIRONMENT },
    );
    const output = `${result.stderr}\n${result.stdout}`;
    if (result.exitCode !== 0)
      throw new DaedalusError(
        "CONFLICT",
        `Could not push ${branch}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    const current = await this.gitStatus.recordBranch(git, worktree, branch);
    const measured = await this.gitStatus.measureWorktree(
      current,
      repository.baseBranch,
    );
    return {
      worktree: measured,
      alreadyUpToDate: /Everything up-to-date/i.test(output),
    };
  }

  /**
   * Opens a session's worktree for review: in the first editor found on this
   * machine (VS Code, Cursor, Zed, by their command-line launchers), or in
   * Finder when there is none. The path comes from the worktree registry,
   * never from the caller, so this cannot be pointed at anything else.
   */
  async openSessionWorktree(input: {
    session: string;
    repository: string;
  }): Promise<{ path: string; openedWith: string }> {
    const session = this.repositories.findAgent(input.session);
    if (!session)
      throw new DaedalusError(
        "NOT_FOUND",
        `Agent session '${input.session}' was not found`,
      );
    const worktree = this.repositories
      .listSessionWorktrees({ sessionId: session.id })
      .find((item) => {
        if (item.repositoryId === input.repository) return true;
        const repository = this.repositories
          .listWorkspaceRepositories(session.workspaceId)
          .find((candidate) => candidate.id === item.repositoryId);
        return repository?.name === input.repository;
      });
    if (!worktree)
      throw new DaedalusError(
        "NOT_FOUND",
        `Session '${session.id}' has no '${input.repository}' working tree`,
      );
    if (!(await pathExists(worktree.path)))
      throw new DaedalusError(
        "NOT_FOUND",
        `The working tree at '${worktree.path}' no longer exists`,
      );
    for (const editor of EDITOR_LAUNCHERS) {
      const executable = findExecutable(editor.command, editor.fallbacks);
      if (!executable) continue;
      const result = await runCommand(executable, [worktree.path]);
      if (result.exitCode === 0)
        return { path: worktree.path, openedWith: editor.name };
    }
    const open = findExecutable("open", standardExecutableFallbacks("open"));
    if (!open)
      throw new DaedalusError(
        "DEPENDENCY",
        "Nothing on this machine can open a folder",
      );
    const result = await runCommand(open, [worktree.path]);
    if (result.exitCode !== 0)
      throw new DaedalusError(
        "INTERNAL",
        `Could not open ${worktree.path}: ${result.stderr.trim()}`,
      );
    return { path: worktree.path, openedWith: "Finder" };
  }

  // Removing a working tree destroys whatever is only in it, so the guard is
  // the point: a tree is removable without `force` only when it has nothing
  // uncommitted and no commit the base branch does not already have. Those two
  // facts together mean nothing can be lost.
  async removeSessionWorktree(input: {
    session: string;
    repository: string;
    force?: boolean;
  }): Promise<SessionWorktree> {
    const session = this.repositories.findAgent(input.session);
    if (!session)
      throw new DaedalusError(
        "NOT_FOUND",
        `Agent session '${input.session}' was not found`,
      );
    const repository = this.repositories
      .listWorkspaceRepositories(session.workspaceId)
      .find(
        (item) =>
          item.id === input.repository || item.name === input.repository,
      );
    if (!repository)
      throw new DaedalusError(
        "NOT_FOUND",
        `Repository '${input.repository}' is not attached to this session's workspace`,
      );
    const worktree = this.repositories
      .listSessionWorktrees({ sessionId: session.id })
      .find((item) => item.repositoryId === repository.id);
    if (!worktree)
      throw new DaedalusError(
        "NOT_FOUND",
        `Session '${session.id}' has no ${repository.name} working tree`,
      );
    if (!input.force) {
      const held = await worktreeHeldWork(repository, worktree);
      if (held.uncommittedFiles > 0)
        throw new DaedalusError(
          "CONFLICT",
          `The ${repository.name} working tree has ${held.uncommittedFiles} uncommitted ${held.uncommittedFiles === 1 ? "change" : "changes"}; commit and push them, or remove it with force`,
        );
      if (held.unreachableCommits > 0)
        throw new DaedalusError(
          "CONFLICT",
          `The ${repository.name} working tree has ${held.unreachableCommits} ${held.unreachableCommits === 1 ? "commit that exists" : "commits that exist"} nowhere else; push the branch, or remove it with force`,
        );
    }
    await this.discardWorktree(repository, worktree);
    return worktree;
  }

  // The filesystem removal, with no opinion about whether it is safe: callers
  // own that. Registration is cleared even when the directory is already gone,
  // because a row pointing at nothing is exactly what used to make a
  // repository permanently undetachable.
  private async discardWorktree(
    repository: WorkspaceRepository,
    worktree: SessionWorktree,
  ): Promise<void> {
    const git = findExecutable("git");
    if (!git)
      throw new DaedalusError("DEPENDENCY", "git is not available on PATH");
    const sourceArguments = repository.libraryRepositoryId
      ? ["--git-dir", repository.canonicalPath]
      : ["-C", repository.canonicalPath];
    // Read before the tree goes: an agent may have moved the work to a
    // branch of its own, and that branch is the one left holding it.
    const current = (await pathExists(worktree.path))
      ? await checkedOutBranch(git, worktree.path)
      : null;
    const removed = await runCommand(git, [
      ...sourceArguments,
      "worktree",
      "remove",
      "--force",
      worktree.path,
    ]);
    if (removed.exitCode !== 0 && (await pathExists(worktree.path)))
      throw new DaedalusError(
        "CONFLICT",
        `Could not remove the ${repository.name} working tree: ${removed.stderr.trim() || removed.stdout.trim()}`,
      );
    await runCommand(git, [...sourceArguments, "worktree", "prune"]);
    // The branches only ever existed to carry this tree's work. The base
    // branch is never one of them, even when the tree had it checked out.
    const branches = [
      ...new Set([worktree.branchName, current ?? worktree.branchName]),
    ].filter((branch) => branch !== repository.baseBranch);
    if (branches.length > 0)
      await runCommand(git, [...sourceArguments, "branch", "-D", ...branches]);
    this.gitStatus.forget(worktree.path);
    this.repositories.deleteSessionWorktree(worktree.sessionId, repository.id);
  }

  // Called when a session is archived. Only trees that provably hold nothing —
  // no uncommitted change, no commit the base branch lacks — are cleared, so
  // archiving never destroys an agent's work. Anything else is left for the
  // user to deal with deliberately.
  async releaseSessionWorktrees(sessionId: string): Promise<SessionWorktree[]> {
    const worktrees = this.repositories.listSessionWorktrees({ sessionId });
    if (worktrees.length === 0) return [];
    const released: SessionWorktree[] = [];
    for (const worktree of worktrees) {
      const repository = this.repositories.findWorkspaceRepository(
        worktree.repositoryId,
      );
      if (!repository) continue;
      const held = await worktreeHeldWork(repository, worktree);
      if (held.uncommittedFiles > 0 || held.unreachableCommits > 0) continue;
      // Clearing up is optional here, unlike a deletion the user asked for,
      // so a tree with a terminal still working in it stays.
      if (this.hasLiveTerminalIn(worktree.path)) continue;
      await this.discardWorktree(repository, worktree);
      released.push(worktree);
    }
    return released;
  }

  // Called only when a workspace is deleted for good. Every session worktree
  // goes with its branches, whatever it holds, and every checkout under
  // `repos/` is unregistered, so the shared clones keep no worktree entry
  // pointing into a folder that is about to disappear.
  async discardWorkspaceCheckouts(workspaceId: string): Promise<void> {
    const workspacePath = this.repositories.findWorkspace(workspaceId)?.path;
    if (workspacePath) await this.closeTerminalsIn(workspacePath);
    const repositories =
      this.repositories.listWorkspaceRepositories(workspaceId);
    for (const worktree of this.repositories.listSessionWorktrees({
      workspaceId,
    })) {
      const repository = repositories.find(
        (item) => item.id === worktree.repositoryId,
      );
      if (repository) await this.discardWorktree(repository, worktree);
    }
    for (const repository of repositories)
      await this.library.discardReferenceCheckout(repository);
  }

  // Called only when an archived session is deleted for good. Its worktrees
  // go with their branches, whatever they hold. Its folder goes too, but only
  // a folder Daedalus made under `worktrees/` that no other session runs in:
  // a session continued by rebirth shares its predecessor's folder.
  async discardSessionFiles(session: AgentSession): Promise<void> {
    for (const worktree of this.repositories.listSessionWorktrees({
      sessionId: session.id,
    })) {
      const repository = this.repositories.findWorkspaceRepository(
        worktree.repositoryId,
      );
      if (!repository) continue;
      await this.closeTerminalsIn(worktree.path);
      await this.discardWorktree(repository, worktree);
    }
    // A cloud session's folder is on its workspace volume, not here.
    if (session.hostId) return;
    const workspace = await this.workspaces.get(session.workspaceId);
    const worktreesRoot = join(workspace.path, "worktrees");
    const folder = resolve(session.workingDirectory);
    if (
      !isPathInside(worktreesRoot, folder) ||
      this.repositories
        .listAgents({ workspaceId: workspace.id })
        .some(
          (other) =>
            other.id !== session.id &&
            resolve(other.workingDirectory) === folder,
        ) ||
      !(await pathExists(folder)) ||
      (await lstat(folder)).isSymbolicLink()
    )
      return;
    await this.closeTerminalsIn(folder);
    await removeDirectory(folder);
    // A task's group folder goes with its last session.
    const group = dirname(folder);
    if (group !== resolve(worktreesRoot) && (await readdir(group)).length === 0)
      await removeDirectory(group);
  }

  /** The session worktree at `root`, with git and where its changes start. */
  private async resolveWorktree(reference: string, root: string) {
    const workspace = await this.workspaces.getActive(reference);
    const folder = await this.files.resolveVisiblePath(workspace, root);
    const worktree = this.repositories
      .listSessionWorktrees({ workspaceId: workspace.id })
      .find((item) => resolve(item.path) === resolve(folder.target));
    if (!worktree)
      throw new DaedalusError(
        "NOT_FOUND",
        `'${root}' is not a session worktree`,
      );
    const git = findExecutable("git");
    if (!git) throw new DaedalusError("DEPENDENCY", "git was not found");
    const repository = this.repositories
      .listWorkspaceRepositories(workspace.id)
      .find((item) => item.id === worktree.repositoryId);
    const base = await changesBase(
      git,
      worktree.path,
      repository?.baseBranch ?? null,
    );
    const run = (args: string[]) =>
      runCommand(git, ["--no-optional-locks", "-C", worktree.path, ...args]);
    return {
      workspace,
      worktree,
      root: relative(workspace.path, worktree.path),
      base,
      run,
    };
  }

  /**
   * A file as it is at HEAD, for the left side of a diff, or
   * at a commit (`<sha>`, or `<sha>^` for its parent) when `ref` is given.
   * Empty for a file that did not exist there.
   */
  async changeOriginal(input: {
    workspace: string;
    root: string;
    repositoryPath: string;
    ref?: string;
  }): Promise<{ content: string; binary: boolean }> {
    if (
      isAbsolute(input.repositoryPath) ||
      input.repositoryPath.split(/[\\/]/).includes("..")
    )
      throw new DaedalusError(
        "VALIDATION",
        "Repository paths must be relative",
      );
    if (input.ref !== undefined && !COMMIT_REF.test(input.ref))
      throw new DaedalusError("VALIDATION", "Not a commit");
    const { run } = await this.resolveWorktree(input.workspace, input.root);
    const shown = await run([
      "show",
      `${input.ref ?? "HEAD"}:${input.repositoryPath}`,
    ]);
    if (shown.exitCode !== 0) return { content: "", binary: false };
    const binary = shown.stdout.slice(0, 8192).includes("\0");
    return { content: binary ? "" : shown.stdout, binary };
  }

  /**
   * The commits a session worktree made since it branched, newest first, as
   * VS Code's Source Control Graph lists a branch's outgoing commits.
   */
  async worktreeCommits(input: {
    workspace: string;
    root: string;
  }): Promise<WorktreeCommit[]> {
    const { base, run } = await this.resolveWorktree(
      input.workspace,
      input.root,
    );
    const log = await run([
      "log",
      "--max-count=200",
      "-z",
      `--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s`,
      base ? `${base}..HEAD` : "HEAD",
    ]);
    if (log.exitCode !== 0) return [];
    // What no branch on `origin` holds yet: committed here, not pushed.
    const local = await run([
      "rev-list",
      base ? `${base}..HEAD` : "HEAD",
      "--not",
      "--remotes=origin",
    ]);
    const unpushed = new Set(
      local.exitCode === 0 ? local.stdout.split("\n").filter(Boolean) : [],
    );
    return log.stdout
      .split("\0")
      .filter((record) => record.trim())
      .flatMap((record) => {
        const [sha, shortSha, author, date, subject] = record
          .replace(/^\n/, "")
          .split("\x1f");
        return sha && shortSha && date
          ? [
              {
                sha,
                shortSha,
                author: author ?? "",
                date,
                subject: subject ?? "",
                pushed: !unpushed.has(sha),
              },
            ]
          : [];
      });
  }

  /** The files one commit of a session worktree changed, against its parent. */
  async commitFiles(input: {
    workspace: string;
    root: string;
    sha: string;
  }): Promise<ChangedFile[]> {
    if (!/^[0-9a-f]{7,64}$/.test(input.sha))
      throw new DaedalusError("VALIDATION", "Not a commit");
    const { root, run } = await this.resolveWorktree(
      input.workspace,
      input.root,
    );
    // `--root` so the first commit of a history still lists what it added.
    const args = ["diff-tree", "--root", "-r", "-z", "-M", "--no-commit-id"];
    const [nameStatus, numstat] = await Promise.all([
      run([...args, "--name-status", input.sha]),
      run([...args, "--numstat", input.sha]),
    ]);
    if (nameStatus.exitCode !== 0) return [];
    return parseChangedFiles(nameStatus.stdout, numstat.stdout).map((file) => ({
      ...file,
      path: join(root, file.repositoryPath),
    }));
  }

  // A session worktree starts from the newest commit on the repository's base
  // branch, not from `baseCommit`. `baseCommit` is pinned when the repository
  // is attached and only moves on an explicit sync, so branching from it puts
  // every new session behind by whatever has landed since the attachment —
  // and the gap only grows, which is what makes parallel agents collide.
  //
  // Freshness is best effort, never a precondition: a repository with no
  // reachable remote — local-only, or simply offline — still has to produce a
  // worktree, so resolution degrades to the pinned commit and finally to HEAD.
  private async latestWorktreeBase(
    git: string,
    sourceArguments: readonly string[],
    repository: WorkspaceRepository,
  ): Promise<string> {
    const pinned = repository.baseCommit ?? "HEAD";
    if (!repository.baseBranch) return pinned;
    const fetched = await runCommand(git, [
      ...sourceArguments,
      "fetch",
      "--prune",
      "origin",
    ]);
    if (fetched.exitCode !== 0) return pinned;
    await this.library.afterWorktreeFetch(git, repository);
    const resolved = await runCommand(git, [
      ...sourceArguments,
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${repository.baseBranch}`,
    ]);
    const commit = resolved.stdout.trim();
    return resolved.exitCode === 0 && /^[0-9a-f]{40,64}$/i.test(commit)
      ? commit
      : pinned;
  }

  /**
   * The agent names the branch, because it knows what the change is and the
   * repository may have a naming convention. The name is used as given: it
   * must be a valid git branch name that is neither a local branch nor one on
   * origin, since pushing to someone else's branch would add to their work.
   * Run after the fetch, so origin's branches are as fresh as they can be.
   */
  private async checkedBranchName(
    git: string,
    sourceArguments: string[],
    branch: string,
  ): Promise<string> {
    // Inside a repository --branch expands @{-N}, so anything but the name
    // itself coming back is a name git would read as something else.
    const valid = await runCommand(git, [
      ...sourceArguments,
      "check-ref-format",
      "--branch",
      branch,
    ]);
    if (valid.exitCode !== 0 || valid.stdout.trim() !== branch)
      throw new DaedalusError(
        "VALIDATION",
        `'${branch}' is not a valid branch name`,
      );
    for (const ref of [
      `refs/heads/${branch}`,
      `refs/remotes/origin/${branch}`,
    ]) {
      const taken = await runCommand(git, [
        ...sourceArguments,
        "rev-parse",
        "--verify",
        "--quiet",
        ref,
      ]);
      if (taken.exitCode === 0)
        throw new DaedalusError(
          "CONFLICT",
          ref.startsWith("refs/heads/")
            ? `Branch '${branch}' already exists`
            : `Branch '${branch}' already exists on origin`,
        );
    }
    return branch;
  }

  async createSessionWorktree(input: {
    session: string;
    repository: string;
    branch?: string;
    /**
     * The session folder to put it in, when the session's own is not on
     * this Mac yet: a session coming home from the cloud.
     */
    folder?: string;
  }): Promise<SessionWorktree> {
    const session = this.repositories.findAgent(input.session);
    if (!session)
      throw new DaedalusError(
        "NOT_FOUND",
        `Agent session '${input.session}' was not found`,
      );
    if (session.kind !== "agent")
      throw new DaedalusError(
        "CONFLICT",
        "Repository worktrees can only be created for agent sessions",
      );
    const repository = this.repositories
      .listWorkspaceRepositories(session.workspaceId)
      .find(
        (item) =>
          item.id === input.repository || item.name === input.repository,
      );
    if (!repository)
      throw new DaedalusError(
        "NOT_FOUND",
        `Repository '${input.repository}' is not attached to this session's workspace`,
      );
    const existing = this.repositories
      .listSessionWorktrees({ sessionId: session.id })
      .find((item) => item.repositoryId === repository.id);
    const branch = input.branch?.trim();
    if (existing) {
      if (branch && branch !== existing.branchName)
        throw new DaedalusError(
          "CONFLICT",
          `This session already has a worktree for ${repository.name} at ${existing.path} on branch '${existing.branchName}'. Leave out --branch to get it, or rename its branch with git branch -m.`,
        );
      return existing;
    }
    requireReady(repository);
    if (repository.access !== "write")
      throw new DaedalusError(
        "CONFLICT",
        `Repository '${repository.name}' is attached as reference-only`,
      );
    if (!branch)
      throw new DaedalusError(
        "VALIDATION",
        "--branch <name> is required. Name the branch for the change, for example fix/login-timeout, and follow the repository's branch naming convention if its AGENTS.md or CLAUDE.md sets one.",
      );
    const workspace = await this.workspaces.getActive(session.workspaceId);
    const path = join(
      input.folder ?? session.workingDirectory,
      repository.name,
    );
    if (!isPathInside(workspace.path, path))
      throw new DaedalusError(
        "CONFLICT",
        "The session working directory is outside its workspace",
      );
    const git = findExecutable("git");
    if (!git)
      throw new DaedalusError("DEPENDENCY", "git is not available on PATH");
    await ensureDirectory(resolve(path, ".."));
    const sourceArguments = repository.libraryRepositoryId
      ? ["--git-dir", repository.canonicalPath]
      : ["-C", repository.canonicalPath];
    const base = await this.latestWorktreeBase(
      git,
      sourceArguments,
      repository,
    );
    const branchName = await this.checkedBranchName(
      git,
      sourceArguments,
      branch,
    );
    const result = await runCommand(git, [
      ...sourceArguments,
      "worktree",
      "add",
      "-b",
      branchName,
      path,
      base,
    ]);
    if (result.exitCode !== 0)
      throw new DaedalusError(
        "CONFLICT",
        `Could not create worktree for ${repository.name}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    const worktree: SessionWorktree = {
      sessionId: session.id,
      repositoryId: repository.id,
      path,
      branchName,
      createdAt: new Date().toISOString(),
    };
    try {
      this.repositories.createSessionWorktree(worktree);
      this.gitStatus.scheduleRefresh(session.workspaceId, true);
      return worktree;
    } catch (error) {
      await runCommand(git, [
        ...sourceArguments,
        "worktree",
        "remove",
        "--force",
        path,
      ]);
      throw error;
    }
  }
}

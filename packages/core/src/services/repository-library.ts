import { basename, dirname, join } from "node:path";
import {
  ensureDirectory,
  findExecutable,
  isPathInside,
  pathExists,
  removeDirectory,
  runCommand,
} from "@daedalus/platform";
import type {
  RepositoryFetchOutcome,
  RepositoryLibraryEntry,
  Workspace,
  WorkspaceRepository,
} from "../domain";
import type { DaedalusConfig } from "../config";
import { DaedalusError, normalizeError } from "../errors";
import { requireOnMac } from "./cloud-launch";
import type { SqliteRepositories } from "../repositories";
import {
  GH_EXECUTABLE_FALLBACKS,
  GIT_NETWORK_ENVIRONMENT,
} from "./git-commands";
import type { GitStatusMonitor } from "./git-status-monitor";
import type { WorkspaceService } from "./workspaces";

type GitHubRepositoryResponse = {
  name?: string;
  full_name?: string;
  clone_url?: string;
};

export function parseGitHubRepositoryPages(value: string): Array<{
  name: string;
  nameWithOwner: string;
  remoteUrl: string;
}> {
  const pages = JSON.parse(value) as GitHubRepositoryResponse[][];
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.flatMap((repository) => {
      if (!repository.name || !repository.full_name || !repository.clone_url)
        return [];
      const identity = repository.full_name.toLowerCase();
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [
        {
          name: repository.name,
          nameWithOwner: repository.full_name,
          remoteUrl: repository.clone_url,
        },
      ];
    }),
  );
}

const SAFE_SEGMENT = /[^a-z0-9]+/g;

export function pathSegment(value: string, fallback: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(SAFE_SEGMENT, "-")
      .replace(/^-+|-+$/g, "") || fallback
  ).slice(0, 80);
}

function repositoryName(value: string): string {
  const name = pathSegment(value, "");
  if (!name)
    throw new DaedalusError(
      "VALIDATION",
      "Repository name must contain a letter or number",
    );
  return name;
}

function remoteRepositoryName(remoteUrl: string): string {
  const withoutQuery = remoteUrl.replace(/[?#].*$/, "").replace(/[\\/]$/, "");
  return repositoryName(basename(withoutQuery).replace(/\.git$/i, ""));
}

const REMOTE_TRACKING_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

// A bare clone already carries every branch under `refs/heads/*`, but nothing
// under `refs/remotes/origin/*` — which is what worktree creation and status
// comparison resolve against. Populating them by fetching `origin` again costs
// a network round trip that transfers no objects, and `remote set-head --auto`
// costs a second one to learn a default branch the clone already recorded in
// `HEAD`. Both are avoidable: the refs are copied from the repository to
// itself, and the default branch is read locally. Measured against a small
// GitHub repository the two round trips cost about a second, which is more
// than the clone itself and is paid per repository.
async function seedRemoteTrackingRefs(
  git: string,
  gitDirectory: string,
): Promise<string> {
  const run = (args: string[]) =>
    runCommand(git, ["--git-dir", gitDirectory, ...args]);
  const configure = await run([
    "config",
    "remote.origin.fetch",
    REMOTE_TRACKING_REFSPEC,
  ]);
  if (configure.exitCode !== 0)
    throw new DaedalusError(
      "DEPENDENCY",
      `Could not configure repository remote: ${configure.stderr.trim()}`,
    );
  const head = await run(["symbolic-ref", "--short", "HEAD"]);
  const defaultBranch = head.stdout.trim();
  if (head.exitCode !== 0 || !defaultBranch)
    throw new DaedalusError(
      "DEPENDENCY",
      "The repository remote does not advertise a default branch",
    );
  // Fetching `origin` rather than copying the repository's own refs into place.
  // The copy needed no network and was faster, but on a case-insensitive
  // filesystem it refuses outright for any repository whose remote carries two
  // branches differing only in case — git cannot write both as loose refs, and
  // fetching from a local path is the shape that takes that route. Fetching the
  // remote handles the same repository without complaint, so the round trip is
  // the price of working on the repositories people actually have.
  const copy = await runCommand(
    git,
    ["--git-dir", gitDirectory, "fetch", "--prune", "origin"],
    { env: GIT_NETWORK_ENVIRONMENT },
  );
  if (copy.exitCode !== 0)
    throw new DaedalusError(
      "DEPENDENCY",
      `Could not record the remote branches: ${copy.stderr.trim() || copy.stdout.trim()}`,
    );
  const symbolic = await run([
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    `refs/remotes/origin/${defaultBranch}`,
  ]);
  if (symbolic.exitCode !== 0)
    throw new DaedalusError(
      "DEPENDENCY",
      `Could not record the remote default branch: ${symbolic.stderr.trim() || symbolic.stdout.trim()}`,
    );
  await dropClonedBranchCopies(git, gitDirectory, defaultBranch);
  return defaultBranch;
}

// `git clone --bare` copies every remote branch into `refs/heads/*`, and with
// the remote-tracking refspec in place nothing ever moves those copies again.
// Left alone, `main` falls behind `origin/main`, and `git checkout topic` in
// any worktree gets the copy from the day of the clone rather than the
// remote's branch, because git only creates a branch from `origin/topic`
// when no local one of that name exists. Straight after the clone every copy
// is on the remote and nothing has any of them checked out, so all but the
// default branch go.
async function dropClonedBranchCopies(
  git: string,
  gitDirectory: string,
  defaultBranch: string,
): Promise<void> {
  const heads = await runCommand(git, [
    "--git-dir",
    gitDirectory,
    "for-each-ref",
    "--format=%(refname:lstrip=2)",
    "refs/heads",
  ]);
  const copies = heads.stdout
    .split("\n")
    .filter((branch) => branch && branch !== defaultBranch);
  // `git branch -D` also drops each branch's configuration. Batched, because
  // a large repository has more names than one argument list should carry.
  for (let start = 0; start < copies.length; start += 200)
    await runCommand(git, [
      "--git-dir",
      gitDirectory,
      "branch",
      "-D",
      ...copies.slice(start, start + 200),
    ]);
}

// Moves the local default branch to the remote's after a fetch, so `main`
// means what people and agents expect it to. It is created when missing, and
// left alone while a working tree has it checked out (moving a branch under a
// tree makes its files look changed) or when it has commits the remote lacks.
async function fastForwardDefaultBranch(
  git: string,
  gitDirectory: string,
  defaultBranch: string,
): Promise<void> {
  const run = (args: string[]) =>
    runCommand(git, ["--git-dir", gitDirectory, ...args]);
  const remote = await run([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${defaultBranch}^{commit}`,
  ]);
  const target = remote.stdout.trim();
  if (remote.exitCode !== 0 || !target) return;
  const local = await run([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${defaultBranch}^{commit}`,
  ]);
  const current = local.stdout.trim();
  if (local.exitCode !== 0 || !current) {
    await run([
      "branch",
      "--track",
      defaultBranch,
      `refs/remotes/origin/${defaultBranch}`,
    ]);
    return;
  }
  if (current === target) return;
  const listed = await run(["worktree", "list", "--porcelain"]);
  if (
    listed.exitCode !== 0 ||
    listed.stdout.split("\n").includes(`branch refs/heads/${defaultBranch}`) ||
    (await run(["merge-base", "--is-ancestor", current, target])).exitCode !== 0
  )
    return;
  await run(["update-ref", `refs/heads/${defaultBranch}`, target, current]);
}

/** Refuses a repository that is still preparing or failed to prepare. */
export function requireReady(
  repository: WorkspaceRepository,
): WorkspaceRepository {
  if (repository.status === "preparing")
    throw new DaedalusError(
      "CONFLICT",
      `Repository '${repository.name}' is still being prepared`,
    );
  if (repository.status === "failed")
    throw new DaedalusError(
      "CONFLICT",
      `Repository '${repository.name}' was not prepared: ${repository.statusError ?? "unknown error"}`,
    );
  return repository;
}

/**
 * The shared bare clones under the Daedalus home and the read-only checkouts
 * of them under each workspace's `repos/`: adding, fetching, attaching,
 * synchronizing and detaching.
 */
/**
 * How old a clone's base branch may get before a background fetch brings it
 * up to date. "Behind" and the merge-base every worktree is compared from
 * are read from `refs/remotes/origin/<base>`, which otherwise moved only when
 * someone pressed Fetch or a worktree was created.
 */
export const BASE_FETCH_INTERVAL_MS = 10 * 60_000;

export class RepositoryLibrary {
  /** In-flight preparations, so a shutdown or a test can wait for them. */
  private readonly preparations = new Map<string, Promise<void>>();
  /** When each clone's base branches were last fetched in the background. */
  private readonly baseFetchedAt = new Map<string, number>();
  private fetchingBaseBranches?: Promise<void>;

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly config: DaedalusConfig,
    private readonly gitStatus: GitStatusMonitor,
    /**
     * Called when a repository finishes preparing. The work happens outside
     * any request, so without this the desktop would show "preparing" until
     * something else happened to refresh it.
     */
    private readonly onRepositoriesChanged: () => void = () => {},
  ) {}

  /**
   * A preparation only lives as long as the process running the clone, so a
   * row still marked `preparing` at startup is from a run that is over. It is
   * reported as failed rather than left spinning forever.
   */
  reconcilePreparations(): void {
    for (const repository of this.repositories.listWorkspaceRepositories())
      if (repository.status === "preparing")
        this.repositories.updateWorkspaceRepository({
          ...repository,
          status: "failed",
          statusError: "Preparation was interrupted before it finished",
        });
  }

  listRepositoryLibrary(): RepositoryLibraryEntry[] {
    return this.repositories.listRepositoryLibrary();
  }

  async discoverGitHubRepositories(): Promise<{
    githubCliAvailable: boolean;
    authenticated: boolean;
    repositories: Array<{
      name: string;
      nameWithOwner: string;
      remoteUrl: string;
    }>;
    error?: string;
  }> {
    const gh = findExecutable("gh", GH_EXECUTABLE_FALLBACKS);
    if (!gh)
      return {
        githubCliAvailable: false,
        authenticated: false,
        repositories: [],
      };
    const environment = { GH_PROMPT_DISABLED: "1" };
    const response = await runCommand(
      gh,
      [
        "api",
        "--paginate",
        "--slurp",
        "-X",
        "GET",
        "user/repos",
        "-f",
        "per_page=100",
        "-f",
        "affiliation=owner,collaborator,organization_member",
        "-f",
        "sort=updated",
      ],
      { env: environment },
    );
    if (response.exitCode !== 0) {
      const detail = response.stderr.trim() || response.stdout.trim();
      const authenticationFailed =
        /auth|credential|login|token|401|bad credentials/i.test(detail);
      return {
        githubCliAvailable: true,
        authenticated: !authenticationFailed,
        repositories: [],
        error: authenticationFailed
          ? "Sign in with `gh auth login` to discover GitHub repositories."
          : `Could not load GitHub repositories: ${detail}`,
      };
    }
    try {
      return {
        githubCliAvailable: true,
        authenticated: true,
        repositories: parseGitHubRepositoryPages(response.stdout),
      };
    } catch {
      return {
        githubCliAvailable: true,
        authenticated: true,
        repositories: [],
        error: "GitHub CLI returned an unreadable repository list.",
      };
    }
  }

  async addRepositoryToLibrary(input: {
    remoteUrl: string;
    name?: string;
    githubNameWithOwner?: string;
    /** Pre-allocated so a preparing attachment can point at its real clone. */
    id?: string;
  }): Promise<RepositoryLibraryEntry> {
    const remoteUrl = input.remoteUrl.trim();
    if (!remoteUrl || remoteUrl.length > 2048)
      throw new DaedalusError(
        "VALIDATION",
        "Repository URL or local path must contain 1–2048 characters",
      );
    const existing = this.repositories.findRepositoryLibraryEntry(remoteUrl);
    if (existing) return this.refreshRepository(existing);
    const git = findExecutable("git");
    if (!git)
      throw new DaedalusError("DEPENDENCY", "git is not available on PATH");
    const id = input.id ?? crypto.randomUUID();
    const gitDirectory = join(this.config.repositoryRoot, `${id}.git`);
    const githubNameWithOwner = input.githubNameWithOwner?.trim();
    if (
      githubNameWithOwner &&
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubNameWithOwner)
    )
      throw new DaedalusError(
        "VALIDATION",
        "GitHub repository must use the owner/repository format",
      );
    const gh = githubNameWithOwner
      ? findExecutable("gh", GH_EXECUTABLE_FALLBACKS)
      : undefined;
    if (githubNameWithOwner && !gh)
      throw new DaedalusError(
        "DEPENDENCY",
        "GitHub CLI is no longer available on PATH",
      );
    const runClone = (extra: readonly string[]) =>
      githubNameWithOwner
        ? runCommand(
            gh!,
            [
              "repo",
              "clone",
              githubNameWithOwner,
              gitDirectory,
              "--",
              "--bare",
              ...extra,
            ],
            {
              env: {
                GH_PROMPT_DISABLED: "1",
                GIT_TERMINAL_PROMPT: "0",
              },
            },
          )
        : runCommand(
            git,
            ["clone", "--bare", ...extra, remoteUrl, gitDirectory],
            { env: GIT_NETWORK_ENVIRONMENT },
          );
    // macOS filesystems are case-insensitive, and the default ref backend
    // cannot store two branches whose names differ only in case — a real
    // repository with `task/X_Deploy-...` and `task/X_deploy-...` simply
    // refuses to finish fetching. The reftable backend has no such limit, and
    // nothing here reads refs with anything but git. Older git does not know
    // the option, so a clone that rejects it is retried plainly.
    let clone = await runClone(["--ref-format=reftable"]);
    if (clone.exitCode !== 0) {
      if (await pathExists(gitDirectory)) await removeDirectory(gitDirectory);
      clone = await runClone([]);
    }
    if (clone.exitCode !== 0) {
      if (await pathExists(gitDirectory)) await removeDirectory(gitDirectory);
      throw new DaedalusError(
        "DEPENDENCY",
        `Could not clone repository: ${clone.stderr.trim() || clone.stdout.trim()}`,
      );
    }
    const now = new Date().toISOString();
    const repository: RepositoryLibraryEntry = {
      id,
      name: repositoryName(input.name ?? remoteRepositoryName(remoteUrl)),
      remoteUrl,
      gitDirectory,
      defaultBranch: "",
      lastFetchedAt: now,
      createdAt: now,
    };
    try {
      const seeded: RepositoryLibraryEntry = {
        ...repository,
        defaultBranch: await seedRemoteTrackingRefs(git, gitDirectory),
      };
      this.repositories.createRepositoryLibraryEntry(seeded);
      return seeded;
    } catch (error) {
      await removeDirectory(gitDirectory);
      throw error;
    }
  }

  private async refreshRepository(
    repository: RepositoryLibraryEntry,
    persist = true,
    follow = true,
  ): Promise<RepositoryLibraryEntry> {
    const git = findExecutable("git");
    if (!git)
      throw new DaedalusError("DEPENDENCY", "git is not available on PATH");
    const configure = await runCommand(
      git,
      [
        "--git-dir",
        repository.gitDirectory,
        "config",
        "remote.origin.fetch",
        REMOTE_TRACKING_REFSPEC,
      ],
      { env: GIT_NETWORK_ENVIRONMENT },
    );
    if (configure.exitCode !== 0)
      throw new DaedalusError(
        "DEPENDENCY",
        `Could not configure repository remote: ${configure.stderr.trim()}`,
      );
    const fetch = await runCommand(
      git,
      ["--git-dir", repository.gitDirectory, "fetch", "--prune", "origin"],
      { env: GIT_NETWORK_ENVIRONMENT },
    );
    if (fetch.exitCode !== 0)
      throw new DaedalusError(
        "DEPENDENCY",
        `Could not fetch the latest remote repository state: ${fetch.stderr.trim() || fetch.stdout.trim()}`,
      );
    const remoteHead = await runCommand(
      git,
      [
        "--git-dir",
        repository.gitDirectory,
        "remote",
        "set-head",
        "origin",
        "--auto",
      ],
      { env: GIT_NETWORK_ENVIRONMENT },
    );
    if (remoteHead.exitCode !== 0)
      throw new DaedalusError(
        "DEPENDENCY",
        `Could not resolve the remote default branch: ${remoteHead.stderr.trim() || remoteHead.stdout.trim()}`,
      );
    const branch = await runCommand(git, [
      "--git-dir",
      repository.gitDirectory,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (branch.exitCode !== 0 || !branch.stdout.trim())
      throw new DaedalusError(
        "DEPENDENCY",
        "The repository remote does not advertise a default branch",
      );
    const refreshed: RepositoryLibraryEntry = {
      ...repository,
      defaultBranch: branch.stdout.trim().replace(/^origin\//, ""),
      lastFetchedAt: new Date().toISOString(),
    };
    await fastForwardDefaultBranch(
      git,
      repository.gitDirectory,
      refreshed.defaultBranch,
    );
    if (persist) {
      this.repositories.updateRepositoryLibraryEntry(refreshed);
      if (follow) await this.followRemote(refreshed);
    }
    return refreshed;
  }

  // Every workspace checkout of this clone moves to what was just fetched.
  // They are read-only and detached, so there is nothing of anyone's to
  // protect by leaving them behind, and a checkout that trails the remote is
  // one an agent plans against while its worktree starts from newer code.
  // One that cannot move quietly stays where it is; its row says behind, and
  // an explicit sync says why.
  private async followRemote(refreshed: RepositoryLibraryEntry): Promise<void> {
    const checkouts = this.repositories.listWorkspaceRepositories().filter(
      (item) =>
        item.libraryRepositoryId === refreshed.id &&
        item.status === "ready" &&
        item.referencePath &&
        // A cloud workspace's checkout here is its backup; the pod's moves
        // with the pod.
        this.repositories.workspacePlace(item.workspaceId).place !== "cloud",
    );
    for (const repository of checkouts) {
      try {
        const moved = await this.moveReferenceCheckout(repository, refreshed);
        if (moved !== repository) {
          this.gitStatus.forget(repository.referencePath!);
          this.onRepositoriesChanged();
        }
      } catch {
        // Left behind on purpose; see above.
      }
    }
  }

  // Fetch updates the shared clone every workspace and worktree resolves
  // against, so it is what makes "behind 3" true again without touching a
  // single working tree.
  /**
   * `pull: false` only fetches: the remote-tracking refs move and the row can
   * say "behind 3", but no checkout under `repos/` changes. The default also
   * moves every checkout of the clone to the latest base branch.
   */
  async fetchRepository(
    id: string,
    options: {
      pull?: boolean;
      /**
       * Re-measure every tree in the workspace afterwards; true unless false.
       * Fetch is also how a user says "something changed that you have not
       * shown yet", so it does not trust any cached answer.
       */
      remeasure?: boolean;
    } = {},
  ): Promise<WorkspaceRepository> {
    const repository = this.repositories.findWorkspaceRepository(id);
    if (!repository)
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace repository '${id}' was not found`,
      );
    requireReady(repository);
    if (!repository.libraryRepositoryId)
      throw new DaedalusError(
        "CONFLICT",
        `Repository '${repository.name}' has no shared clone to fetch`,
      );
    const libraryRepository = this.repositories.findRepositoryLibraryEntry(
      repository.libraryRepositoryId,
    );
    if (!libraryRepository)
      throw new DaedalusError(
        "NOT_FOUND",
        "The shared repository clone is no longer available",
      );
    const refreshed = await this.refreshRepository(
      libraryRepository,
      true,
      options.pull ?? true,
    );
    // Read again: the fetch may have moved this checkout and recorded it.
    const updated: WorkspaceRepository = {
      ...(this.repositories.findWorkspaceRepository(repository.id) ??
        repository),
      fetchedAt: refreshed.lastFetchedAt,
    };
    this.repositories.updateWorkspaceRepository(updated);
    const measured = await this.gitStatus.measureRepository(updated);
    if (options.remeasure ?? true)
      this.gitStatus.remeasureWorkspace(repository.workspaceId);
    return measured;
  }

  /**
   * Fetches only the base branch of each shared clone that a session
   * worktree uses, when it is older than `maxAgeMs`, so "behind" stays true
   * without anyone pressing Fetch. Only `refs/remotes/origin/<base>` moves:
   * no other remote branch is pruned or added, and no checkout moves, which
   * is what Fetch and Pull are for. One clone at a time; a clone that fails
   * (offline, a fetch already running) is tried again next time. Trees whose
   * base moved are measured again through their fingerprint.
   */
  fetchBaseBranches(maxAgeMs = BASE_FETCH_INTERVAL_MS): Promise<void> {
    this.fetchingBaseBranches ??= this.fetchStaleBaseBranches(maxAgeMs).finally(
      () => {
        this.fetchingBaseBranches = undefined;
      },
    );
    return this.fetchingBaseBranches;
  }

  private async fetchStaleBaseBranches(maxAgeMs: number): Promise<void> {
    const git = findExecutable("git");
    if (!git) return;
    const used = new Set(
      this.repositories
        .listSessionWorktrees({})
        .map((item) => item.repositoryId),
    );
    const clones = new Map<
      string,
      { gitDirectory: string; branches: Set<string>; workspaces: Set<string> }
    >();
    for (const repository of this.repositories.listWorkspaceRepositories()) {
      if (
        repository.status !== "ready" ||
        !repository.libraryRepositoryId ||
        !repository.baseBranch ||
        !used.has(repository.id)
      )
        continue;
      const entry = this.repositories.findRepositoryLibraryEntry(
        repository.libraryRepositoryId,
      );
      if (!entry) continue;
      const clone = clones.get(entry.id) ?? {
        gitDirectory: entry.gitDirectory,
        branches: new Set<string>(),
        workspaces: new Set<string>(),
      };
      clone.branches.add(repository.baseBranch);
      clone.workspaces.add(repository.workspaceId);
      clones.set(entry.id, clone);
    }
    const moved = new Set<string>();
    for (const [id, clone] of clones) {
      if (Date.now() - (this.baseFetchedAt.get(id) ?? 0) < maxAgeMs) continue;
      this.baseFetchedAt.set(id, Date.now());
      const branches = [...clone.branches];
      const heads = async () =>
        (
          await runCommand(git, [
            "--git-dir",
            clone.gitDirectory,
            "rev-parse",
            ...branches.map((branch) => `refs/remotes/origin/${branch}`),
          ])
        ).stdout;
      const before = await heads();
      const fetched = await runCommand(
        git,
        [
          "--git-dir",
          clone.gitDirectory,
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--quiet",
          "origin",
          ...branches.map(
            (branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
          ),
        ],
        { env: GIT_NETWORK_ENVIRONMENT },
      ).catch(() => undefined);
      if (fetched?.exitCode === 0 && (await heads()) !== before)
        for (const workspaceId of clone.workspaces) moved.add(workspaceId);
    }
    for (const workspaceId of moved)
      this.gitStatus.scheduleRefresh(workspaceId, false, true);
  }

  /**
   * Fetches the workspace's repositories (all of them, or the ones named) at
   * once, and reports what each checkout took: the commits it moved forward
   * by, or why it stayed behind. A repository that fails to fetch reports
   * its error without stopping the others.
   */
  async fetchRepositories(input: {
    workspace: string;
    ids?: string[];
    /** Also move each checkout to the latest base branch; true unless false. */
    pull?: boolean;
  }): Promise<RepositoryFetchOutcome[]> {
    const workspace = await this.workspaces.get(input.workspace);
    const wanted = input.ids ? new Set(input.ids) : undefined;
    const repositories = this.repositories
      .listWorkspaceRepositories(workspace.id)
      .filter(
        (item) =>
          item.status === "ready" &&
          item.libraryRepositoryId &&
          (!wanted || wanted.has(item.id)),
      );
    const git = findExecutable("git");
    const headOf = async (path: string | null) => {
      if (!git || !path) return null;
      const result = await runCommand(git, ["-C", path, "rev-parse", "HEAD"]);
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    };
    const outcomes = await Promise.all(
      repositories.map(async (repository) => {
        const from = await headOf(repository.referencePath);
        const outcome: RepositoryFetchOutcome = {
          repositoryId: repository.id,
          name: repository.name,
          from,
          to: from,
          newCommits: 0,
          commits: [],
          behind: 0,
        };
        let fetched: WorkspaceRepository;
        try {
          fetched = await this.fetchRepository(repository.id, {
            pull: input.pull ?? true,
            remeasure: false,
          });
        } catch (error) {
          return { ...outcome, error: normalizeError(error).message };
        }
        const to = await headOf(repository.referencePath);
        outcome.to = to;
        outcome.behind = fetched.gitStatus?.behind ?? 0;
        if (outcome.behind > 0)
          outcome.heldBack =
            (fetched.gitStatus?.changedFiles ?? 0) > 0
              ? "local-changes"
              : "diverged";
        if (git && from && to && from !== to && repository.referencePath) {
          const [count, log] = await Promise.all([
            runCommand(git, [
              "-C",
              repository.referencePath,
              "rev-list",
              "--count",
              `${from}..${to}`,
            ]),
            runCommand(git, [
              "-C",
              repository.referencePath,
              "log",
              "-n",
              "20",
              "--format=%H%x00%s",
              `${from}..${to}`,
            ]),
          ]);
          outcome.newCommits = Number.parseInt(count.stdout.trim(), 10) || 0;
          outcome.commits = log.stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [hash = "", subject = ""] = line.split("\0");
              return { hash, subject };
            });
        }
        return outcome;
      }),
    );
    // Once for the whole fetch rather than once per repository.
    this.gitStatus.remeasureWorkspace(workspace.id);
    return outcomes;
  }

  async syncRepository(id: string): Promise<WorkspaceRepository> {
    const repository = this.repositories.findWorkspaceRepository(id);
    if (!repository)
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace repository '${id}' was not found`,
      );
    requireReady(repository);
    const workspace = await this.workspaces.getActive(repository.workspaceId);
    requireOnMac(workspace);
    if (
      !repository.referencePath ||
      !repository.libraryRepositoryId ||
      !isPathInside(join(workspace.path, "repos"), repository.referencePath)
    )
      throw new DaedalusError(
        "CONFLICT",
        "Only managed workspace repository checkouts can be synchronized",
      );
    const libraryRepository = this.repositories.findRepositoryLibraryEntry(
      repository.libraryRepositoryId,
    );
    if (!libraryRepository)
      throw new DaedalusError(
        "NOT_FOUND",
        "The shared repository clone is no longer available",
      );
    const refreshed = await this.refreshRepository(libraryRepository);
    // The fetch has already moved this checkout if it could; moving it again
    // is how a checkout that could not says why.
    const current =
      this.repositories.findWorkspaceRepository(repository.id) ?? repository;
    return this.gitStatus.measureRepository(
      await this.moveReferenceCheckout(current, refreshed),
    );
  }

  // Moves one workspace checkout to the fetched tip of its base branch, by
  // fast-forward only, and records where it now is. Checked out by the
  // remote branch's name rather than by hash, so `git status` and
  // `git branch` in it say "HEAD detached at origin/main" instead of a bare
  // hash. Returns the same object when there was nothing to move.
  private async moveReferenceCheckout(
    repository: WorkspaceRepository,
    refreshed: RepositoryLibraryEntry,
  ): Promise<WorkspaceRepository> {
    if (!repository.referencePath)
      throw new DaedalusError(
        "CONFLICT",
        "Only managed workspace repository checkouts can be synchronized",
      );
    const currentStatus =
      await this.gitStatus.repositoryWithGitStatus(repository);
    if ((currentStatus.gitStatus?.changedFiles ?? 0) > 0)
      throw new DaedalusError(
        "CONFLICT",
        `Repository '${repository.name}' has local changes; preserve or discard them before synchronizing`,
      );
    const git = findExecutable("git");
    if (!git)
      throw new DaedalusError("DEPENDENCY", "git is not available on PATH");
    const branchReference = `refs/remotes/origin/${refreshed.defaultBranch}`;
    const target = await runCommand(git, [
      "--git-dir",
      refreshed.gitDirectory,
      "rev-parse",
      `${branchReference}^{commit}`,
    ]);
    const targetCommit = target.stdout.trim();
    if (target.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(targetCommit))
      throw new DaedalusError(
        "DEPENDENCY",
        `Could not resolve the latest ${refreshed.defaultBranch} commit`,
      );
    const current = await runCommand(git, [
      "-C",
      repository.referencePath,
      "rev-parse",
      "HEAD",
    ]);
    const currentCommit = current.stdout.trim();
    if (current.exitCode !== 0)
      throw new DaedalusError(
        "DEPENDENCY",
        `Could not read the current ${repository.name} commit`,
      );
    if (currentCommit === targetCommit) {
      if (
        repository.baseCommit === targetCommit &&
        repository.baseBranch === refreshed.defaultBranch &&
        repository.fetchedAt === refreshed.lastFetchedAt
      )
        return repository;
    } else {
      const fastForward = await runCommand(git, [
        "--git-dir",
        refreshed.gitDirectory,
        "merge-base",
        "--is-ancestor",
        currentCommit,
        targetCommit,
      ]);
      if (fastForward.exitCode !== 0)
        throw new DaedalusError(
          "CONFLICT",
          `Repository '${repository.name}' has diverged from ${refreshed.defaultBranch}; automatic synchronization was stopped`,
        );
      const checkout = await runCommand(git, [
        "-C",
        repository.referencePath,
        "checkout",
        "--quiet",
        "--detach",
        branchReference,
      ]);
      if (checkout.exitCode !== 0)
        throw new DaedalusError(
          "DEPENDENCY",
          `Could not update '${repository.name}': ${checkout.stderr.trim() || checkout.stdout.trim()}`,
        );
    }
    // Read back rather than assumed: a fetch landing between the two reads
    // above moves the branch, and the checkout follows the name.
    const landed = await runCommand(git, [
      "-C",
      repository.referencePath,
      "rev-parse",
      "HEAD",
    ]);
    const updated: WorkspaceRepository = {
      ...repository,
      baseBranch: refreshed.defaultBranch,
      baseCommit:
        landed.exitCode === 0 && landed.stdout.trim()
          ? landed.stdout.trim()
          : targetCommit,
      fetchedAt: refreshed.lastFetchedAt,
    };
    this.repositories.updateWorkspaceRepository(updated);
    return updated;
  }

  async attachRepository(input: {
    workspace: string;
    libraryRepositoryId: string;
  }): Promise<WorkspaceRepository> {
    const workspace = await this.workspaces.getActive(input.workspace);
    requireOnMac(workspace);
    const libraryRepository = this.repositories.findRepositoryLibraryEntry(
      input.libraryRepositoryId,
    );
    if (!libraryRepository)
      throw new DaedalusError(
        "NOT_FOUND",
        `Repository '${input.libraryRepositoryId}' was not found in the library`,
      );
    return this.checkoutLibraryEntry(
      workspace,
      await this.refreshRepository(libraryRepository),
    );
  }

  // Adding a repository and attaching it to the workspace used to be two
  // separate calls, and the second one re-fetched a clone the first had just
  // produced. They are one operation here so that freshness is established
  // exactly once.
  async addAndAttachRepository(input: {
    workspace: string;
    remoteUrl: string;
    name?: string;
    githubNameWithOwner?: string;
  }): Promise<WorkspaceRepository> {
    const workspace = await this.workspaces.getActive(input.workspace);
    requireOnMac(workspace);
    const repository = await this.addRepositoryToLibrary({
      remoteUrl: input.remoteUrl,
      name: input.name,
      githubNameWithOwner: input.githubNameWithOwner,
    });
    return this.checkoutLibraryEntry(workspace, repository);
  }

  /**
   * Attaches without waiting for the clone.
   *
   * The attachment row is written immediately as `preparing` and returned, so
   * the workspace shows the repository arriving and the caller is free. The
   * clone and checkout then run on their own; the row becomes `ready`, or
   * `failed` carrying the reason. Nothing else has to stay open for it, which
   * is what stops a large history from timing out a request that was only
   * waiting.
   */
  async beginAddAndAttachRepository(input: {
    workspace: string;
    remoteUrl: string;
    name?: string;
    githubNameWithOwner?: string;
  }): Promise<WorkspaceRepository> {
    const workspace = await this.workspaces.getActive(input.workspace);
    requireOnMac(workspace);
    const remoteUrl = input.remoteUrl.trim();
    if (!remoteUrl || remoteUrl.length > 2048)
      throw new DaedalusError(
        "VALIDATION",
        "Repository URL or local path must contain 1–2048 characters",
      );
    const existing = this.repositories.findRepositoryLibraryEntry(remoteUrl);
    const name = repositoryName(
      input.name ?? existing?.name ?? remoteRepositoryName(remoteUrl),
    );
    const referencePath = join(workspace.path, "repos", name);
    if (await pathExists(referencePath))
      throw new DaedalusError(
        "CONFLICT",
        `Workspace repository path '${referencePath}' already exists`,
      );
    // The clone's id is chosen here so the row can name where its checkout
    // will be rather than carry a placeholder that has to be corrected later.
    const libraryId = existing?.id ?? crypto.randomUUID();
    const pending: WorkspaceRepository = {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      name,
      canonicalPath:
        existing?.gitDirectory ??
        join(this.config.repositoryRoot, `${libraryId}.git`),
      access: "write",
      libraryRepositoryId: null,
      referencePath: null,
      baseBranch: null,
      baseCommit: null,
      fetchedAt: null,
      createdAt: new Date().toISOString(),
      status: "preparing",
      statusError: null,
    };
    try {
      this.repositories.createWorkspaceRepository(pending);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed"))
        throw new DaedalusError(
          "CONFLICT",
          "This repository path or name is already attached to the workspace",
        );
      throw error;
    }
    this.preparations.set(
      pending.id,
      this.prepareAttachment(pending, workspace, {
        remoteUrl,
        name: input.name,
        githubNameWithOwner: input.githubNameWithOwner,
        id: libraryId,
      }).finally(() => this.preparations.delete(pending.id)),
    );
    return pending;
  }

  /** Settles when nothing is being prepared. Tests and the CLI wait on it. */
  async settlePreparations(): Promise<void> {
    while (this.preparations.size > 0)
      await Promise.all([...this.preparations.values()]);
  }

  private async prepareAttachment(
    pending: WorkspaceRepository,
    workspace: Workspace,
    library: {
      remoteUrl: string;
      name?: string;
      githubNameWithOwner?: string;
      id: string;
    },
  ): Promise<void> {
    try {
      const entry = await this.addRepositoryToLibrary(library);
      const attached = await this.checkoutLibraryEntry(
        workspace,
        entry,
        pending,
      );
      // Quitting mid-clone is normal, and the next start reconciles the row;
      // writing into a closed handle would only throw where nobody is left to
      // catch it.
      if (this.repositories.closed) return;
      this.repositories.updateWorkspaceRepository(attached);
    } catch (error) {
      if (this.repositories.closed) return;
      const row = this.repositories.findWorkspaceRepository(pending.id);
      // Detached while it was being prepared: nothing left to report to.
      if (!row) return;
      this.repositories.updateWorkspaceRepository({
        ...row,
        status: "failed",
        statusError: normalizeError(error).message,
      });
    } finally {
      if (!this.repositories.closed) this.onRepositoriesChanged();
    }
  }

  // `refreshed` must already carry the remote state this checkout is pinned to;
  // callers own the fetch so it is never paid twice.
  private async checkoutLibraryEntry(
    workspace: Workspace,
    refreshed: RepositoryLibraryEntry,
    pending?: WorkspaceRepository,
  ): Promise<WorkspaceRepository> {
    const git = findExecutable("git");
    if (!git)
      throw new DaedalusError("DEPENDENCY", "git is not available on PATH");
    const branchReference = `refs/remotes/origin/${refreshed.defaultBranch}`;
    const commit = await runCommand(git, [
      "--git-dir",
      refreshed.gitDirectory,
      "rev-parse",
      `${branchReference}^{commit}`,
    ]);
    const baseCommit = commit.stdout.trim();
    if (commit.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(baseCommit))
      throw new DaedalusError(
        "DEPENDENCY",
        `Could not resolve the latest ${refreshed.defaultBranch} commit after fetching`,
      );
    const name = repositoryName(refreshed.name);
    const referencePath = join(workspace.path, "repos", name);
    if (await pathExists(referencePath))
      throw new DaedalusError(
        "CONFLICT",
        `Workspace repository path '${referencePath}' already exists`,
      );
    await ensureDirectory(dirname(referencePath));
    const checkout = await runCommand(git, [
      "--git-dir",
      refreshed.gitDirectory,
      "worktree",
      "add",
      "--detach",
      referencePath,
      baseCommit,
    ]);
    if (checkout.exitCode !== 0)
      throw new DaedalusError(
        "CONFLICT",
        `Could not create the workspace repository checkout: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
      );
    // Same commit, now reached by name: `git worktree add` records none, so
    // `git branch` there would say "(no branch)" rather than "HEAD detached at
    // origin/main". Cosmetic, so a failure changes nothing.
    await runCommand(git, [
      "-C",
      referencePath,
      "checkout",
      "--quiet",
      "--detach",
      branchReference,
    ]);
    const item: WorkspaceRepository = {
      id: pending?.id ?? crypto.randomUUID(),
      workspaceId: workspace.id,
      name,
      canonicalPath: refreshed.gitDirectory,
      access: "write",
      libraryRepositoryId: refreshed.id,
      referencePath,
      baseBranch: refreshed.defaultBranch,
      baseCommit,
      fetchedAt: refreshed.lastFetchedAt,
      // A repository was attached when the user asked for it, not when its
      // clone happened to land, and the list is ordered by this.
      createdAt: pending?.createdAt ?? new Date().toISOString(),
      status: "ready",
      statusError: null,
    };
    if (pending) return item;
    try {
      this.repositories.createWorkspaceRepository(item);
    } catch (error) {
      await runCommand(git, [
        "--git-dir",
        refreshed.gitDirectory,
        "worktree",
        "remove",
        "--force",
        referencePath,
      ]);
      if (String(error).includes("UNIQUE constraint failed"))
        throw new DaedalusError(
          "CONFLICT",
          "This repository path or name is already attached to the workspace",
        );
      throw error;
    }
    return item;
  }

  async detachRepository(id: string): Promise<WorkspaceRepository> {
    const repository = this.repositories.findWorkspaceRepository(id);
    if (!repository)
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace repository '${id}' was not found`,
      );
    requireOnMac(await this.workspaces.get(repository.workspaceId));
    if (
      this.repositories
        .listSessionWorktrees({ workspaceId: repository.workspaceId })
        .some((worktree) => worktree.repositoryId === id)
    )
      throw new DaedalusError(
        "CONFLICT",
        "Repository has session worktrees and cannot be detached",
      );
    this.repositories.deleteWorkspaceRepository(id);
    await this.discardReferenceCheckout(repository);
    return repository;
  }

  async discardReferenceCheckout(
    repository: WorkspaceRepository,
  ): Promise<void> {
    const git = findExecutable("git");
    if (!git || !repository.referencePath) return;
    await runCommand(git, [
      "--git-dir",
      repository.canonicalPath,
      "worktree",
      "remove",
      "--force",
      repository.referencePath,
    ]);
    await runCommand(git, [
      "--git-dir",
      repository.canonicalPath,
      "worktree",
      "prune",
    ]);
  }

  // The fetch a new worktree makes is as good as any other, so the shared
  // clone and every workspace checkout of it catch up on it too.
  async afterWorktreeFetch(
    git: string,
    repository: WorkspaceRepository,
  ): Promise<void> {
    if (!repository.libraryRepositoryId) return;
    const library = this.repositories.findRepositoryLibraryEntry(
      repository.libraryRepositoryId,
    );
    if (!library?.defaultBranch) return;
    const refreshed: RepositoryLibraryEntry = {
      ...library,
      lastFetchedAt: new Date().toISOString(),
    };
    this.repositories.updateRepositoryLibraryEntry(refreshed);
    await fastForwardDefaultBranch(
      git,
      library.gitDirectory,
      library.defaultBranch,
    );
    await this.followRemote(refreshed);
  }
}

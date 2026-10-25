import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  findExecutable,
  pathExists,
  runCommand,
  watchFileTree,
  type CommandResult,
  type FileTreeWatcher,
} from "@daedalus/platform";
import type {
  ChangedFile,
  GitStatus,
  PullRequestRef,
  SessionWorktree,
  WorkspaceRepository,
  WorktreeChanges,
} from "../domain";
import type { SqliteRepositories } from "../repositories";
import {
  GH_EXECUTABLE_FALLBACKS,
  GIT_NETWORK_ENVIRONMENT,
} from "./git-commands";
import { IgnoredPaths } from "./git-ignored";
import type { WorkspaceService } from "./workspaces";

// The branch a working tree is on now, or `null` on a detached HEAD. Daedalus
// names a branch when it creates the tree, but an agent is free to switch to
// another one, and every operation that trusted the recorded name then pushed,
// checked and deleted a branch the work had already left.
export async function checkedOutBranch(
  git: string,
  path: string,
): Promise<string | null> {
  const result = await runCommand(git, [
    "--no-optional-locks",
    "-C",
    path,
    "branch",
    "--show-current",
  ]);
  const branch = result.stdout.trim();
  return result.exitCode === 0 && branch ? branch : null;
}

// The name a branch already publishes under on `origin`, when its upstream
// says so. A branch an agent created with `git checkout -b topic origin/main`
// has the base branch as its upstream; that is where it started, not where it
// publishes, so it is never an answer here.
export async function publishedBranchName(
  git: string,
  path: string,
  branch: string,
  baseBranch: string | null,
): Promise<string | null> {
  const result = await runCommand(git, [
    "--no-optional-locks",
    "-C",
    path,
    "for-each-ref",
    "--format=%(upstream:remotename)%00%(upstream:remoteref)",
    `refs/heads/${branch}`,
  ]);
  const [remote, reference = ""] = result.stdout.trim().split("\0");
  const name = reference.replace(/^refs\/heads\//, "");
  return result.exitCode === 0 &&
    remote === "origin" &&
    name &&
    name !== baseBranch
    ? name
    : null;
}

/**
 * Reads `gh pr view --json number,state,headRefOid` and says whether it
 * proves the work at `path` landed, by the same rule the panel uses
 * (`pullRequestHeadLanded`): the pull request is merged, and nothing here is
 * missing from both its head and the base branch. A merged pull request
 * whose head is unrelated proves nothing about the commits here.
 */
export async function pullRequestAnswerHoldsHead(
  git: string,
  path: string,
  stdout: string,
  baseBranch: string | null = null,
): Promise<boolean> {
  let value: Partial<Record<string, unknown>>;
  try {
    value = JSON.parse(stdout) as Partial<Record<string, unknown>>;
  } catch {
    return false;
  }
  const head = value.headRefOid;
  if (
    value.state !== "MERGED" ||
    typeof head !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(head)
  )
    return false;
  return pullRequestHeadLanded(
    git,
    path,
    {
      ref: {
        number: typeof value.number === "number" ? value.number : 0,
        url: "",
        state: "MERGED",
        isDraft: false,
      },
      headRefOid: head,
    },
    baseBranch,
  );
}

// Long enough that a burst of changes does not start a pass each, short enough
// that a badge is never meaningfully behind what the user just did — and the
// actions that change something ask for a pass directly rather than waiting.
const STATUS_REFRESH_INTERVAL_MS = 1_000;

/**
 * The board's pass covers every workspace's worktrees and is asked for on
 * every snapshot, which arrives on every activity change while agents work.
 * Measured on a real machine a pass took four seconds, so unforced passes
 * are held to one per ten seconds; a worktree's delta changes when an agent
 * commits, not several times a second.
 */
const BOARD_STATUS_REFRESH_INTERVAL_MS = 10_000;

/**
 * A pass measures a tree only when something says it changed: its git
 * metadata (HEAD, index, its branch and its base on `origin`) has a new
 * modification time, or a watcher saw a file change inside it. Neither check
 * starts a process. Every live session's worktree has a watcher of its own,
 * in whichever workspace, so an edit shows within about a second anywhere,
 * and the clock (`start`) reads every live tree's git metadata, so a commit
 * or a push shows within `TICK_MS`. These ages are only the safety net for an
 * event both missed. A live session's tree is re-measured at least this
 * often.
 */
const LIVE_TREE_MAX_AGE_MS = 2 * 60_000;
/** Everything else: read-only checkouts and trees of ended sessions. */
const IDLE_TREE_MAX_AGE_MS = 10 * 60_000;

/**
 * File changes arrive in bursts while an agent writes. The first change in a
 * workspace starts a pass this long afterwards, and changes until then ride
 * along with it. Not reset by later changes: an agent that never stops
 * writing would otherwise never get its badge updated.
 */
const FILE_CHANGE_SETTLE_MS = 750;

/**
 * How often the clock looks at every live tree's git metadata. A worktree's
 * git files live in the shared clone, outside the tree its watcher covers,
 * so a commit of files already edited, a push or a checkout made no event
 * at all; this is what notices them. A look is `stat` calls and two small
 * reads per tree, never a process.
 */
const TICK_MS = 5_000;
/**
 * Every this many ticks the clock asks for an ordinary pass over every
 * workspace, so a pull request that moved on GitHub, where nothing in a tree
 * changes, is asked about on `pullRequestDue`'s schedule even while nothing
 * else asks for a pass.
 */
const PASS_EVERY_TICKS = 3;

/**
 * Where a checkout's git metadata lives. A worktree's `.git` is a file that
 * points at its own directory inside the shared clone, and that directory's
 * `commondir` points at the clone's refs.
 */
async function gitDirectories(
  path: string,
): Promise<{ gitDir: string; commonDir: string } | undefined> {
  const dotGit = join(path, ".git");
  const info = await stat(dotGit).catch(() => undefined);
  if (!info) return undefined;
  if (info.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  const pointer = (await readFile(dotGit, "utf8").catch(() => ""))
    .trim()
    .replace(/^gitdir:\s*/, "");
  if (!pointer) return undefined;
  const gitDir = resolve(path, pointer);
  const common = (
    await readFile(join(gitDir, "commondir"), "utf8").catch(() => "")
  ).trim();
  return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
}

/**
 * A cheap fingerprint of everything git metadata that a status depends on:
 * what HEAD names, and when HEAD, the index, the branch, its base on
 * `origin` and the packed refs last changed. Commits, checkouts, staging and
 * fetches all move one of them; an edit to a file does not, which is what the
 * watcher and the maximum age are for. Only `stat` and one small read, never
 * a process, so it costs nothing next to the git it saves.
 *
 * The shared clones are created with `--ref-format=reftable`. There HEAD reads
 * `ref: refs/heads/.invalid` and no ref is a file of its own: every update,
 * a commit included, rewrites `reftable/tables.list` instead — the clone's for
 * branches and remote refs, the worktree's own for its HEAD. Both are read,
 * as are the loose-ref files, so either format is seen.
 */
export async function gitMetadataFingerprint(
  path: string,
  baseBranch: string | null,
): Promise<string | undefined> {
  const directories = await gitDirectories(path);
  if (!directories) return undefined;
  const { gitDir, commonDir } = directories;
  const head = (
    await readFile(join(gitDir, "HEAD"), "utf8").catch(() => "")
  ).trim();
  const branchRef = head.startsWith("ref: ") ? head.slice(5) : undefined;
  const files = [
    join(gitDir, "HEAD"),
    join(gitDir, "index"),
    join(gitDir, "reftable", "tables.list"),
    join(commonDir, "reftable", "tables.list"),
    join(commonDir, "packed-refs"),
    ...(branchRef ? [join(commonDir, branchRef)] : []),
    // The branch as `origin` last showed it, which a push moves. A pull
    // request is opened after a push, so this is what asks `gh` again.
    ...(branchRef?.startsWith("refs/heads/")
      ? [
          join(
            commonDir,
            "refs",
            "remotes",
            "origin",
            branchRef.slice("refs/heads/".length),
          ),
        ]
      : []),
    ...(baseBranch
      ? [join(commonDir, "refs", "remotes", "origin", baseBranch)]
      : []),
  ];
  const stamps = await Promise.all(
    files.map(async (file) => {
      const info = await stat(file).catch(() => undefined);
      return info ? `${info.mtimeMs}:${info.size}` : "-";
    }),
  );
  return [head, ...stamps].join("|");
}

/**
 * At most this many targets are measured at once. Launching a process blocks
 * the JavaScript thread until the child starts, and with endpoint security
 * inspecting every launch that took tens of milliseconds each; launched all
 * at once, a pass held the thread for seconds and typing in a terminal
 * stalled with it. A few at a time lets terminal I/O through in between.
 */
const STATUS_REFRESH_CONCURRENCY = 4;

async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

const statusKey = (path: string) => resolve(path);

const UNAVAILABLE_STATUS: GitStatus = {
  state: "unavailable",
  changedFiles: 0,
  ahead: 0,
  behind: 0,
};

/**
 * Reads `git diff --name-status -z -M` and `git diff --numstat -z -M` into one
 * list. With `-z` a rename is three fields in name-status (`R100`, old, new)
 * and, in numstat, counts followed by an empty path and then old and new.
 * A binary file has `-` for both counts and gets none.
 */
export function parseChangedFiles(
  nameStatus: string,
  numstat: string,
): Omit<ChangedFile, "path">[] {
  const counts = new Map<string, { additions?: number; deletions?: number }>();
  const numberFields = numstat.split("\0");
  for (let index = 0; index < numberFields.length; index += 1) {
    const field = numberFields[index];
    if (!field) continue;
    const [added, deleted, path] = field.split("\t");
    let target = path;
    if (path === "") {
      // A rename: the next two fields are its old and new path.
      target = numberFields[index + 2];
      index += 2;
    }
    if (target === undefined) continue;
    counts.set(
      target,
      added === "-" || deleted === "-"
        ? {}
        : {
            additions: Number.parseInt(added ?? "0", 10) || 0,
            deletions: Number.parseInt(deleted ?? "0", 10) || 0,
          },
    );
  }
  const files: Omit<ChangedFile, "path">[] = [];
  const fields = nameStatus.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const from = fields[index + 1];
      const to = fields[index + 2];
      index += 2;
      if (!from || !to) continue;
      files.push({
        repositoryPath: to,
        ...(letter === "R" ? { originalRepositoryPath: from } : {}),
        status: letter === "R" ? "renamed" : "added",
        ...counts.get(to),
      });
      continue;
    }
    const path = fields[index + 1];
    index += 1;
    if (!path) continue;
    files.push({
      repositoryPath: path,
      status:
        letter === "A" ? "added" : letter === "D" ? "deleted" : "modified",
      ...counts.get(path),
    });
  }
  return files;
}

const statusState = (
  changedFiles: number,
  ahead: number,
  behind: number,
): GitStatus["state"] =>
  changedFiles
    ? "modified"
    : ahead && behind
      ? "diverged"
      : behind
        ? "behind"
        : ahead
          ? "ahead"
          : "clean";

/** What `git status --porcelain=v2 --branch -z` says about a tree. */
export interface PorcelainStatus {
  /** Paths it lists: changed, staged, unmerged and untracked, each once. */
  changedFiles: number;
  /** The branch, or null on a detached HEAD. */
  branch: string | null;
  /** The upstream as `<remote>/<branch>`, when one is configured. */
  upstream?: string;
  /** Ahead of and behind the upstream; absent when the upstream is gone. */
  upstreamAhead?: number;
  upstreamBehind?: number;
}

/**
 * Reads `git status --porcelain=v2 --branch -z`. Each record is one field;
 * a rename or copy (`2`) is followed by one more holding its old path, which
 * is not a second change. Counting the fields of the v1 format instead
 * counted every rename twice, so the row's count and its file list disagreed.
 */
export function parsePorcelainStatus(stdout: string): PorcelainStatus {
  const result: PorcelainStatus = { changedFiles: 0, branch: null };
  const fields = stdout.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.startsWith("# ")) {
      const [, key, ...rest] = field.split(" ");
      const value = rest.join(" ");
      if (key === "branch.head")
        result.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") result.upstream = value;
      else if (key === "branch.ab") {
        const [ahead, behind] = rest;
        result.upstreamAhead = Math.abs(Number.parseInt(ahead ?? "", 10)) || 0;
        result.upstreamBehind =
          Math.abs(Number.parseInt(behind ?? "", 10)) || 0;
      }
      continue;
    }
    const kind = field[0];
    if (kind === "2") index += 1;
    if (kind === "1" || kind === "2" || kind === "u" || kind === "?")
      result.changedFiles += 1;
  }
  return result;
}

/**
 * The command behind both the full measurement and the files-only one. Every
 * untracked file is listed, not one entry per untracked folder, so the count
 * is the length of the file list the panel shows under it.
 */
const PORCELAIN_STATUS_ARGS = [
  "status",
  "--porcelain=v2",
  "--branch",
  "-z",
  "--untracked-files=all",
];

/** The `git status` half of `gitStatusAt`: how many paths it lists. */
async function changedFilesAt(path: string): Promise<number | undefined> {
  const git = findExecutable("git");
  if (!git) return undefined;
  const status = await runCommand(git, [
    "--no-optional-locks",
    "-C",
    path,
    ...PORCELAIN_STATUS_ARGS,
  ]);
  return status.exitCode === 0
    ? parsePorcelainStatus(status.stdout).changedFiles
    : undefined;
}

/**
 * Whether the branch publishes under its own name: an upstream that is the
 * base branch is where `git checkout -b topic origin/main` started, not
 * where the branch publishes, and an upstream git reports no distance to is
 * one that no longer exists on the remote.
 */
export function upstreamState(
  status: PorcelainStatus,
  baseBranch: string | null,
): NonNullable<GitStatus["upstream"]> {
  if (!status.upstream) return "none";
  if (
    baseBranch &&
    status.branch !== baseBranch &&
    status.upstream === `origin/${baseBranch}`
  )
    return "none";
  return status.upstreamAhead === undefined ? "gone" : "tracking";
}

// Shared by the read-only checkout under `repos/` and by session worktrees.
// Both answer the same two questions — what is uncommitted here, and how far
// has this tree moved from the branch it started on — so both are compared
// against `refs/remotes/origin/<baseBranch>` rather than against whatever
// upstream the tree happens to have. What is waiting to be pushed is the
// other question, and that one is asked of the branch's own upstream.
async function gitStatusAt(
  path: string | null,
  baseBranch: string | null,
): Promise<GitStatus> {
  if (!path || !baseBranch) return UNAVAILABLE_STATUS;
  const git = findExecutable("git");
  if (!git || !(await pathExists(path))) return UNAVAILABLE_STATUS;
  const [status, comparison] = await Promise.all([
    runCommand(git, [
      // Reading a working tree must never be able to break what is working in
      // it. `git status` refreshes the index, which takes `index.lock`, and an
      // agent running `git add` in the same worktree at that moment fails with
      // exit 128. This is polled in the background across every tree, so
      // without this flag Daedalus is a race against its own agents.
      "--no-optional-locks",
      "-C",
      path,
      ...PORCELAIN_STATUS_ARGS,
    ]),
    runCommand(git, [
      "-C",
      path,
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...refs/remotes/origin/${baseBranch}`,
    ]),
  ]);
  if (status.exitCode !== 0 || comparison.exitCode !== 0)
    return UNAVAILABLE_STATUS;
  const [ahead = 0, behind = 0] = comparison.stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10) || 0);
  const porcelain = parsePorcelainStatus(status.stdout);
  const changedFiles = porcelain.changedFiles;
  const upstream = upstreamState(porcelain, baseBranch);
  // The size of the diff a reviewer would read. Three-dot, so work that
  // landed on the base branch since this tree branched is not counted as its.
  let filesAhead: number | undefined;
  let unpushed: number | undefined =
    upstream === "tracking"
      ? porcelain.upstreamAhead
      : ahead > 0
        ? undefined
        : 0;
  if (ahead > 0) {
    // "Ahead" says how far the agent moved from the base branch, which stays
    // true after a push and after a merge. What is waiting to be pushed is
    // what the branch's upstream lacks, or, with no upstream to ask, the
    // commits no branch on `origin` holds.
    const [diff, local] = await Promise.all([
      runCommand(git, [
        "--no-optional-locks",
        "-C",
        path,
        "diff",
        "--name-only",
        "-z",
        `refs/remotes/origin/${baseBranch}...HEAD`,
      ]),
      unpushed === undefined
        ? runCommand(git, [
            "-C",
            path,
            "rev-list",
            "--count",
            "HEAD",
            "--not",
            "--remotes=origin",
          ])
        : undefined,
    ]);
    if (diff.exitCode === 0)
      filesAhead = diff.stdout.split("\0").filter(Boolean).length;
    if (local?.exitCode === 0)
      unpushed = Number.parseInt(local.stdout.trim(), 10) || 0;
  }
  return {
    state: statusState(changedFiles, ahead, behind),
    changedFiles,
    ahead,
    behind,
    ...(filesAhead === undefined ? {} : { filesAhead }),
    ...(unpushed === undefined ? {} : { unpushed }),
    upstream,
    ...(porcelain.branch === null ? { detached: true } : {}),
  };
}

/**
 * The shortest time between two questions about one branch. Short, because
 * an agent opens a pull request seconds after it pushes, and the push is
 * what asks: a longer gap here was how a new pull request went unseen until
 * some unrelated pass happened along.
 */
const PULL_REQUEST_MIN_INTERVAL_MS = 15_000;
/** An open pull request: its state, checks and review move on GitHub. */
const OPEN_PULL_REQUEST_REFRESH_MS = 60_000;
/** How long after its refs moved a branch counts as just pushed. */
const PUSH_WINDOW_MS = 5 * 60_000;
/**
 * A live session's branch with no pull request, whose refs have not moved: a
 * pull request can still be opened from the browser or by someone else.
 */
const QUIET_PULL_REQUEST_REFRESH_MS = 5 * 60_000;
/**
 * Everything else: a merged or closed pull request, or the branch of a
 * session that ended. Asked again when its refs move, or this rarely, so a
 * reopened pull request is still seen.
 */
const SETTLED_PULL_REQUEST_REFRESH_MS = 30 * 60_000;

/** One branch whose pull request a pass wants to know about. */
interface PullRequestCheck {
  key: string;
  path: string;
  /** The branch the tree is on, or the one it was last on when detached. */
  branch: string;
  /**
   * The names to look the pull request up by: the branch's own, and the name
   * it publishes under on `origin` when that differs.
   */
  names: string[];
  baseBranch: string | null;
  worktree?: SessionWorktree;
  fingerprint: string | undefined;
}

/** Branch names asked about in one GraphQL request. */
const PULL_REQUEST_BATCH_SIZE = 25;

export interface GitHubRemote {
  host: string;
  owner: string;
  name: string;
}

/**
 * The host, owner and name in a clone URL GitHub hands out: HTTPS, SSH
 * (`git@host:owner/name`) or `ssh://`. Anything else, a local path included,
 * is undefined and is asked about with `gh pr list` instead.
 */
export function parseGitHubRemote(url: string): GitHubRemote | undefined {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:\s]+)(?::\d+)?[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  if (!match) return undefined;
  const [, host, owner, name] = match;
  return host && owner && name ? { host, owner, name } : undefined;
}

/** The fields asked of every pull request, by GraphQL and by `gh pr list`. */
const PULL_REQUEST_GRAPHQL_FIELDS =
  "number url state isDraft headRefOid title mergedAt reviewDecision " +
  "headRepositoryOwner { login } " +
  "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";
const PULL_REQUEST_LIST_FIELDS =
  "number,url,state,isDraft,headRefOid,title,mergedAt,reviewDecision," +
  "headRepositoryOwner,statusCheckRollup";

/** The GraphQL request for `count` branches, `$b0` to `$b<count-1>`. */
export function branchPullRequestQuery(count: number): string {
  const variables = Array.from(
    { length: count },
    (_, index) => `$b${index}: String!`,
  ).join(", ");
  const fields = Array.from(
    { length: count },
    (_, index) =>
      `b${index}: pullRequests(headRefName: $b${index}, first: 5, ` +
      `orderBy: {field: CREATED_AT, direction: DESC}, ` +
      `states: [OPEN, CLOSED, MERGED]) { nodes { ${PULL_REQUEST_GRAPHQL_FIELDS} } }`,
  ).join(" ");
  return `query($owner: String!, $name: String!, ${variables}) { repository(owner: $owner, name: $name) { isFork ${fields} } }`;
}

/** A pull request GitHub listed for a branch name, before one is chosen. */
export interface PullRequestCandidate {
  ref: PullRequestRef;
  headRefOid?: string;
  /** Who owns the repository its head branch is in. */
  owner?: string;
}

const CHECK_FAILURES = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

/**
 * One state for all of a commit's checks. GraphQL gives the rollup's own
 * state; `gh pr list` gives the checks one by one, each a status context
 * (`state`) or a check run (`status` and `conclusion`).
 */
export function checksState(
  rollup: unknown,
): PullRequestRef["checks"] | undefined {
  if (Array.isArray(rollup)) {
    if (rollup.length === 0) return undefined;
    let pending = false;
    for (const item of rollup as Array<Record<string, unknown>>) {
      const conclusion = String(item.conclusion ?? item.state ?? "");
      if (CHECK_FAILURES.has(conclusion)) return "failing";
      if (
        (item.status !== undefined && item.status !== "COMPLETED") ||
        conclusion === "PENDING" ||
        conclusion === "EXPECTED" ||
        conclusion === ""
      )
        pending = true;
    }
    return pending ? "pending" : "passing";
  }
  const state = (rollup as { state?: unknown } | null | undefined)?.state;
  if (state === "SUCCESS") return "passing";
  if (state === "FAILURE" || state === "ERROR") return "failing";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return undefined;
}

const REVIEW_DECISIONS = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
} as const;

/**
 * Reads one pull request as GraphQL or `gh pr list --json` gives it.
 * Anything incomplete is no pull request: a link that might be wrong is
 * worse than no link. The title, merge time, checks and review are extras
 * and may be missing.
 */
export function parsePullRequestNode(
  value: Partial<Record<string, unknown>>,
): PullRequestCandidate | undefined {
  const state = value.state;
  if (
    typeof value.number !== "number" ||
    !Number.isInteger(value.number) ||
    typeof value.url !== "string" ||
    !/^https:\/\//.test(value.url) ||
    (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED")
  )
    return undefined;
  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.trim()
      : undefined;
  const mergedAt =
    typeof value.mergedAt === "string" &&
    Number.isFinite(Date.parse(value.mergedAt))
      ? value.mergedAt
      : undefined;
  const commit = (
    value.commits as
      | { nodes?: Array<{ commit?: { statusCheckRollup?: unknown } }> }
      | undefined
  )?.nodes?.[0]?.commit;
  const checks =
    state === "OPEN"
      ? checksState(commit ? commit.statusCheckRollup : value.statusCheckRollup)
      : undefined;
  const review =
    state === "OPEN" && typeof value.reviewDecision === "string"
      ? REVIEW_DECISIONS[value.reviewDecision as keyof typeof REVIEW_DECISIONS]
      : undefined;
  const head =
    typeof value.headRefOid === "string" &&
    /^[0-9a-f]{40,64}$/i.test(value.headRefOid)
      ? value.headRefOid
      : undefined;
  const owner = (value.headRepositoryOwner as { login?: unknown } | null)
    ?.login;
  return {
    ref: {
      number: value.number,
      url: value.url,
      state,
      isDraft: value.isDraft === true,
      ...(title ? { title } : {}),
      ...(state === "MERGED" && mergedAt ? { mergedAt } : {}),
      ...(checks ? { checks } : {}),
      ...(review ? { review } : {}),
    },
    ...(head ? { headRefOid: head } : {}),
    ...(typeof owner === "string" ? { owner } : {}),
  };
}

/**
 * Reads `gh pr view --json number,url,state,isDraft,title,mergedAt`, the
 * single-object form of `parsePullRequestNode`.
 */
export function parsePullRequestView(
  stdout: string,
): PullRequestRef | undefined {
  try {
    return parsePullRequestNode(
      JSON.parse(stdout) as Partial<Record<string, unknown>>,
    )?.ref;
  } catch {
    return undefined;
  }
}

/**
 * How a pull request's head commit relates to this tree's HEAD: one holds the
 * other, neither does, or the head is a commit this clone does not have.
 */
export type HeadRelation = "related" | "unrelated" | "unknown";

/**
 * The pull request a branch's row shows from what GitHub listed under each
 * of its names, newest first. Only one whose head this tree's HEAD holds,
 * or that holds HEAD, can be this work's; a head that shares no history with
 * HEAD is an older pull request that used the same branch name. A head this
 * clone lacks cannot be checked, and is accepted only under the branch's
 * own name, never under an upstream's name that may be a parent branch's.
 * Within what is left: this repository's owner over a fork, then a related
 * head over an unknown one, then an open pull request over the rest.
 */
export function choosePullRequest(
  candidates: ReadonlyArray<
    PullRequestCandidate & { relation: HeadRelation; byOwnName: boolean }
  >,
  owner: string,
): PullRequestCandidate | undefined {
  const own = candidates.filter(
    (candidate) => candidate.owner?.toLowerCase() === owner.toLowerCase(),
  );
  const pool = (own.length ? own : candidates).filter(
    (candidate) =>
      candidate.relation === "related" ||
      (candidate.relation === "unknown" && candidate.byOwnName),
  );
  const rank = (candidate: (typeof pool)[number]) =>
    (candidate.relation === "related" ? 0 : 2) +
    (candidate.ref.state === "OPEN" ? 0 : 1);
  return [...pool].sort((left, right) => rank(left) - rank(right))[0];
}

/**
 * Asks GitHub about several branch names of one repository in one request.
 * Each answer is the pull requests listed for that name, newest first. The
 * whole result is undefined when the request failed, and for a fork, whose
 * pull requests live in the repository it was forked from.
 */
export async function queryBranchPullRequests(
  gh: string,
  remote: GitHubRemote,
  branches: readonly string[],
  cwd: string,
): Promise<Array<Array<Record<string, unknown>>> | undefined> {
  const response = await runCommand(
    gh,
    [
      "api",
      "graphql",
      "--hostname",
      remote.host,
      "-f",
      `query=${branchPullRequestQuery(branches.length)}`,
      "-f",
      `owner=${remote.owner}`,
      "-f",
      `name=${remote.name}`,
      ...branches.flatMap((branch, index) => ["-f", `b${index}=${branch}`]),
    ],
    { cwd, env: { GH_PROMPT_DISABLED: "1" } },
  ).catch(() => undefined);
  if (!response || response.exitCode !== 0) return undefined;
  let repository: Record<string, unknown> | undefined;
  try {
    repository = (
      JSON.parse(response.stdout) as {
        data?: { repository?: Record<string, unknown> };
      }
    ).data?.repository;
  } catch {
    return undefined;
  }
  if (!repository || repository.isFork !== false) return undefined;
  const answers: Array<Array<Record<string, unknown>>> = [];
  for (let index = 0; index < branches.length; index += 1) {
    const nodes = (repository[`b${index}`] as { nodes?: unknown } | null)
      ?.nodes;
    // A branch the answer leaves out is not known to have no pull request.
    if (!Array.isArray(nodes)) return undefined;
    answers.push(nodes as Array<Record<string, unknown>>);
  }
  return answers;
}

/**
 * `gh pr list --head <branch>` for one branch name, in the tree, so `gh`
 * picks the repository the way it does for the user: the pull requests
 * listed, or undefined when it could not say (offline, rate limited, signed
 * out).
 */
async function listBranchPullRequests(
  gh: string,
  path: string,
  branch: string,
): Promise<Array<Record<string, unknown>> | undefined> {
  const result = await runCommand(
    gh,
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "5",
      "--json",
      PULL_REQUEST_LIST_FIELDS,
    ],
    { cwd: path, env: { GH_PROMPT_DISABLED: "1" } },
  ).catch(() => undefined);
  if (!result || result.exitCode !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout) as unknown;
    return Array.isArray(value)
      ? (value as Array<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether this clone has a commit, without fetching it. */
async function hasCommit(git: string, path: string, oid: string) {
  return (
    (await runCommand(git, ["-C", path, "cat-file", "-e", `${oid}^{commit}`]))
      .exitCode === 0
  );
}

/**
 * Brings a pull request's head into the clone when it is missing, as it is
 * after "Update branch" or a suggestion committed on GitHub. Objects only:
 * no ref moves and `FETCH_HEAD` is not written.
 */
async function fetchPullRequestHead(
  git: string,
  path: string,
  pull: PullRequestCandidate,
): Promise<boolean> {
  if (!pull.headRefOid) return false;
  if (await hasCommit(git, path, pull.headRefOid)) return true;
  await runCommand(
    git,
    [
      "-C",
      path,
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--quiet",
      "origin",
      `refs/pull/${pull.ref.number}/head`,
    ],
    { env: GIT_NETWORK_ENVIRONMENT },
  ).catch(() => undefined);
  return hasCommit(git, path, pull.headRefOid);
}

/** How a pull request's head relates to HEAD; see `HeadRelation`. */
export async function headRelation(
  git: string,
  path: string,
  pull: PullRequestCandidate,
): Promise<HeadRelation> {
  if (!pull.headRefOid || !(await fetchPullRequestHead(git, path, pull)))
    return "unknown";
  const holds = async (ancestor: string, descendant: string) =>
    (
      await runCommand(git, [
        "-C",
        path,
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
      ])
    ).exitCode === 0;
  return (await holds("HEAD", pull.headRefOid)) ||
    (await holds(pull.headRefOid, "HEAD"))
    ? "related"
    : "unrelated";
}

/**
 * Whether a merged pull request holds the work in this tree: no commit here,
 * merge commits aside, is missing from both its head and the base branch.
 * HEAD may be the head itself, an ancestor of it, or the head with the base
 * branch merged in afterwards; new work committed after the merge is not
 * landed, and the row says so.
 */
export async function pullRequestHeadLanded(
  git: string,
  path: string,
  pull: PullRequestCandidate,
  baseBranch: string | null,
): Promise<boolean> {
  if (pull.ref.state !== "MERGED" || !pull.headRefOid) return false;
  if (!(await fetchPullRequestHead(git, path, pull))) return false;
  const base = baseBranch ? `refs/remotes/origin/${baseBranch}` : undefined;
  const hasBase =
    base !== undefined &&
    (
      await runCommand(git, [
        "-C",
        path,
        "rev-parse",
        "--verify",
        "--quiet",
        base,
      ])
    ).exitCode === 0;
  const result = await runCommand(git, [
    "-C",
    path,
    "rev-list",
    "--count",
    "--no-merges",
    "HEAD",
    `^${pull.headRefOid}`,
    ...(hasBase ? [`^${base}`] : []),
  ]);
  return result.exitCode === 0 && result.stdout.trim() === "0";
}

/**
 * The cache entry after `gh` could not answer: the pull request and landed
 * HEAD it had stay, the time it was asked moves on, and it is marked as not
 * confirmed.
 */
export function keptPullRequest<T extends { checkedAt: number }>(
  cached: T | undefined,
  now: number,
): T | { checkedAt: number; stale: true } {
  return cached
    ? { ...cached, checkedAt: now, stale: true }
    : { checkedAt: now, stale: true };
}

/** Whether a branch's pull request is worth asking `gh` about again. */
export function pullRequestDue(
  cached:
    | {
        checkedAt: number;
        branch?: string;
        value?: Pick<PullRequestRef, "state">;
        fingerprint?: string;
        movedAt?: number;
      }
    | undefined,
  fingerprint: string | undefined,
  now = Date.now(),
  options: { branch?: string; live?: boolean } = {},
): boolean {
  if (!cached) return true;
  // An answer about another branch says nothing about this one.
  if (options.branch !== undefined && cached.branch !== options.branch)
    return true;
  const age = now - cached.checkedAt;
  if (age < PULL_REQUEST_MIN_INTERVAL_MS) return false;
  // The refs moved since the last answer, or lately, as a push does just
  // before `gh pr create`: the check that ran in between must not hold the
  // next one off.
  if (
    fingerprint === undefined ||
    cached.fingerprint !== fingerprint ||
    (cached.movedAt !== undefined && now - cached.movedAt < PUSH_WINDOW_MS)
  )
    return true;
  if (cached.value?.state === "OPEN")
    return age >= OPEN_PULL_REQUEST_REFRESH_MS;
  if (!cached.value && options.live !== false)
    return age >= QUIET_PULL_REQUEST_REFRESH_MS;
  return age >= SETTLED_PULL_REQUEST_REFRESH_MS;
}

const samePullRequest = (
  left: PullRequestRef | undefined,
  right: PullRequestRef | undefined,
) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.number === right.number &&
    left.url === right.url &&
    left.state === right.state &&
    left.isDraft === right.isDraft &&
    left.title === right.title &&
    left.checks === right.checks &&
    left.review === right.review);

/** What `git status` lists in one tree, with paths relative to the tree. */
export interface TreeChanges {
  /** HEAD, or null when the tree has no commit yet. */
  base: string | null;
  files: Omit<ChangedFile, "path">[];
}

/**
 * What the git status monitor runs against a working tree. Every call starts
 * git processes; the monitor's job is to make as few of them as it can, and a
 * test sees how many by counting calls on a fake. A child process cannot be
 * counted from inside this one, because Bun gives children the environment it
 * started with.
 */
export interface GitMeasure {
  /** The tree's state against `refs/remotes/origin/<baseBranch>`. */
  status(path: string | null, baseBranch: string | null): Promise<GitStatus>;
  /**
   * Only the count of paths `git status` lists: one process where `status`
   * takes up to four. Enough when the git metadata has not moved, since then
   * the distance from the base branch has not either.
   */
  changedFiles(path: string): Promise<number | undefined>;
  /**
   * What `git status` reports, as VS Code's Source Control lists it: the
   * working tree and the index against HEAD, plus untracked files. Committed
   * work is not here; it is in the worktree's commits.
   */
  changes(path: string): Promise<TreeChanges>;
}

async function gitChangesAt(path: string): Promise<TreeChanges> {
  const git = findExecutable("git");
  if (!git) return { base: null, files: [] };
  const run = (args: string[]) =>
    runCommand(git, ["--no-optional-locks", "-C", path, ...args]);
  const [head, nameStatus, numstat, untracked] = await Promise.all([
    run(["rev-parse", "HEAD"]),
    run(["diff", "--name-status", "-z", "-M", "HEAD"]),
    run(["diff", "--numstat", "-z", "-M", "HEAD"]),
    run(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return {
    base: head.exitCode === 0 ? head.stdout.trim() || null : null,
    files: [
      ...(nameStatus.exitCode === 0
        ? parseChangedFiles(nameStatus.stdout, numstat.stdout)
        : []),
      ...(untracked.exitCode === 0
        ? untracked.stdout
            .split("\0")
            .filter(Boolean)
            .map((repositoryPath) => ({
              repositoryPath,
              status: "untracked" as const,
            }))
        : []),
    ],
  };
}

/** The real thing: git on this machine. */
export const gitMeasure: GitMeasure = {
  status: gitStatusAt,
  changedFiles: changedFilesAt,
  changes: gitChangesAt,
};

/**
 * Measures the working trees Daedalus shows, the checkouts under `repos/` and
 * the session worktrees, and keeps the answers: git status, the branch a
 * worktree is on, and its pull request. Listings read the cache and never wait
 * for git; a pass runs behind them, coalesced and rate limited, and measures
 * only the trees that something says changed.
 */
export class GitStatusMonitor {
  /** Last measured status per working tree, keyed by path. */
  private readonly gitStatusCache = new Map<string, GitStatus>();
  /**
   * Last `gh` answer per worktree path, also kept in SQLite so a restart
   * shows it at once. `checkedAt` is kept even when nothing was found, so a
   * branch with no pull request is not asked about every second.
   */
  private readonly pullRequestCache = new Map<
    string,
    {
      checkedAt: number;
      /** The branch the answer is about; another branch's is not shown. */
      branch?: string;
      value?: PullRequestRef;
      /** The last question failed, so `value` is an older answer. */
      stale?: boolean;
      /**
       * The HEAD a merged pull request was found to hold. Merged is final, so
       * while HEAD stays put there is nothing more to ask `gh`.
       */
      landedHead?: string;
      /** The tree's git metadata fingerprint when `gh` was asked. */
      fingerprint?: string;
      /** When an answer first saw that fingerprint, so when the refs moved. */
      movedAt?: number;
    }
  >();
  private statusRefresh?: Promise<void>;
  /**
   * What the next pass has to cover. `null` is every workspace, which is what
   * the board asks for; a string is one. Two different single workspaces
   * asking during one pass widen it to every workspace rather than dropping
   * one of them.
   */
  private statusRefreshAgain: string | null | undefined;
  /** Whether the queued pass must measure every tree, not only changed ones. */
  private statusRefreshAgainForce = false;
  private lastStatusRefreshAt = 0;
  private lastBoardRefreshAt = 0;
  /**
   * What each tree looked like when it was last measured, keyed like
   * `gitStatusCache`: its git metadata fingerprint, the watcher's change count
   * for it, and when. A pass skips a tree whose fingerprint and change count
   * still match until the record is older than its maximum age.
   */
  private readonly measuredTrees = new Map<
    string,
    {
      fingerprint: string | undefined;
      generation: number;
      at: number;
      branch: string | null;
    }
  >();
  /** File changes the watcher has seen inside each tree, keyed by path. */
  private readonly treeGenerations = new Map<string, number>();
  /** The last `worktreeChanges` answer per tree, reused while nothing moved. */
  private readonly changesCache = new Map<
    string,
    {
      fingerprint: string | undefined;
      generation: number;
      at: number;
      value: WorktreeChanges | undefined;
    }
  >();
  /**
   * One watcher per live session's worktree, keyed by path. The workspace
   * watcher covers only the workspace on screen; these are what make an
   * agent's edit in any other workspace show without waiting for a maximum
   * age. Kept in step with the sessions by every pass.
   */
  private readonly treeWatchers = new Map<string, FileTreeWatcher>();
  /** The live trees the clock looks at, kept in step by every pass. */
  private readonly liveTrees = new Map<
    string,
    { path: string; workspaceId: string; baseBranch: string | null }
  >();
  private ticker?: ReturnType<typeof setInterval>;
  private ticks = 0;
  private ticking = false;
  /** What git ignores in each tree, so changes there cost no pass. */
  private readonly ignored = new IgnoredPaths();
  /** Workspaces whose file changes are waiting out `FILE_CHANGE_SETTLE_MS`. */
  private readonly settlingWorkspaces = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    /** Called when a measured status or pull request changed. */
    private readonly onRepositoriesChanged: () => void = () => {},
    private readonly measure: GitMeasure = gitMeasure,
  ) {
    this.loadPullRequests();
  }

  /** What the last run knew about each branch's pull request. */
  private loadPullRequests(): void {
    let records: ReturnType<SqliteRepositories["listWorktreePullRequests"]>;
    try {
      records = this.repositories.listWorktreePullRequests();
    } catch {
      return;
    }
    for (const record of records) {
      let value: PullRequestRef | undefined;
      try {
        const parsed = record.pullRequest
          ? (JSON.parse(record.pullRequest) as PullRequestRef)
          : undefined;
        if (
          parsed &&
          typeof parsed.number === "number" &&
          typeof parsed.url === "string"
        )
          value = parsed;
      } catch {
        value = undefined;
      }
      this.pullRequestCache.set(statusKey(record.path), {
        checkedAt: Date.parse(record.checkedAt) || 0,
        branch: record.branchName,
        ...(value ? { value } : {}),
        ...(record.landedHead ? { landedHead: record.landedHead } : {}),
      });
    }
  }

  /**
   * The pull request cached for a worktree, when it is about the branch the
   * tree is on, or was last on before HEAD was detached.
   */
  private cachedPullRequest(worktree: SessionWorktree) {
    const cached = this.pullRequestCache.get(statusKey(worktree.path));
    if (!cached) return undefined;
    const branch =
      this.measuredTrees.get(statusKey(worktree.path))?.branch ??
      worktree.branchName;
    return cached.branch === undefined || cached.branch === branch
      ? cached
      : undefined;
  }

  /**
   * A cloud workspace's trees are in its pod, and what is left on this Mac
   * is a backup that `git status` would write to (it refreshes the index).
   * They are not measured.
   */
  private inCloud(workspaceId: string): boolean {
    return this.repositories.workspacePlace(workspaceId).place === "cloud";
  }

  /** A worktree with whatever status and pull request the cache holds. */
  withMeasurements(worktree: SessionWorktree): SessionWorktree {
    const key = statusKey(worktree.path);
    const status = this.gitStatusCache.get(key);
    const cached = this.cachedPullRequest(worktree);
    return {
      ...worktree,
      ...(status ? { gitStatus: status } : {}),
      ...(cached?.value ? { pullRequest: cached.value } : {}),
      ...(cached?.landedHead ? { landed: true } : {}),
      ...(cached?.value && cached.stale ? { pullRequestStale: true } : {}),
    };
  }

  /**
   * Measures every working tree in a workspace and announces when the answers
   * change.
   *
   * Coalesced and rate limited: a burst of changes produces one pass, not one
   * per change. `force` is for the actions that just moved something and want
   * the row to catch up immediately.
   */
  scheduleRefresh(
    workspaceId: string | null,
    force = false,
    /**
     * Run now, past the rate limit, but measure only what changed. For a
     * change that is known to have happened, such as a file the watcher saw.
     */
    urgent = force,
  ): void {
    if (this.statusRefresh) {
      // Only a forced or urgent request is worth a second pass; an ordinary
      // one is already being answered by the pass in flight or the next
      // listing.
      if (urgent) {
        this.statusRefreshAgain =
          this.statusRefreshAgain === undefined ||
          this.statusRefreshAgain === workspaceId
            ? workspaceId
            : null;
        this.statusRefreshAgainForce ||= force;
      }
      return;
    }
    const since = Date.now() - this.lastStatusRefreshAt;
    if (!urgent && since < STATUS_REFRESH_INTERVAL_MS) return;
    if (
      !urgent &&
      workspaceId === null &&
      Date.now() - this.lastBoardRefreshAt < BOARD_STATUS_REFRESH_INTERVAL_MS
    )
      return;
    if (workspaceId === null) this.lastBoardRefreshAt = Date.now();
    this.statusRefresh = this.refreshGitStatuses(workspaceId, force)
      .catch(() => undefined)
      .finally(() => {
        this.statusRefresh = undefined;
        this.lastStatusRefreshAt = Date.now();
        const again = this.statusRefreshAgain;
        const againForce = this.statusRefreshAgainForce;
        if (again !== undefined) {
          this.statusRefreshAgain = undefined;
          this.statusRefreshAgainForce = false;
          this.scheduleRefresh(again, againForce, true);
        }
      });
  }

  /**
   * Records the workspace watcher's file changes against the trees they fall
   * in, so the next pass and the next `worktreeChanges` measure those trees
   * and only those, then asks for that pass once the burst settles. A batch
   * too large to describe marks every tree in the workspace.
   */
  noteFilesChanged(
    workspaceId: string,
    changes: readonly { path: string }[],
    overflow: boolean,
  ): void {
    const workspace = this.repositories.findWorkspace(workspaceId);
    if (!workspace) return;
    const roots = this.treePaths(workspaceId).map((path) => ({
      key: statusKey(path),
      root: relative(workspace.path, path).split(sep).join("/"),
    }));
    for (const { key, root } of roots)
      if (
        overflow ||
        changes.some(
          (change) =>
            change.path === root ||
            (change.path.startsWith(`${root}/`) &&
              !this.ignored.matches(key, change.path.slice(root.length + 1))),
        )
      )
        this.markTreeChanged(key, workspaceId);
  }

  /** Marks one tree changed and asks for its workspace's pass once settled. */
  private markTreeChanged(key: string, workspaceId: string): void {
    this.treeGenerations.set(key, (this.treeGenerations.get(key) ?? 0) + 1);
    if (this.settlingWorkspaces.has(workspaceId)) return;
    this.settlingWorkspaces.set(
      workspaceId,
      setTimeout(() => {
        this.settlingWorkspaces.delete(workspaceId);
        this.scheduleRefresh(workspaceId, false, true);
      }, FILE_CHANGE_SETTLE_MS),
    );
  }

  /**
   * Forgets what every tree in the workspace looked like and measures them
   * all now. For the moments the user says something changed, such as Fetch,
   * and for anything Daedalus did that the cheap checks might not see.
   */
  remeasureWorkspace(workspaceId: string): void {
    for (const path of this.treePaths(workspaceId)) {
      this.measuredTrees.delete(statusKey(path));
      this.changesCache.delete(statusKey(path));
    }
    this.scheduleRefresh(workspaceId, true);
  }

  /**
   * Watches exactly the worktrees of live sessions, opening a watcher for a
   * new one and closing the watcher of one whose session ended. Cheap enough
   * to run at the start of every pass: it reads the database and compares.
   */
  private syncTreeWatchers(): void {
    const wanted = new Map<
      string,
      { path: string; workspaceId: string; baseBranch: string | null }
    >();
    for (const worktree of this.repositories.listSessionWorktrees({})) {
      const session = this.repositories.findAgent(worktree.sessionId);
      if (
        session &&
        this.sessionIsLive(session.id) &&
        !this.inCloud(session.workspaceId)
      )
        wanted.set(statusKey(worktree.path), {
          path: worktree.path,
          workspaceId: session.workspaceId,
          baseBranch:
            this.repositories.findWorkspaceRepository(worktree.repositoryId)
              ?.baseBranch ?? null,
        });
    }
    this.liveTrees.clear();
    for (const [key, tree] of wanted) this.liveTrees.set(key, tree);
    for (const [key, watcher] of this.treeWatchers)
      if (!wanted.has(key)) {
        watcher.close();
        this.treeWatchers.delete(key);
        this.ignored.forget(key);
      }
    for (const [key, worktree] of wanted) {
      if (this.treeWatchers.has(key)) continue;
      try {
        this.treeWatchers.set(
          key,
          watchFileTree({
            root: worktree.path,
            // What git ignores never changes a status, and dropping it here,
            // before the overflow count, keeps a build's output from
            // starting a pass.
            ignorePath: (path) => this.ignored.matches(key, path),
            // Any other change, or a burst too big to describe, means the
            // tree is worth measuring; which file does not matter here.
            onChanges: () => this.markTreeChanged(key, worktree.workspaceId),
            // A tree that cannot be watched still has its maximum age.
            onError: () => undefined,
          }),
        );
      } catch {
        // Same: the maximum age covers a tree with no watcher.
      }
    }
  }

  /**
   * Starts the clock. Only a long-running process starts it, the desktop
   * app; the CLI measures what it is asked about and exits.
   */
  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick(), TICK_MS);
    this.scheduleRefresh(null);
  }

  /**
   * One look at every live tree's git metadata: a tree whose fingerprint
   * moved since it was measured is marked changed, which measures it within
   * a second. Every few ticks, an ordinary pass over every workspace.
   */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.ticks += 1;
      for (const [key, tree] of this.liveTrees) {
        const record = this.measuredTrees.get(key);
        if (!record) continue;
        const fingerprint = await gitMetadataFingerprint(
          tree.path,
          tree.baseBranch,
        );
        if (fingerprint !== undefined && fingerprint !== record.fingerprint)
          this.markTreeChanged(key, tree.workspaceId);
      }
      if (this.ticks % PASS_EVERY_TICKS === 0) this.scheduleRefresh(null);
    } catch {
      // The next tick looks again.
    } finally {
      this.ticking = false;
    }
  }

  /** Stops every watcher and timer, so a closing app holds nothing open. */
  close(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    for (const watcher of this.treeWatchers.values()) watcher.close();
    this.treeWatchers.clear();
    for (const timer of this.settlingWorkspaces.values()) clearTimeout(timer);
    this.settlingWorkspaces.clear();
  }

  /** Every tree a workspace pass can measure: checkouts and worktrees. */
  private treePaths(workspaceId: string): string[] {
    return [
      ...this.repositories
        .listWorkspaceRepositories(workspaceId)
        .flatMap((item) => (item.referencePath ? [item.referencePath] : [])),
      ...this.repositories
        .listSessionWorktrees({ workspaceId })
        .map((item) => item.path),
    ];
  }

  /** Whether a tree has changed, or gone unmeasured too long, since its record. */
  private async treeIsDue(
    record:
      | { fingerprint: string | undefined; generation: number; at: number }
      | undefined,
    key: string,
    fingerprint: string | undefined,
    maxAge: number,
  ): Promise<boolean> {
    return (
      !record ||
      fingerprint === undefined ||
      record.fingerprint !== fingerprint ||
      record.generation !== (this.treeGenerations.get(key) ?? 0) ||
      Date.now() - record.at >= maxAge
    );
  }

  private sessionIsLive(sessionId: string): boolean {
    const session = this.repositories.findAgent(sessionId);
    return Boolean(
      session &&
      !session.archivedAt &&
      (session.status === "running" || session.status === "starting"),
    );
  }

  private pullRequestDue(
    key: string,
    fingerprint: string | undefined,
    branch: string,
    live: boolean,
  ): boolean {
    return pullRequestDue(
      this.pullRequestCache.get(key),
      fingerprint,
      Date.now(),
      {
        branch,
        live,
      },
    );
  }

  private async refreshGitStatuses(
    workspaceId: string | null,
    force = false,
  ): Promise<void> {
    this.syncTreeWatchers();
    const places = new Map<string, boolean>();
    const inCloud = (item: WorkspaceRepository) => {
      if (!places.has(item.workspaceId))
        places.set(item.workspaceId, this.inCloud(item.workspaceId));
      return places.get(item.workspaceId)!;
    };
    const listed = this.repositories.listWorkspaceRepositories(
      workspaceId ?? undefined,
    );
    const repositories = listed.filter((item) => !inCloud(item));
    const cloudRepositories = new Set(
      listed.filter(inCloud).map((item) => item.id),
    );
    const baseBranches = new Map(
      repositories.map((item) => [item.id, item.baseBranch]),
    );
    // Only a session worktree carries a branch, and only a branch can have a
    // pull request; the read-only checkouts under `repos/` never do. The
    // board's pass (every workspace) skips those checkouts entirely: it never
    // shows them, and on a real machine they were most of the pass.
    const targets: Array<{
      path: string | null;
      baseBranch: string | null;
      worktree?: SessionWorktree;
    }> = [
      ...(workspaceId === null
        ? []
        : repositories.map((item) => ({
            path: item.status === "ready" ? item.referencePath : null,
            baseBranch: item.baseBranch,
          }))),
      ...this.repositories
        .listSessionWorktrees(workspaceId ? { workspaceId } : {})
        .filter((item) => !cloudRepositories.has(item.repositoryId))
        .map((item) => ({
          path: item.path,
          baseBranch: baseBranches.get(item.repositoryId) ?? null,
          worktree: item,
        })),
    ];
    let changed = false;
    const pullRequestChecks: PullRequestCheck[] = [];
    await forEachWithConcurrency(
      targets,
      STATUS_REFRESH_CONCURRENCY,
      async (target) => {
        if (!target.path) return;
        const key = statusKey(target.path);
        const previous = this.gitStatusCache.get(key);
        const record = this.measuredTrees.get(key);
        // Read before measuring, so a change that lands while git runs is
        // seen as a change on the next pass rather than absorbed into this one.
        const generation = this.treeGenerations.get(key) ?? 0;
        const fingerprint = await gitMetadataFingerprint(
          target.path,
          target.baseBranch,
        );
        const maxAge =
          target.worktree && this.sessionIsLive(target.worktree.sessionId)
            ? LIVE_TREE_MAX_AGE_MS
            : IDLE_TREE_MAX_AGE_MS;
        const due =
          force ||
          !previous ||
          (await this.treeIsDue(record, key, fingerprint, maxAge));
        const git = findExecutable("git");
        let status = previous;
        let current = record?.branch ?? null;
        // Due only because the watcher saw a file change: HEAD, the index and
        // the refs are as they were, so the branch and the distance from the
        // base are too, and only the count of changed paths can have moved.
        // That is one git process instead of three to five. The record keeps
        // its time, so the full measurement still comes round at the maximum
        // age. An agent's edit is often followed at once by `git add` and
        // `git commit`, so the fingerprint is read again after the count: if
        // the metadata moved meanwhile, the full measurement runs instead of
        // an answer that is already behind.
        let filesOnly =
          due &&
          !force &&
          previous &&
          // A tree git could not measure has no distance from its base to
          // keep, so it is measured in full until it can be.
          previous.state !== "unavailable" &&
          record &&
          fingerprint !== undefined &&
          record.fingerprint === fingerprint &&
          Date.now() - record.at < maxAge
            ? await this.measure.changedFiles(target.path)
            : undefined;
        if (
          filesOnly !== undefined &&
          (await gitMetadataFingerprint(target.path, target.baseBranch)) !==
            fingerprint
        )
          filesOnly = undefined;
        if (filesOnly !== undefined && previous && record) {
          status = {
            ...previous,
            state: statusState(filesOnly, previous.ahead, previous.behind),
            changedFiles: filesOnly,
          };
          this.measuredTrees.set(key, { ...record, generation });
        } else if (due) {
          status = await this.measure.status(target.path, target.baseBranch);
          current =
            target.worktree && git
              ? await checkedOutBranch(git, target.path)
              : null;
          this.measuredTrees.set(key, {
            fingerprint,
            generation,
            at: Date.now(),
            branch: current,
          });
          if (
            git &&
            target.worktree &&
            (await this.recordBranch(git, target.worktree, current)) !==
              target.worktree
          )
            changed = true;
        }
        if (!status) return;
        // Every branch is asked about, whatever its distance from the base:
        // a branch merged with a merge commit or rebased is fully on the base
        // and is ahead by nothing, and asking only branches with commits
        // ahead left most merged pull requests unshown. A detached HEAD is
        // asked about by the branch it was last on, which is what an agent
        // leaves behind after its pull request merged. How often is
        // `pullRequestDue`'s business: on its own clock, not the tree's,
        // since a pull request moves on GitHub where nothing here does. The
        // checks are collected and asked after the pass, so every branch of
        // one GitHub repository shares a single request.
        const pullRequestBranch =
          current ?? (status.detached ? target.worktree?.branchName : null);
        if (
          git &&
          target.worktree &&
          pullRequestBranch &&
          pullRequestBranch !== target.baseBranch &&
          this.pullRequestDue(
            key,
            fingerprint,
            pullRequestBranch,
            this.sessionIsLive(target.worktree.sessionId),
          )
        ) {
          const published = current
            ? await publishedBranchName(
                git,
                target.path,
                current,
                target.baseBranch,
              )
            : null;
          pullRequestChecks.push({
            key,
            path: target.path,
            branch: pullRequestBranch,
            names: [
              ...new Set([
                pullRequestBranch,
                ...(published ? [published] : []),
              ]),
            ],
            baseBranch: target.baseBranch,
            worktree: target.worktree,
            fingerprint,
          });
        }
        if (
          !due ||
          (previous &&
            previous.state === status.state &&
            previous.changedFiles === status.changedFiles &&
            previous.ahead === status.ahead &&
            previous.behind === status.behind &&
            previous.filesAhead === status.filesAhead &&
            previous.unpushed === status.unpushed &&
            previous.upstream === status.upstream &&
            previous.detached === status.detached)
        )
          return;
        this.gitStatusCache.set(key, status);
        changed = true;
      },
    );
    if (await this.refreshPullRequests(pullRequestChecks)) changed = true;
    if (changed) this.onRepositoriesChanged();
  }

  /**
   * Asks `gh` which pull requests these branches have (see `pullRequestDue`
   * for how often). Branch names of one GitHub repository share one GraphQL
   * request; a remote that is not recognisably GitHub, a fork, or a request
   * that failed is asked with `gh pr list`, one name at a time. The answer is
   * chosen by `choosePullRequest` and kept in memory and in SQLite. Returns
   * whether any answer changed.
   *
   * A failure keeps the last answer and marks it stale, so the row can say
   * it is not confirmed rather than quietly showing an old state.
   */
  private async refreshPullRequests(
    checks: readonly PullRequestCheck[],
  ): Promise<boolean> {
    if (checks.length === 0) return false;
    const git = findExecutable("git");
    const gh = findExecutable("gh", GH_EXECUTABLE_FALLBACKS);
    let changed = false;
    const asking: Array<PullRequestCheck & { head: string }> = [];
    await forEachWithConcurrency(
      checks,
      STATUS_REFRESH_CONCURRENCY,
      async (check) => {
        const cached = this.pullRequestCache.get(check.key);
        const head = git
          ? (
              await runCommand(git, ["-C", check.path, "rev-parse", "HEAD"])
            ).stdout.trim()
          : "";
        if (
          cached?.landedHead &&
          cached.landedHead === head &&
          cached.branch === check.branch
        ) {
          // Still the merged HEAD: merged is final, so there is nothing to
          // ask until HEAD moves.
          cached.checkedAt = Date.now();
          if (cached.fingerprint !== check.fingerprint)
            cached.movedAt = cached.checkedAt;
          cached.fingerprint = check.fingerprint;
          return;
        }
        if (!(await pathExists(check.path))) return;
        if (!gh || !git) {
          if (this.keepAfterFailure(check)) changed = true;
          return;
        }
        asking.push({ ...check, head });
      },
    );
    if (!gh || !git || asking.length === 0) return changed;

    // What GitHub listed for each name of each branch, or undefined when it
    // could not say.
    const answers = new Map<
      PullRequestCheck,
      Array<Array<Record<string, unknown>>> | undefined
    >();
    const groups = new Map<
      string,
      { remote: GitHubRemote; checks: Array<(typeof asking)[number]> }
    >();
    const alone: Array<(typeof asking)[number]> = [];
    for (const check of asking) {
      const remote = check.worktree && this.githubRemote(check.worktree);
      // Only github.com is asked in a batch. Any other host, an SSH alias
      // such as `github-work` included, is one `gh` resolves through its
      // own configuration, so it is left to `gh pr list`.
      if (!remote || remote.host.toLowerCase() !== "github.com") {
        alone.push(check);
        continue;
      }
      const name = `${remote.owner}/${remote.name}`.toLowerCase();
      const group = groups.get(name) ?? { remote, checks: [] };
      group.checks.push(check);
      groups.set(name, group);
    }
    for (const { remote, checks: grouped } of groups.values()) {
      // Batches are cut by names, not branches, since a branch may have two.
      let batch: Array<(typeof asking)[number]> = [];
      let names = 0;
      const send = async () => {
        if (batch.length === 0) return;
        const found = await queryBranchPullRequests(
          gh,
          remote,
          batch.flatMap((check) => check.names),
          batch[0]!.path,
        );
        // A request that failed, or a fork, whose pull requests live on the
        // repository it was forked from, is asked branch by branch.
        if (!found) alone.push(...batch);
        else {
          let index = 0;
          for (const check of batch) {
            answers.set(
              check,
              check.names.map(() => found[index++] ?? []),
            );
          }
        }
        batch = [];
        names = 0;
      };
      for (const check of grouped) {
        if (names + check.names.length > PULL_REQUEST_BATCH_SIZE) await send();
        batch.push(check);
        names += check.names.length;
      }
      await send();
    }
    for (const check of alone) {
      const lists: Array<Array<Record<string, unknown>>> = [];
      let failed = false;
      for (const name of check.names) {
        const listed = await listBranchPullRequests(gh, check.path, name);
        if (!listed) {
          failed = true;
          break;
        }
        lists.push(listed);
      }
      answers.set(check, failed ? undefined : lists);
    }

    for (const check of asking) {
      const cached = this.pullRequestCache.get(check.key);
      const lists = answers.get(check);
      if (lists === undefined) {
        // Rate limited, offline or signed out: what was known stays known,
        // marked as not confirmed, and is asked again at the usual time.
        if (this.keepAfterFailure(check)) changed = true;
        continue;
      }
      const owner = check.worktree
        ? (this.githubRemote(check.worktree)?.owner ?? "")
        : "";
      const candidates: Array<
        PullRequestCandidate & { relation: HeadRelation; byOwnName: boolean }
      > = [];
      for (const [index, nodes] of lists.entries())
        for (const node of nodes) {
          const candidate = parsePullRequestNode(node);
          if (!candidate) continue;
          candidates.push({
            ...candidate,
            byOwnName: check.names[index] === check.branch,
            relation: check.head
              ? await headRelation(git, check.path, candidate)
              : "unknown",
          });
        }
      const chosen = choosePullRequest(candidates, owner);
      const value = chosen?.ref;
      const landed =
        Boolean(chosen && check.head) &&
        (await pullRequestHeadLanded(
          git,
          check.path,
          chosen!,
          check.baseBranch,
        ));
      const now = Date.now();
      // A first answer is not a move: at startup every branch has one.
      const movedAt =
        !cached ||
        cached.fingerprint === undefined ||
        cached.fingerprint === check.fingerprint
          ? cached?.movedAt
          : now;
      this.pullRequestCache.set(check.key, {
        checkedAt: now,
        branch: check.branch,
        fingerprint: check.fingerprint,
        ...(movedAt === undefined ? {} : { movedAt }),
        ...(value ? { value } : {}),
        ...(landed ? { landedHead: check.head } : {}),
      });
      this.savePullRequest(check, value, landed ? check.head : null, now);
      if (value?.state === "MERGED" && check.worktree)
        this.recordShipped(check.worktree, value, check.branch);
      if (
        !samePullRequest(cached?.value, value) ||
        Boolean(cached?.landedHead) !== landed ||
        cached?.branch !== check.branch ||
        Boolean(cached?.stale)
      )
        changed = true;
    }
    return changed;
  }

  /**
   * Records a question `gh` could not answer. The last answer about this
   * branch stays, marked stale; one about another branch is dropped. The
   * entry names the branch and the refs it was asked at, so the branch is
   * asked again on the usual schedule rather than on every pass. Returns
   * whether the row changes.
   */
  private keepAfterFailure(check: PullRequestCheck): boolean {
    const cached = this.pullRequestCache.get(check.key);
    const same = cached?.branch === check.branch ? cached : undefined;
    this.pullRequestCache.set(check.key, {
      ...keptPullRequest(same, Date.now()),
      branch: check.branch,
      fingerprint: check.fingerprint,
    });
    return Boolean(same?.value && !same.stale);
  }

  /** Writes one answer through to SQLite; a failure there costs nothing. */
  private savePullRequest(
    check: PullRequestCheck,
    value: PullRequestRef | undefined,
    landedHead: string | null,
    now: number,
  ): void {
    try {
      this.repositories.saveWorktreePullRequest({
        path: check.worktree?.path ?? check.path,
        branchName: check.branch,
        pullRequest: value ? JSON.stringify(value) : null,
        landedHead,
        checkedAt: new Date(now).toISOString(),
      });
    } catch {
      // The cache still has it; only a restart would forget.
    }
  }

  /** The GitHub repository a worktree's clone came from, when it is one. */
  private githubRemote(worktree: SessionWorktree): GitHubRemote | undefined {
    const repository = this.repositories.findWorkspaceRepository(
      worktree.repositoryId,
    );
    const entry = repository?.libraryRepositoryId
      ? this.repositories.findRepositoryLibraryEntry(
          repository.libraryRepositoryId,
        )
      : undefined;
    return entry ? parseGitHubRemote(entry.remoteUrl) : undefined;
  }

  /**
   * Remembers a merged pull request past its worktree. Written once per URL;
   * a merge first seen after a restart still gets GitHub's own time.
   */
  private recordShipped(
    worktree: SessionWorktree,
    pull: PullRequestRef,
    branchName: string,
  ) {
    const session = this.repositories.findAgent(worktree.sessionId);
    if (!session) return;
    try {
      this.repositories.recordShippedPullRequest({
        url: pull.url,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        taskId: session.taskId,
        repositoryId: worktree.repositoryId,
        number: pull.number,
        title: pull.title ?? null,
        branchName,
        mergedAt: pull.mergedAt ?? new Date().toISOString(),
      });
    } catch {
      // A record the World reads is not worth failing a status refresh over.
    }
  }

  // Keeps the registry's branch name on the branch the tree is really on, so
  // the board, the CLI and the pull-request lookup all name the same branch.
  // The branch Daedalus named is then deleted when everything on it is in the
  // tree's history, which is the usual case: the agent branched off it before
  // committing anything. Otherwise it would outlive the tree, because
  // removal only knows the name recorded last.
  async recordBranch(
    git: string,
    worktree: SessionWorktree,
    branch: string | null,
  ): Promise<SessionWorktree> {
    if (!branch || branch === worktree.branchName) return worktree;
    this.repositories.updateSessionWorktreeBranch(
      worktree.sessionId,
      worktree.repositoryId,
      branch,
    );
    const baseBranch = this.repositories.findWorkspaceRepository(
      worktree.repositoryId,
    )?.baseBranch;
    if (
      worktree.branchName !== baseBranch &&
      (
        await runCommand(git, [
          "-C",
          worktree.path,
          "merge-base",
          "--is-ancestor",
          `refs/heads/${worktree.branchName}`,
          "HEAD",
        ])
      ).exitCode === 0
    )
      await runCommand(git, [
        "-C",
        worktree.path,
        "branch",
        "-D",
        worktree.branchName,
      ]);
    return { ...worktree, branchName: branch };
  }

  /**
   * Measures one repository now and records the answer, so the row the caller
   * is about to show and the row the next listing shows agree.
   */
  async measureRepository(
    repository: WorkspaceRepository,
  ): Promise<WorkspaceRepository> {
    if (this.inCloud(repository.workspaceId)) return repository;
    const measured = await this.repositoryWithGitStatus(repository);
    if (repository.referencePath && measured.gitStatus)
      this.gitStatusCache.set(
        statusKey(repository.referencePath),
        measured.gitStatus,
      );
    return measured;
  }

  async repositoryWithGitStatus(
    repository: WorkspaceRepository,
  ): Promise<WorkspaceRepository> {
    if (repository.status !== "ready")
      return { ...repository, gitStatus: UNAVAILABLE_STATUS };
    return {
      ...repository,
      gitStatus: await this.measure.status(
        repository.referencePath,
        repository.baseBranch,
      ),
    };
  }

  /**
   * Measures one session worktree now and records the answer, like
   * `measureRepository`.
   */
  async measureWorktree(
    worktree: SessionWorktree,
    baseBranch: string | null,
  ): Promise<SessionWorktree> {
    const gitStatus = await this.measure.status(worktree.path, baseBranch);
    this.gitStatusCache.set(statusKey(worktree.path), gitStatus);
    return { ...worktree, gitStatus };
  }

  /** A repository with whatever status the cache holds for its checkout. */
  repositoryWithMeasurements(
    repository: WorkspaceRepository,
  ): WorkspaceRepository {
    const status = repository.referencePath
      ? this.gitStatusCache.get(statusKey(repository.referencePath))
      : undefined;
    return { ...repository, ...(status ? { gitStatus: status } : {}) };
  }

  /** Drops everything cached about a tree that moved or went away. */
  forget(path: string): void {
    const key = statusKey(path);
    this.gitStatusCache.delete(key);
    this.pullRequestCache.delete(key);
    this.measuredTrees.delete(key);
    this.changesCache.delete(key);
  }

  /**
   * Every session worktree in the workspace with its `git status`: changes
   * in the working tree and the index against HEAD, plus untracked files,
   * as VS Code's Source Control shows them. Read-only and lock-free, so it
   * never races an agent's own `git add`.
   */
  async worktreeChanges(reference: string): Promise<WorktreeChanges[]> {
    const workspace = await this.workspaces.getActive(reference);
    const git = findExecutable("git");
    const repositories = new Map(
      this.repositories
        .listWorkspaceRepositories(workspace.id)
        .map((item) => [item.id, item]),
    );
    const worktrees = this.repositories.listSessionWorktrees({
      workspaceId: workspace.id,
    });
    const results = await Promise.all(
      worktrees.map(async (worktree): Promise<WorktreeChanges | undefined> => {
        if (!git || !(await pathExists(worktree.path))) return undefined;
        const repository = repositories.get(worktree.repositoryId);
        const root = relative(workspace.path, worktree.path);
        if (root.startsWith("..") || isAbsolute(root)) return undefined;
        // The same answer as last time unless the tree moved: its git
        // metadata changed, the watcher saw a file change in it, or the
        // answer is old enough that something unseen could have happened.
        // The window asks on every update, and most updates are an agent's
        // activity or token count, which cannot change a single file.
        const key = statusKey(worktree.path);
        const generation = this.treeGenerations.get(key) ?? 0;
        const fingerprint = await gitMetadataFingerprint(worktree.path, null);
        const cached = this.changesCache.get(key);
        if (
          cached &&
          !(await this.treeIsDue(
            cached,
            key,
            fingerprint,
            LIVE_TREE_MAX_AGE_MS,
          ))
        )
          return (
            cached.value && {
              ...cached.value,
              branchName: worktree.branchName,
            }
          );
        const changes = await this.measure.changes(worktree.path);
        const base = changes.base;
        const files: ChangedFile[] = changes.files.map((file) => ({
          ...file,
          path: join(root, file.repositoryPath),
        }));
        files.sort((left, right) => left.path.localeCompare(right.path));
        const value: WorktreeChanges = {
          sessionId: worktree.sessionId,
          repositoryId: worktree.repositoryId,
          repositoryName: repository?.name ?? basename(worktree.path),
          branchName: worktree.branchName,
          root,
          base,
          files,
        };
        this.changesCache.set(key, {
          fingerprint,
          generation,
          at: Date.now(),
          value,
        });
        return value;
      }),
    );
    return results.filter((item) => item !== undefined);
  }

  /**
   * Settles when no working tree is being measured.
   *
   * `get` deliberately does not wait for git, so anything that needs the
   * measured answer rather than the last known one — a test, a caller about to
   * act on it — asks for it here.
   *
   * With a workspace, the answer is measured after the call. A pass already
   * running may have read a tree before the caller's last change, such as
   * between an agent's `git add` and its `git commit`, so that pass is waited
   * out and one more forced pass runs after it.
   */
  /** `null` measures every workspace, which is what the board reads. */
  async settle(workspaceId?: string | null): Promise<void> {
    if (workspaceId !== undefined) {
      while (this.statusRefresh) await this.statusRefresh;
      this.scheduleRefresh(workspaceId, true);
    }
    while (this.statusRefresh) await this.statusRefresh;
    await this.ignored.settle();
  }
}

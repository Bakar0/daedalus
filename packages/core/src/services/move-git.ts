import { DaedalusError } from "../errors";
import { must, type MoveSide } from "./move-side";

/**
 * A repository's state as a move carries it: the commit checked out, and two
 * commits on top of it made without touching the worktree or its index. One
 * holds the index (staged changes), the other the working tree with its
 * untracked files; ignored files are in neither.
 */
export interface RepositorySnapshot {
  head: string;
  index: string;
  work: string;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "Daedalus",
  GIT_AUTHOR_EMAIL: "daedalus@localhost",
  GIT_COMMITTER_NAME: "Daedalus",
  GIT_COMMITTER_EMAIL: "daedalus@localhost",
};

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Where a move keeps its refs; `<sessionId>` is a UUID. */
const outgoing = (sessionId: string) => `refs/daedalus/move/${sessionId}`;
const moves = (sessionId: string) => `refs/daedalus/moves/${sessionId}`;
/** The working-tree commit both sides last agreed on. */
export const lastRef = (sessionId: string) => `${moves(sessionId)}/last`;

const objectId = (value: string, what: string): string => {
  if (!OBJECT_ID.test(value))
    throw new DaedalusError("DEPENDENCY", `git gave no ${what}`);
  return value;
};

const git = (
  side: MoveSide,
  dir: string,
  args: string[],
  env?: Record<string, string>,
) => must(side, dir, "git", args, env);

/** Whether `dir` on `side` is the top of a git worktree. */
export async function isRepository(
  side: MoveSide,
  dir: string,
): Promise<boolean> {
  // A command cannot even start in a folder that is not there.
  if ((await side.run(".", "test", ["-d", side.absolute(dir)])).exitCode !== 0)
    return false;
  const result = await side.run(dir, "git", ["rev-parse", "--show-prefix"]);
  return result.exitCode === 0 && result.stdout.trim() === "";
}

/** Snapshots a repository without changing it, its index or its refs. */
export async function snapshotRepository(
  side: MoveSide,
  dir: string,
): Promise<RepositorySnapshot> {
  const head = objectId(
    await git(side, dir, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "HEAD",
  );
  // Fails while a merge has conflicts, which is the right answer: such a
  // state does not survive being carried.
  const indexTree = objectId(await git(side, dir, ["write-tree"]), "tree");
  // Each snapshot is a commit of its own. git dates a commit to the second,
  // so an unchanged tree snapshotted within a second of the last one would
  // otherwise be that very commit, which the bundle then leaves out as
  // already on the other side, ref and all.
  const nonce = crypto.randomUUID();
  const index = objectId(
    await git(
      side,
      dir,
      [
        "commit-tree",
        indexTree,
        "-p",
        head,
        "-m",
        `Daedalus move: staged ${nonce}`,
      ],
      IDENTITY,
    ),
    "commit",
  );
  const temporary = await git(side, dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    `daedalus-move-index-${crypto.randomUUID()}`,
  ]);
  const scratch = { ...IDENTITY, GIT_INDEX_FILE: temporary };
  try {
    await git(side, dir, ["read-tree", indexTree], scratch);
    await git(side, dir, ["add", "-A", "--", "."], scratch);
    const workTree = objectId(
      await git(side, dir, ["write-tree"], scratch),
      "tree",
    );
    const work = objectId(
      await git(
        side,
        dir,
        [
          "commit-tree",
          workTree,
          "-p",
          head,
          "-m",
          `Daedalus move: work ${nonce}`,
        ],
        IDENTITY,
      ),
      "commit",
    );
    return { head, index, work };
  } finally {
    await side.run(dir, "rm", ["-f", "--", temporary]).catch(() => undefined);
  }
}

/** The commit a ref names on this side, or undefined. */
export async function resolveRef(
  side: MoveSide,
  dir: string,
  ref: string,
): Promise<string | undefined> {
  const result = await side.run(dir, "git", [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  const id = result.stdout.trim();
  return result.exitCode === 0 && OBJECT_ID.test(id) ? id : undefined;
}

/**
 * Writes a bundle of a snapshot to `file`. Commits named in `bases` that this
 * side has are left out, so a repository that moved before sends only what
 * is new.
 */
export async function writeBundle(
  side: MoveSide,
  dir: string,
  sessionId: string,
  snapshot: RepositorySnapshot,
  bases: string[],
  file: string,
): Promise<void> {
  const prefix = outgoing(sessionId);
  await git(side, dir, ["update-ref", `${prefix}/index`, snapshot.index]);
  await git(side, dir, ["update-ref", `${prefix}/work`, snapshot.work]);
  const known: string[] = [];
  for (const base of new Set(bases))
    if (
      OBJECT_ID.test(base) &&
      (await side.run(dir, "git", ["cat-file", "-e", `${base}^{commit}`]))
        .exitCode === 0
    )
      known.push(`^${base}`);
  try {
    await git(side, dir, [
      "bundle",
      "create",
      side.absolute(file),
      `${prefix}/index`,
      `${prefix}/work`,
      ...known,
    ]);
  } finally {
    await side
      .run(dir, "git", ["update-ref", "-d", `${prefix}/index`])
      .catch(() => undefined);
    await side
      .run(dir, "git", ["update-ref", "-d", `${prefix}/work`])
      .catch(() => undefined);
  }
}

/**
 * Takes a bundle the other side wrote into this repository's objects, and
 * reads the snapshot from it. The bundle is not trusted: git checks every
 * object it fetches, only the two refs this move named are taken, they land
 * under this session's own ref folder, and both commits must sit right on
 * one common parent.
 */
export async function fetchBundle(
  side: MoveSide,
  dir: string,
  sessionId: string,
  file: string,
): Promise<RepositorySnapshot> {
  const from = outgoing(sessionId);
  const to = moves(sessionId);
  await git(side, dir, ["bundle", "verify", "--quiet", side.absolute(file)]);
  await git(side, dir, [
    "-c",
    "transfer.fsckObjects=true",
    "-c",
    "fetch.fsckObjects=true",
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    side.absolute(file),
    `+${from}/index:${to}/incoming-index`,
    `+${from}/work:${to}/incoming-work`,
  ]);
  const index = await resolveRef(side, dir, `${to}/incoming-index`);
  const work = await resolveRef(side, dir, `${to}/incoming-work`);
  if (!index || !work)
    throw new DaedalusError("DEPENDENCY", "The move's bundle is incomplete");
  const parents = async (commit: string) =>
    (await git(side, dir, ["rev-list", "--parents", "-n", "1", commit]))
      .split(" ")
      .slice(1);
  const [workParents, indexParents] = [
    await parents(work),
    await parents(index),
  ];
  if (
    workParents.length !== 1 ||
    indexParents.length !== 1 ||
    workParents[0] !== indexParents[0]
  )
    throw new DaedalusError(
      "DEPENDENCY",
      "The move's bundle is not a snapshot Daedalus made",
    );
  return { head: objectId(workParents[0]!, "commit"), index, work };
}

/**
 * Whether the copy on this side is as the session left it: the commit and
 * working tree it last sent or received. A side with no record of the
 * session has not been agreed on, so it counts as changed.
 */
export async function unchangedSince(
  side: MoveSide,
  dir: string,
  sessionId: string,
): Promise<boolean> {
  const last = await resolveRef(side, dir, lastRef(sessionId));
  if (!last) return false;
  const now = await snapshotRepository(side, dir);
  const [lastTree, nowTree, lastHead] = await Promise.all([
    git(side, dir, ["rev-parse", `${last}^{tree}`]),
    git(side, dir, ["rev-parse", `${now.work}^{tree}`]),
    git(side, dir, ["rev-parse", `${last}^1`]),
  ]);
  return lastTree === nowTree && lastHead === now.head;
}

/** Records the working tree both sides now agree on. */
export async function markLast(
  side: MoveSide,
  dir: string,
  sessionId: string,
  work: string,
): Promise<void> {
  await git(side, dir, ["update-ref", lastRef(sessionId), work]);
}

/**
 * Lays a fetched snapshot down in `dir`: the branch at its commit (or the
 * commit alone, detached, when `branch` is undefined), the
 * working tree with staged, unstaged and untracked changes as they were, and
 * the index as it was. Files the side had untracked at `previous` and the
 * snapshot no longer has are removed.
 */
export async function applySnapshot(
  side: MoveSide,
  dir: string,
  branch: string | undefined,
  snapshot: RepositorySnapshot,
  previous?: string,
): Promise<void> {
  const gone = previous
    ? (
        await side.run(dir, "git", [
          "diff",
          "--name-only",
          "-z",
          "--no-renames",
          "--diff-filter=D",
          previous,
          snapshot.work,
        ])
      ).stdout
        .split("\0")
        .filter(Boolean)
    : [];
  if (branch === undefined)
    await git(side, dir, [
      "checkout",
      "--quiet",
      "-f",
      "--detach",
      snapshot.head,
    ]);
  else {
    await git(side, dir, ["check-ref-format", "--branch", branch]);
    await git(side, dir, [
      "checkout",
      "--quiet",
      "-f",
      "-B",
      branch,
      snapshot.head,
    ]);
  }
  await git(side, dir, [
    "restore",
    `--source=${snapshot.work}`,
    "--worktree",
    "--",
    ".",
  ]);
  await git(side, dir, ["read-tree", snapshot.index]);
  // `checkout -f` left untracked files alone; those the other side deleted
  // go too, through git so nothing outside the worktree is touched.
  if (gone.length) {
    const untracked = new Set(
      (
        await git(side, dir, [
          "ls-files",
          "-z",
          "--others",
          "--exclude-standard",
        ])
      )
        .split("\0")
        .filter(Boolean),
    );
    const remove = gone.filter((path) => untracked.has(path));
    for (let start = 0; start < remove.length; start += 200)
      await git(side, dir, [
        "clean",
        "-f",
        "-q",
        "--",
        ...remove.slice(start, start + 200).map((path) => `:(literal)${path}`),
      ]);
  }
}

/**
 * A path as this Mac's file system compares names: APFS and HFS+ ignore case
 * and Unicode normalization, so `.CLAUDE/x` lands in `.claude/x`. Folded
 * wide (compatibility forms, upper then lower) so a variant asks rather
 * than slips through.
 */
export const foldPath = (path: string): string =>
  path
    .normalize("NFKC")
    // HFS+ also ignores characters that draw nothing, such as U+200C.
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC");

/**
 * Paths in a commit's tree that this Mac would lay down as one file: two
 * names that differ only in case or normalization. git cannot check such a
 * tree out faithfully here, and the second one would overwrite the first.
 */
export async function caseCollisions(
  side: MoveSide,
  dir: string,
  commit: string,
): Promise<string[]> {
  const names = (
    await git(side, dir, ["ls-tree", "-r", "-z", "--name-only", commit])
  )
    .split("\0")
    .filter(Boolean);
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const name of names) {
    const folded = foldPath(name);
    const earlier = seen.get(folded);
    if (earlier !== undefined && earlier !== name) collisions.push(name);
    else seen.set(folded, name);
  }
  return collisions;
}

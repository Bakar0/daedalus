import { basename } from "node:path";
import { findExecutable, pathExists, runCommand } from "@daedalus/platform";
import type { RepositoryLibraryEntry, WorkspaceFileEntry } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";

/** The folder at the top of the Daedalus home that holds the library. */
export const LIBRARY_FOLDER = "repos";

export const LIBRARY_READ_ONLY = "Library repositories are read-only";

const READ_ONLY_FIELDS = { mutable: false, immutableReason: LIBRARY_READ_ONLY };

const GIT_TIMEOUT_MS = 15_000;

/**
 * Home's `repos/`, as people want to read it. On disk it holds the library's
 * bare mirrors, named `<uuid>.git` and made of git internals; here it is one
 * folder per library repository, by name, holding the files of its default
 * branch read out of the mirror with git. Nothing under it can change, and a
 * repository whose mirror or default branch is missing is an empty folder.
 *
 * Paths are relative to `repos/`: `""` is the list of repositories, and
 * `cloud-infra-py/src/app.py` a file in one.
 */
export class LibraryFiles {
  constructor(
    private readonly repositories: Pick<
      SqliteRepositories,
      "listRepositoryLibrary"
    >,
  ) {}

  /**
   * Each library repository under the name it is shown by. Names are unique
   * in practice; two repositories that share one are told apart by their id.
   */
  private repositoriesByName(): Map<string, RepositoryLibraryEntry> {
    const entries = this.repositories.listRepositoryLibrary();
    const counts = new Map<string, number>();
    const shownName = (entry: RepositoryLibraryEntry) =>
      entry.name.replace(/[\\/\0]/g, "-") || entry.id;
    for (const entry of entries)
      counts.set(shownName(entry), (counts.get(shownName(entry)) ?? 0) + 1);
    return new Map(
      entries.map((entry) => {
        const name = shownName(entry);
        return [
          (counts.get(name) ?? 0) > 1
            ? `${name}-${entry.id.slice(0, 8)}`
            : name,
          entry,
        ];
      }),
    );
  }

  async listDirectory(path: string): Promise<WorkspaceFileEntry[]> {
    const segments = splitPath(path);
    if (segments.length === 0)
      return [...this.repositoriesByName().keys()]
        .sort((left, right) => left.localeCompare(right))
        .map((name) => ({
          name,
          path: `${LIBRARY_FOLDER}/${name}`,
          kind: "directory" as const,
          ...READ_ONLY_FIELDS,
        }));
    const { gitDirectory, commit, inside } = await this.locate(segments);
    if (!gitDirectory || !commit) {
      if (inside === "") return [];
      throw notFound(path);
    }
    const type = await objectType(gitDirectory, commit, inside);
    if (type === undefined) throw notFound(path);
    // A submodule is a commit of another repository, which is not here.
    if (type === "commit") return [];
    if (type !== "tree")
      throw new DaedalusError("VALIDATION", `'${path}' is not a directory`);
    const listed = await runGit(gitDirectory, [
      "ls-tree",
      "-z",
      `${commit}:${inside}`,
    ]);
    if (listed.exitCode !== 0) return [];
    const prefix = `${LIBRARY_FOLDER}/${segments.join("/")}`;
    return listed.stdout
      .split("\0")
      .flatMap((line) => {
        // `<mode> <type> <object>\t<name>`
        const tab = line.indexOf("\t");
        if (tab < 0) return [];
        const [mode, kind] = line.slice(0, tab).split(" ");
        const name = line.slice(tab + 1);
        if (!name || name === ".git") return [];
        return [
          {
            name,
            path: `${prefix}/${name}`,
            kind:
              mode === "120000"
                ? ("symlink" as const)
                : kind === "tree" || kind === "commit"
                  ? ("directory" as const)
                  : ("file" as const),
            ...READ_ONLY_FIELDS,
          },
        ];
      })
      .sort((left, right) => {
        const rank = (kind: WorkspaceFileEntry["kind"]) =>
          kind === "directory" ? 0 : kind === "file" ? 1 : 2;
        return (
          rank(left.kind) - rank(right.kind) ||
          left.name.localeCompare(right.name)
        );
      });
  }

  /**
   * A file's bytes on the default branch, refusing what is not a regular
   * file or is larger than `maxBytes` with the message given for it.
   */
  async readFile(
    path: string,
    maxBytes: number,
    tooLarge: string,
  ): Promise<{ name: string; path: string; bytes: Uint8Array }> {
    const segments = splitPath(path);
    if (segments.length < 2)
      throw new DaedalusError("VALIDATION", `'${path}' is not a file`);
    const { gitDirectory, commit, inside } = await this.locate(segments);
    if (!gitDirectory || !commit) throw notFound(path);
    const spec = `${commit}:${inside}`;
    // `<mode> <type> <object>\t<name>` for the one entry at this path.
    const listed = await runGit(gitDirectory, [
      "ls-tree",
      "-z",
      commit,
      "--",
      inside,
    ]);
    const [mode, type] = listed.stdout.split("\t")[0]!.split(" ");
    if (listed.exitCode !== 0 || !listed.stdout) throw notFound(path);
    if (mode === "120000")
      throw new DaedalusError(
        "VALIDATION",
        "Symbolic links cannot be opened in the workspace viewer",
      );
    if (type !== "blob")
      throw new DaedalusError("VALIDATION", `'${path}' is not a file`);
    const size = await runGit(gitDirectory, ["cat-file", "-s", spec]);
    if (size.exitCode !== 0) throw notFound(path);
    if (Number(size.stdout.trim()) > maxBytes)
      throw new DaedalusError("VALIDATION", tooLarge);
    const bytes = await readBlob(gitDirectory, spec);
    return {
      name: basename(inside),
      path: `${LIBRARY_FOLDER}/${segments.join("/")}`,
      bytes,
    };
  }

  /**
   * The mirror and default-branch commit of the repository a path is in, and
   * the path inside it. `commit` is missing when the mirror or its default
   * branch is; the caller decides whether that is an empty folder.
   */
  private async locate(segments: string[]): Promise<{
    gitDirectory?: string;
    commit?: string;
    inside: string;
  }> {
    const [name, ...rest] = segments;
    const entry = this.repositoriesByName().get(name!);
    if (!entry) throw notFound(segments.join("/"));
    const inside = rest.join("/");
    if (!entry.defaultBranch || !(await pathExists(entry.gitDirectory)))
      return { inside };
    // The remote's branch as of the last fetch, else the local copy of it.
    for (const ref of [
      `refs/remotes/origin/${entry.defaultBranch}`,
      `refs/heads/${entry.defaultBranch}`,
    ]) {
      const resolved = await runGit(entry.gitDirectory, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ]);
      const commit = resolved.stdout.trim();
      if (resolved.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(commit))
        return { gitDirectory: entry.gitDirectory, commit, inside };
    }
    return { inside };
  }
}

/**
 * The segments of a path under `repos/`. `.` and `..` are refused rather
 * than resolved, and git's own folder never names anything here.
 */
function splitPath(path: string): string[] {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "");
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment === ".git" ||
        segment.includes("\0"),
    )
  )
    throw new DaedalusError(
      "VALIDATION",
      "Internal workspace and Git metadata are not visible",
    );
  return segments;
}

function notFound(path: string): DaedalusError {
  return new DaedalusError(
    "NOT_FOUND",
    `Workspace path '${LIBRARY_FOLDER}/${path}' was not found`,
  );
}

function runGit(gitDirectory: string, args: string[]) {
  const git = findExecutable("git");
  if (!git)
    throw new DaedalusError("DEPENDENCY", "git is not available on PATH");
  return runCommand(git, ["--git-dir", gitDirectory, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
}

async function objectType(
  gitDirectory: string,
  commit: string,
  inside: string,
): Promise<string | undefined> {
  const result = await runGit(gitDirectory, [
    "cat-file",
    "-t",
    `${commit}:${inside}`,
  ]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/**
 * A blob's raw bytes. `runCommand` hands output back as text, which would
 * mangle an image, so this one child is read as bytes.
 */
async function readBlob(gitDirectory: string, spec: string) {
  const git = findExecutable("git");
  if (!git)
    throw new DaedalusError("DEPENDENCY", "git is not available on PATH");
  const child = Bun.spawn(
    [git, "--git-dir", gitDirectory, "cat-file", "blob", spec],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
  try {
    const bytes = new Uint8Array(
      await new Response(child.stdout).arrayBuffer(),
    );
    if ((await child.exited) !== 0)
      throw new DaedalusError("NOT_FOUND", `'${spec}' could not be read`);
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

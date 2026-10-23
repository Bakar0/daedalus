import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { writeFileAtomic } from "@daedalus/platform";
import { DaedalusError } from "../errors";
import { steersAgent } from "./move-git";
import { must, type LocalMoveSide, type PodMoveSide } from "./move-side";
import { sha256 } from "./move-transcript";

/**
 * The files of a workspace folder that are not in a git worktree: the brief,
 * the journal, artifacts, session folders' own files. A workspace move
 * carries them as one tar archive of regular files. Links, devices, sockets,
 * `.git` folders and Daedalus's own folders are never carried; every
 * worktree travels as git instead.
 */

/** Folders at the root that are never workspace content. */
const MAC_OWNED = new Set([".daedalus"]);
/**
 * In the pod's root too: Claude's home, a move's scratch and the explorer's
 * trash, which a move home leaves behind.
 */
const POD_OWNED = new Set([
  ".daedalus",
  ".home",
  ".daedalus-move",
  ".daedalus-trash",
]);

/** One regular file, by its path relative to the workspace folder. */
export interface WorkspaceFile {
  path: string;
  bytes: number;
}

/**
 * The regular files of the workspace folder on this Mac outside `skip`
 * (worktree paths relative to the folder). Links are not followed.
 */
export async function listMacFiles(
  root: string,
  skip: ReadonlySet<string>,
): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (dir === root && MAC_OWNED.has(entry.name)) continue;
      if (entry.name === ".git" || skip.has(rel)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files.push({ path: rel, bytes: (await lstat(path)).size });
    }
  };
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The `find` arguments that leave out what a pod's listing must not hold. */
const podPrunes = (skip: ReadonlySet<string>): string[] => {
  const prunes = [
    ...[...POD_OWNED].map((name) => `./${name}`),
    ...[...skip].map((path) => `./${path}`),
  ];
  const args = ["(", "-name", ".git"];
  for (const path of prunes) args.push("-o", "-path", path);
  args.push(")", "-prune", "-o");
  return args;
};

/**
 * The regular files of the pod's workspace folder outside `skip`. Names are
 * the pod's: untrusted, checked by the caller.
 */
export async function listPodFiles(
  pod: PodMoveSide,
  skip: ReadonlySet<string>,
): Promise<string[]> {
  // `-print0` rather than `-printf`, which the Mac's find has not.
  const out = await must(pod, ".", "find", [
    ".",
    ...podPrunes(skip),
    "-type",
    "f",
    "-print0",
  ]);
  return out
    .split("\0")
    .filter((path) => path.startsWith("./"))
    .map((path) => path.slice(2))
    .sort();
}

/** sha256 of each named pod file; a file that is gone is left out. */
export async function podHashes(
  pod: PodMoveSide,
  paths: string[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (let start = 0; start < paths.length; start += 200) {
    const result = await pod.run(".", "sha256sum", [
      "-z",
      "--",
      ...paths.slice(start, start + 200),
    ]);
    for (const line of result.stdout.split("\0")) {
      const match = /^([0-9a-f]{64}) [ *](.+)$/s.exec(line);
      if (match) hashes.set(match[2]!, match[1]!);
    }
  }
  return hashes;
}

/** sha256 of a file on this Mac, or undefined when it is not a regular file. */
export async function macHash(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isFile()) return undefined;
    return sha256(new Uint8Array(await readFile(path)));
  } catch {
    return undefined;
  }
}

/** Whether a workspace-relative path is one a move may write on this Mac. */
export function safeWorkspacePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0")) return false;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    return false;
  if (parts.includes(".git")) return false;
  return !MAC_OWNED.has(parts[0]!) && !POD_OWNED.has(parts[0]!);
}

/**
 * Steering files among `paths` whose contents in the pod differ from this
 * Mac's copy, which is the state both sides last agreed on: nothing writes
 * the Mac's folder while the workspace is in the cloud.
 */
export async function changedSteering(
  root: string,
  podHashOf: Map<string, string>,
): Promise<string[]> {
  const changed: string[] = [];
  for (const [path, hash] of podHashOf)
    if (steersAgent(path) && (await macHash(join(root, path))) !== hash)
      changed.push(path);
  return changed.sort();
}

/** Writes the Mac's files into a tar archive at `file`. */
export async function packMac(
  local: LocalMoveSide,
  root: string,
  files: WorkspaceFile[],
  file: string,
): Promise<void> {
  const list = `${file}.list`;
  await writeFileAtomic(list, files.map(({ path }) => path).join("\0"), {
    mode: 0o600,
    ensureDir: true,
  });
  try {
    // macOS tar otherwise adds a `._name` file beside every file with
    // extended attributes, and the pod would keep them as workspace files.
    await must(
      local,
      root,
      "tar",
      ["-c", "-f", file, "--no-recursion", "--null", "-T", list],
      { COPYFILE_DISABLE: "1" },
    );
  } finally {
    await rm(list, { force: true });
  }
}

/**
 * Replaces the pod's files outside `skip` with the archive at `archive`.
 * The pod is not trusted to keep anything this Mac did not send.
 */
export async function unpackInPod(
  pod: PodMoveSide,
  skip: ReadonlySet<string>,
  archive: string,
): Promise<void> {
  await must(pod, ".", "bash", [
    "-c",
    'find "$@" -print0 | xargs -0 -r rm -f --',
    "bash",
    ".",
    ...podPrunes(skip),
    "(",
    "-type",
    "f",
    "-o",
    "-type",
    "l",
    ")",
  ]);
  await must(pod, ".", "tar", [
    "-x",
    "-f",
    pod.absolute(archive),
    "-C",
    pod.absolute("."),
    "--no-same-owner",
  ]);
}

/** Has the pod write its files into a tar archive at `archive`. */
export async function packInPod(
  pod: PodMoveSide,
  files: string[],
  archive: string,
): Promise<void> {
  const list = `${archive}.list`;
  await pod.writeFile(list, new TextEncoder().encode(files.join("\0")));
  await must(pod, ".", "tar", [
    "-c",
    "-f",
    pod.absolute(archive),
    "--no-recursion",
    "--null",
    "-T",
    pod.absolute(list),
  ]);
}

/**
 * Unpacks an archive from the pod into `scratch` and returns its files. Only
 * regular files with paths a move may write are taken: anything else in the
 * archive fails the move, before anything is extracted.
 */
export async function unpackFromPod(
  local: LocalMoveSide,
  archive: string,
  scratch: string,
): Promise<string[]> {
  const listing = await must(local, scratch, "tar", [
    "-t",
    "-v",
    "-f",
    archive,
  ]);
  const names = await must(local, scratch, "tar", ["-t", "-f", archive]);
  const lines = listing.split("\n").filter(Boolean);
  const paths = names.split("\n").filter(Boolean);
  if (lines.length !== paths.length)
    throw new DaedalusError(
      "DEPENDENCY",
      "The cloud workspace's files are not an archive Daedalus made",
    );
  for (const [index, line] of lines.entries()) {
    const path = paths[index]!;
    if (!line.startsWith("-") || !safeWorkspacePath(path))
      throw new DaedalusError(
        "CONFLICT",
        `The cloud workspace sent ${JSON.stringify(path.slice(0, 200))}, which is not a plain file Daedalus takes`,
      );
  }
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  // bsdtar refuses `..`, absolute paths and writing through links already.
  await must(local, scratch, "tar", ["-x", "-f", archive, "-C", scratch]);
  for (const path of paths) {
    const stats = await lstat(join(scratch, path));
    if (!stats.isFile())
      throw new DaedalusError(
        "CONFLICT",
        `The cloud workspace sent ${path} as something other than a file`,
      );
  }
  return paths.sort();
}

/**
 * Lays the files unpacked in `scratch` down in the workspace folder and
 * removes the Mac's own files (`before`) the pod no longer has. A parent
 * that is a link or a file is never written through.
 */
export async function applyFromPod(
  root: string,
  scratch: string,
  paths: string[],
  before: WorkspaceFile[],
): Promise<void> {
  const keep = new Set(paths);
  for (const { path } of before)
    if (!keep.has(path)) await rm(join(root, path), { force: true });
  for (const path of paths) {
    const parts = path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      const stats = await lstat(dir).catch(() => undefined);
      if (!stats) await mkdir(dir);
      else if (!stats.isDirectory())
        throw new DaedalusError(
          "CONFLICT",
          `${relative(root, dir)} on this Mac is not a folder, so ${path} cannot come home`,
        );
    }
    const target = join(root, path);
    const existing = await lstat(target).catch(() => undefined);
    if (existing && !existing.isFile())
      throw new DaedalusError(
        "CONFLICT",
        `${path} on this Mac is not a file, so it cannot be replaced`,
      );
    await writeFileAtomic(
      target,
      new Uint8Array(await readFile(join(scratch, path))),
      { mode: 0o644 },
    );
  }
}

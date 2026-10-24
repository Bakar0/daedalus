import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { writeFileAtomic } from "@daedalus/platform";
import { DaedalusError } from "../errors";
import { foldPath } from "./move-git";
import { must, type LocalMoveSide, type PodMoveSide } from "./move-side";

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

/**
 * Whether a workspace-relative path is one a move may write on this Mac.
 * Every part is compared as this Mac's file system compares names
 * (`foldPath`): `.GIT/config` lands in `.git/config` here, and git runs what
 * a config names (`core.fsmonitor`) on the next `git status`.
 */
export function safeWorkspacePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0")) return false;
  const parts = path.split("/");
  const folded = parts.map(foldPath);
  if (
    [...parts, ...folded].some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part === ".git" ||
        part === ".daedalus",
    )
  )
    return false;
  return !MAC_OWNED.has(folded[0]!) && !POD_OWNED.has(folded[0]!);
}

/**
 * Whether `path` is one of `folders` (worktrees and reference checkouts,
 * which travel as git) or inside one, compared folded as `safeWorkspacePath`.
 */
export function insideFolders(
  path: string,
  folders: ReadonlySet<string>,
): boolean {
  const folded = foldPath(path);
  for (const folder of folders) {
    const prefix = foldPath(folder);
    if (folded === prefix || folded.startsWith(`${prefix}/`)) return true;
  }
  return false;
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

/** The most a move unpacks from the pod's files archive, as sent. */
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const BLOCK = 512;
const COPY_CHUNK = 1024 * 1024;

/** One regular file in a tar archive: its path and where its bytes are. */
interface TarFile {
  path: string;
  offset: number;
  size: number;
}

/** Pax keys that only describe a file; anything else is refused. */
const PAX_IGNORED =
  /^(mtime|atime|ctime|uid|gid|uname|gname|SCHILY\..*|LIBARCHIVE\..*)$/;

const notOurs = () =>
  new DaedalusError(
    "DEPENDENCY",
    "The cloud workspace's files are not an archive Daedalus made",
  );

const octal = (header: Uint8Array, start: number, length: number): number => {
  // A base-256 size (high bit set) is over any cap here.
  if (header[start]! & 0x80) throw notOurs();
  const text = new TextDecoder()
    .decode(header.subarray(start, start + length))
    .replace(/\0.*$/s, "")
    .trim();
  if (!/^[0-7]*$/.test(text)) throw notOurs();
  return text ? Number.parseInt(text, 8) : 0;
};

const cString = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)),
  );

/**
 * The path a pax header names, if any. Records are `<length> key=value\n`,
 * the length in bytes: values may be raw bytes (macOS tar's `SCHILY.xattr`),
 * so only keys and the path are decoded.
 */
function paxRecords(body: Uint8Array): string | undefined {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let path: string | undefined;
  for (let at = 0; at < body.length;) {
    const space = body.indexOf(0x20, at);
    const length = Number(
      space > at ? new TextDecoder().decode(body.subarray(at, space)) : "",
    );
    if (!Number.isInteger(length) || length <= 0 || at + length > body.length)
      throw notOurs();
    const record = body.subarray(space + 1, at + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 0 || body[at + length - 1] !== 0x0a) throw notOurs();
    const key = utf8.decode(record.subarray(0, equals));
    if (key === "path") path = utf8.decode(record.subarray(equals + 1));
    else if (!PAX_IGNORED.test(key)) throw notOurs();
    at += length;
  }
  return path;
}

/**
 * The regular files of a tar archive the pod's GNU tar wrote, read from
 * its headers alone. Only regular entries are taken, with GNU long names
 * and pax path records; sparse, special, global and unknown entries are
 * refused, as is a header whose checksum is wrong.
 */
async function tarFiles(handle: FileHandle, length: number) {
  const files: TarFile[] = [];
  const header = new Uint8Array(BLOCK);
  const read = async (bytes: Uint8Array, position: number) => {
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
    if (bytesRead !== bytes.length) throw notOurs();
  };
  let position = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  while (position + BLOCK <= length) {
    await read(header, position);
    if (header.every((byte) => byte === 0)) return files;
    let sum = 0;
    for (let index = 0; index < BLOCK; index++)
      sum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (sum !== octal(header, 148, 8)) throw notOurs();
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]!);
    const data = position + BLOCK;
    const next = data + Math.ceil(size / BLOCK) * BLOCK;
    if (next > length) throw notOurs();
    if (type === "L" || type === "x") {
      if (size > 64 * 1024) throw notOurs();
      const body = new Uint8Array(size);
      await read(body, data);
      if (type === "L") longName = cString(body);
      else paxPath = paxRecords(body) ?? paxPath;
    } else if (type === "0" || type === "\0") {
      const ustar = cString(header.subarray(257, 263)) === "ustar";
      const prefix = ustar ? cString(header.subarray(345, 500)) : "";
      const name = cString(header.subarray(0, 100));
      const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
      files.push({ path, offset: data, size });
      longName = paxPath = undefined;
    } else
      throw new DaedalusError(
        "CONFLICT",
        `The cloud workspace sent ${JSON.stringify((paxPath ?? longName ?? cString(header.subarray(0, 100))).slice(0, 200))}, which is not a plain file Daedalus takes`,
      );
    position = next;
  }
  throw notOurs();
}

/**
 * Unpacks an archive from the pod into `scratch` and returns its files. The
 * archive is read here, not by a tar: only regular files with paths a move
 * may write are taken, every header is checked before anything is written,
 * and the files are copied out in pieces, at most `maxBytes` of them. With
 * `expected`, the pod's listing as this Mac filtered it, the archive may
 * hold nothing else; nothing may be at or inside `skip`, which travels as
 * git.
 */
export async function unpackFromPod(
  _local: LocalMoveSide,
  archive: string,
  scratch: string,
  limits: {
    expected?: ReadonlySet<string>;
    skip?: ReadonlySet<string>;
    maxBytes?: number;
  } = {},
): Promise<string[]> {
  const maxBytes = limits.maxBytes ?? MAX_UNPACKED_BYTES;
  const handle = await open(archive, "r");
  try {
    const files = await tarFiles(handle, (await handle.stat()).size).catch(
      (error: unknown) => {
        // A name that is not UTF-8, say.
        throw error instanceof DaedalusError ? error : notOurs();
      },
    );
    const seen = new Set<string>();
    let total = 0;
    for (const { path, size } of files) {
      if (
        !safeWorkspacePath(path) ||
        (limits.expected && !limits.expected.has(path)) ||
        (limits.skip && insideFolders(path, limits.skip)) ||
        seen.has(foldPath(path))
      )
        throw new DaedalusError(
          "CONFLICT",
          `The cloud workspace sent ${JSON.stringify(path.slice(0, 200))}, which is not a plain file Daedalus takes`,
        );
      seen.add(foldPath(path));
      total += size;
      if (total > maxBytes)
        throw new DaedalusError(
          "CONFLICT",
          `The cloud workspace's files unpack to more than ${maxBytes} bytes`,
        );
    }
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const chunk = new Uint8Array(COPY_CHUNK);
    for (const { path, offset, size } of files) {
      const target = join(scratch, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const out = await open(target, "wx", 0o600);
      try {
        for (let done = 0; done < size;) {
          const want = Math.min(COPY_CHUNK, size - done);
          const { bytesRead } = await handle.read(
            chunk,
            0,
            want,
            offset + done,
          );
          if (bytesRead !== want) throw notOurs();
          await out.write(chunk.subarray(0, want));
          done += want;
        }
      } finally {
        await out.close();
      }
    }
    const inside = `${await realpath(scratch)}${sep}`;
    for (const { path } of files) {
      const stats = await lstat(join(scratch, path));
      if (
        !stats.isFile() ||
        !(await realpath(join(scratch, path))).startsWith(inside)
      )
        throw new DaedalusError(
          "CONFLICT",
          `The cloud workspace sent ${path} as something other than a file`,
        );
    }
    return files.map(({ path }) => path).sort();
  } finally {
    await handle.close();
  }
}

/**
 * Lays the files unpacked in `scratch` down in the workspace folder and
 * removes the Mac's own files (`before`) the pod no longer has. A parent
 * that is a link or a file is never written through, and nothing lands in
 * `.git`, Daedalus's folders or `skip`, checked here again.
 */
export async function applyFromPod(
  root: string,
  scratch: string,
  paths: string[],
  before: WorkspaceFile[],
  skip: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const path of paths)
    if (!safeWorkspacePath(path) || insideFolders(path, skip))
      throw new DaedalusError(
        "CONFLICT",
        `The cloud workspace sent ${JSON.stringify(path.slice(0, 200))}, which is not a plain file Daedalus takes`,
      );
  const inside = `${await realpath(root)}${sep}`;
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
    if (!`${await realpath(dir)}${sep}`.startsWith(inside))
      throw new DaedalusError(
        "CONFLICT",
        `${path} would land outside the workspace folder`,
      );
    const target = join(root, path);
    const existing = await lstat(target).catch(() => undefined);
    if (existing && !existing.isFile())
      throw new DaedalusError(
        "CONFLICT",
        `${path} on this Mac is not a file, so it cannot be replaced`,
      );
    // Copied, not read whole: a file may be up to the archive's cap.
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await copyFile(join(scratch, path), temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, 0o644);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

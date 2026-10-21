import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, parse, resolve, sep } from "node:path";

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function createDirectoryExclusive(path: string): Promise<void> {
  await mkdir(path);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function canonicalPath(path: string): Promise<string> {
  return realpath(path);
}

export function isPathInside(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target.startsWith(`${base}${sep}`);
}

export function isRootLikePath(path: string): boolean {
  const target = resolve(path);
  const root = parse(target).root;
  const depth = target.slice(root.length).split(sep).filter(Boolean).length;
  return target === root || target === resolve(homedir()) || depth < 2;
}

export async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: false });
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeTextFile(
  path: string,
  contents: string,
): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
}

export async function movePath(from: string, to: string): Promise<void> {
  await rename(from, to);
}

export interface WriteFileAtomicOptions {
  /** Permission bits of the new file. Omitted, the process umask decides. */
  mode?: number;
  /** Create the parent directory first, with default permissions. */
  ensureDir?: boolean;
  /** Flush the data to disk before the rename, for files that hold secrets. */
  sync?: boolean;
}

/**
 * Replaces `path` whole or not at all. The data goes to a uniquely named
 * temporary file beside it and is renamed over the destination, so a reader
 * never sees half a file and a crash leaves the old one. The temporary file
 * is removed if anything fails.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  if (options.ensureDir) await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", options.mode);
    try {
      await handle.writeFile(data);
      if (options.sync) await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface EditJsonOptions {
  /** Permission bits for the file when it is written. */
  mode?: number;
  /** Delete the file instead of writing an empty object. */
  removeWhenEmpty?: boolean;
  /**
   * Called with the file's current text, when there is any, just before the
   * file is replaced or removed. For taking a backup of the user's original.
   */
  beforeReplace?: (raw: string) => Promise<void>;
}

export type EditJsonResult =
  | { status: "unchanged" | "written" | "removed" }
  /** The file exists and is not a JSON object. It is left as it was. */
  | { status: "invalid" };

/**
 * The one way Daedalus edits a JSON settings file it shares with a provider.
 * Reads the object (a missing or blank file is `{}`), passes it to `change`,
 * and writes the result with two-space indent and a trailing newline. Nothing
 * is written when the text would not change, and a file that does not parse is
 * reported as `invalid` rather than replaced.
 */
export async function editJson(
  path: string,
  change: (current: Record<string, unknown>) => Record<string, unknown>,
  options: EditJsonOptions = {},
): Promise<EditJsonResult> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let current: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        return { status: "invalid" };
      current = parsed as Record<string, unknown>;
    } catch {
      return { status: "invalid" };
    }
  }
  const next = change(current);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (serialized === raw) return { status: "unchanged" };
  if (raw && options.beforeReplace) await options.beforeReplace(raw);
  if (options.removeWhenEmpty && Object.keys(next).length === 0) {
    await rm(path, { force: true });
    return { status: "removed" };
  }
  await writeFileAtomic(path, serialized, {
    mode: options.mode,
    ensureDir: true,
  });
  return { status: "written" };
}

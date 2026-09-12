import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { parse, resolve, sep } from "node:path";

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

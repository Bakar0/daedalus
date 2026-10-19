import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RunnerError } from "./errors";

const realpathOfExisting = (path: string): string => {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
};

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
};

/**
 * Turns a request path into an absolute path under `root`. Refuses absolute
 * paths, `..` that leaves the root, and symlinks that point out of it. This
 * runs in `sessiond` as the session uid, so it guards against mistakes, not
 * against the agent: the agent can already do anything that uid can.
 */
export function resolveWorkspacePath(root: string, requested: string): string {
  if (typeof requested !== "string" || requested.includes("\0"))
    throw new RunnerError("VALIDATION", "Path must be a string");
  if (isAbsolute(requested))
    throw new RunnerError(
      "PATH_OUTSIDE_WORKSPACE",
      `Path ${requested} is absolute; paths are relative to the workspace`,
    );
  const absolute = resolve(root, requested);
  if (!inside(root, absolute))
    throw new RunnerError(
      "PATH_OUTSIDE_WORKSPACE",
      `Path ${requested} leaves the workspace`,
    );
  const realRoot = realpathOfExisting(root);
  const real = realpathOfExisting(absolute);
  if (!inside(realRoot, real))
    throw new RunnerError(
      "PATH_OUTSIDE_WORKSPACE",
      `Path ${requested} leaves the workspace through a link`,
    );
  return absolute;
}

/** The inverse, for the shim: a working directory as a workspace path, or "." outside it. */
export function toWorkspacePath(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return ".";
  return rel;
}

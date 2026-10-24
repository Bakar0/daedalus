import { DaedalusError } from "../errors";
import type { MoveSide, PodAccess } from "./move-side";

/**
 * Codex conversations as a move carries them
 * (artifacts/cloud-sessions/codex-spike.md, section 3). A conversation is
 * one rollout, `sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`, and
 * `codex resume` needs nothing else: Codex reads the rollout over its own
 * databases, which never travel. A resumed turn only appends to the file.
 */

/** Where Codex keeps conversations in the pod, from its workspace root. */
export const POD_CODEX_SESSIONS = ".home/.codex/sessions";
/** The pod's Codex home as Codex names it inside a rollout. */
export const POD_CODEX_HOME = "/workspace/.home/.codex";

const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Codex thread id: what a rollout's name ends with. */
export const isCodexThread = (id: unknown): id is string =>
  typeof id === "string" && THREAD.test(id);

/**
 * A rollout's path under a sessions folder, for one thread: a date folder
 * and Codex's own file name, nothing else a move would write.
 */
export function isCodexRolloutPath(path: string, thread: string): boolean {
  if (!isCodexThread(thread)) return false;
  const match =
    /^(\d{4})\/(\d{2})\/(\d{2})\/rollout-[0-9T-]{1,40}-([0-9a-f-]{36})\.jsonl$/.exec(
      path,
    );
  return Boolean(match && match[4] === thread);
}

/**
 * The rollout of a thread on one side, relative to its sessions folder, or
 * undefined when that side has none with anything in it. If Codex ever kept
 * two, the newest name wins.
 */
export async function findCodexRollout(
  side: Pick<MoveSide, "run" | "absolute">,
  sessions: string,
  thread: string | null | undefined,
): Promise<string | undefined> {
  if (!isCodexThread(thread)) return undefined;
  const root = side.absolute(sessions);
  const listing = await side.run(".", "find", [
    root,
    "-mindepth",
    "4",
    "-maxdepth",
    "4",
    "-type",
    "f",
    "-name",
    `rollout-*-${thread}.jsonl`,
    "-size",
    "+0c",
    "-print0",
  ]);
  if (listing.exitCode !== 0) return undefined;
  const prefix = `${root.replace(/\/+$/, "")}/`;
  return listing.stdout
    .split("\0")
    .filter((found) => found.startsWith(prefix))
    .map((found) => found.slice(prefix.length))
    .filter((path) => isCodexRolloutPath(path, thread))
    .sort()
    .at(-1);
}

/** `findCodexRollout` in a pod, for a launch that may resume there. */
export async function podCodexRollout(
  pod: Pick<PodAccess, "run">,
  thread: string | null | undefined,
): Promise<string | undefined> {
  return findCodexRollout(
    {
      run: (cwd, executable, args) => pod.run({ cwd, executable, args }),
      absolute: (path) => `/workspace/${path}`,
    },
    POD_CODEX_SESSIONS,
    thread,
  );
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrites a rollout for its new home: every path under one of the `from`
 * folders, wherever it appears in a string (the session's `cwd` fields, the
 * environment text Codex sends the model, its skills under the Codex home),
 * moves under the matching `to`. A path only matches whole, not as the start
 * of a longer name. With `strict`, a line that is not a JSON object fails
 * the move; that is how a rollout from a pod is read.
 */
export function rewriteCodexRollout(
  text: string,
  pairs: ReadonlyArray<{ from: string; to: string }>,
  strict: boolean,
): string {
  const ordered = pairs
    .filter((pair) => pair.from && pair.from !== pair.to)
    .sort((a, b) => b.from.length - a.from.length);
  if (!ordered.length && !strict) return text;
  const pattern = ordered.length
    ? new RegExp(
        `(?<![A-Za-z0-9._/-])(${ordered.map((pair) => escape(pair.from)).join("|")})(?![A-Za-z0-9._-])`,
        "g",
      )
    : undefined;
  const target = new Map(ordered.map((pair) => [pair.from, pair.to]));
  const swap = (value: string) =>
    pattern ? value.replace(pattern, (found) => target.get(found)!) : value;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return swap(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, walk(inner)]),
      );
    return value;
  };
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        entry = undefined;
      }
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        if (strict)
          throw new DaedalusError(
            "DEPENDENCY",
            "The conversation from the cloud workspace is not a Codex rollout",
          );
        return line;
      }
      if (!pattern || !pattern.test(line)) return line;
      pattern.lastIndex = 0;
      return JSON.stringify(walk(entry));
    })
    .join("\n");
}

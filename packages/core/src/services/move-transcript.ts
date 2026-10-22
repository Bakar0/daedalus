import { DaedalusError } from "../errors";
import { must, type MoveSide } from "./move-side";

/**
 * Claude's conversation as a move carries it: `<id>.jsonl` and the files
 * under `<id>/` (subagent transcripts, saved tool output), by path relative
 * to the project folder.
 */
export interface TranscriptFiles {
  files: { path: string; contents: Uint8Array }[];
}

/** Claude's permission modes; anything else in a transcript is refused. */
export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export const isClaudePermissionMode = (
  value: unknown,
): value is ClaudePermissionMode =>
  typeof value === "string" &&
  (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);

const NAME = /^[A-Za-z0-9._-]{1,200}$/;
/** Under `<id>/`: `subagents/x.jsonl`, `tool-results/x.txt` and the like. */
const MAX_DEPTH = 3;

/** A path under `<id>/` that a move may write: plain names, no dot-dot. */
export function safeTranscriptPath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length >= 1 &&
    parts.length <= MAX_DEPTH &&
    parts.every((part) => NAME.test(part) && part !== "." && part !== "..")
  );
}

/**
 * Reads a session's transcript files on one side. `projects` is the side's
 * Claude projects folder and `key` the project folder's name.
 */
export async function readTranscript(
  side: MoveSide,
  projects: string,
  key: string,
  conversationId: string,
  maxBytes: number,
): Promise<TranscriptFiles> {
  const folder = side.join(projects, key);
  const main = await side.readFile(
    side.join(folder, `${conversationId}.jsonl`),
  );
  if (!main)
    throw new DaedalusError(
      "CONFLICT",
      `The session's conversation is not on ${side.label}`,
    );
  const files = [{ path: `${conversationId}.jsonl`, contents: main }];
  let total = main.length;
  const listing = await side.run(".", "find", [
    side.absolute(side.join(folder, conversationId)),
    "-mindepth",
    "1",
    "-maxdepth",
    String(MAX_DEPTH),
    "-type",
    "f",
    "-print0",
  ]);
  const root = `${side.absolute(side.join(folder, conversationId))}/`;
  for (const found of listing.exitCode === 0
    ? listing.stdout.split("\0").filter(Boolean)
    : []) {
    if (!found.startsWith(root)) continue;
    const relative = found.slice(root.length);
    // Names the move would not write are left behind on either side.
    if (!safeTranscriptPath(relative)) continue;
    const contents = await side.readFile(
      side.join(folder, conversationId, ...relative.split("/")),
    );
    if (!contents) continue;
    total += contents.length;
    if (total > maxBytes)
      throw new DaedalusError(
        "CONFLICT",
        `The session's conversation is over ${maxBytes} bytes`,
      );
    files.push({ path: `${conversationId}/${relative}`, contents });
  }
  return { files };
}

/**
 * Rewrites one transcript for its new home: `cwd` fields under `from` move
 * under `to`, and with `permissionMode` every recorded permission mode is
 * that one. With `strict` a line that is not a JSON object fails the move;
 * that is how a transcript from a pod is read.
 */
export function rewriteTranscript(
  text: string,
  options: {
    from: string;
    to: string;
    permissionMode?: ClaudePermissionMode;
    strict: boolean;
  },
): string {
  const { from, to, permissionMode, strict } = options;
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
            "The conversation from the cloud workspace is not a Claude transcript",
          );
        return line;
      }
      const record = entry as Record<string, unknown>;
      let changed = false;
      const cwd = record.cwd;
      if (
        typeof cwd === "string" &&
        (cwd === from || cwd.startsWith(`${from}/`))
      ) {
        record.cwd = to + cwd.slice(from.length);
        changed = true;
      }
      if (permissionMode && "permissionMode" in record) {
        record.permissionMode = permissionMode;
        changed = true;
      }
      return changed ? JSON.stringify(record) : line;
    })
    .join("\n");
}

/** The permission mode a transcript last recorded, if it is one Claude has. */
export function lastPermissionMode(
  text: string,
): ClaudePermissionMode | undefined {
  let mode: ClaudePermissionMode | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"permissionMode"')) continue;
    try {
      const value = (JSON.parse(line) as { permissionMode?: unknown })
        .permissionMode;
      if (isClaudePermissionMode(value)) mode = value;
    } catch {
      // A line that is not JSON says nothing about the mode.
    }
  }
  return mode;
}

/** Writes transcript files into a side's project folder. */
export async function writeTranscript(
  side: MoveSide,
  projects: string,
  key: string,
  transcript: TranscriptFiles,
): Promise<void> {
  const folder = side.join(projects, key);
  await must(side, ".", "mkdir", ["-p", "--", side.absolute(folder)]);
  for (const file of transcript.files) {
    const [first, ...rest] = file.path.split("/");
    if (!first || (rest.length && !safeTranscriptPath(rest.join("/"))))
      throw new DaedalusError(
        "DEPENDENCY",
        "The conversation from the cloud workspace names a file Daedalus will not write",
      );
    await side.writeFile(
      side.join(folder, ...file.path.split("/")),
      file.contents,
    );
  }
}

/**
 * One transcript file as a move sent it: its bytes on this Mac, and what the
 * pod was given (cwd fields rewritten). Kept on this Mac.
 */
export interface SentTranscriptFile {
  path: string;
  macLength: number;
  macSha256: string;
  podLength: number;
  podSha256: string;
}

export const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export const sentFile = (
  path: string,
  mac: Uint8Array,
  pod: Uint8Array,
): SentTranscriptFile => ({
  path,
  macLength: mac.length,
  macSha256: sha256(mac),
  podLength: pod.length,
  podSha256: sha256(pod),
});

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/**
 * The conversation to resume on this Mac from what the pod sends back. The
 * pod may only add: every file the Mac sent must start with exactly the
 * bytes it was given, and this Mac's own copy, unchanged since, is kept with
 * only the added part after it. Added JSON lines must parse (`rewrite` is
 * strict) and come out of `rewrite`; a file the pod made is read the same way.
 */
export function appendedTranscript(input: {
  pod: TranscriptFiles;
  sent: SentTranscriptFile[];
  /** This Mac's copy of a file the move sent, as it is now. */
  mac: (path: string) => Uint8Array | undefined;
  rewrite: (text: string) => string;
}): TranscriptFiles {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const added = (path: string, bytes: Uint8Array): Uint8Array => {
    if (!path.endsWith(".jsonl")) return bytes;
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw new DaedalusError(
        "DEPENDENCY",
        "The conversation from the cloud workspace is not a Claude transcript",
      );
    }
    return new TextEncoder().encode(input.rewrite(text));
  };
  const files = input.pod.files.map((file) => {
    const sent = input.sent.find((entry) => entry.path === file.path);
    if (!sent)
      return { path: file.path, contents: added(file.path, file.contents) };
    if (
      file.contents.length < sent.podLength ||
      sha256(file.contents.subarray(0, sent.podLength)) !== sent.podSha256
    )
      throw new DaedalusError(
        "CONFLICT",
        "The conversation in the cloud workspace was changed, not only added to, so it does not come back to this Mac",
      );
    const mac = input.mac(file.path);
    if (!mac || mac.length !== sent.macLength || sha256(mac) !== sent.macSha256)
      throw new DaedalusError(
        "CONFLICT",
        "This Mac's copy of the conversation changed while the session was in the cloud",
      );
    return {
      path: file.path,
      contents: concat(
        mac,
        added(file.path, file.contents.subarray(sent.podLength)),
      ),
    };
  });
  return { files };
}

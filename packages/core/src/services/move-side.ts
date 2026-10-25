import { lstat, readFile, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { CommandResult, RunnerCommand } from "@daedalus/remote-protocol";
import {
  findExecutable,
  runCommand,
  writeFileAtomic,
} from "@daedalus/platform";
import { DaedalusError } from "../errors";

/**
 * One end of a session move: this Mac, or a cloud workspace's pod. Both run
 * the same git commands; only how a command runs and a file travels differs.
 * Paths are each side's own: absolute on this Mac, relative to the workspace
 * root in a pod.
 */
export interface MoveSide {
  /** For messages: "this Mac" or "the cloud workspace". */
  readonly label: string;
  run(
    cwd: string,
    executable: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<CommandResult>;
  /** Undefined when the file is not there. */
  readFile(path: string): Promise<Uint8Array | undefined>;
  writeFile(path: string, contents: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** The path as a command's argument takes it. */
  absolute(path: string): string;
  join(...parts: string[]): string;
}

/** A command that has to succeed; its output, trimmed. */
export async function must(
  side: MoveSide,
  cwd: string,
  executable: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await side.run(cwd, executable, args, env);
  if (result.exitCode !== 0)
    throw new DaedalusError(
      "DEPENDENCY",
      `${executable} ${args[0] ?? ""} failed on ${side.label}: ${(result.stderr || result.stdout).trim().slice(-500)}`,
    );
  return result.stdout.trim();
}

export class LocalMoveSide implements MoveSide {
  readonly label = "this Mac";

  async run(
    cwd: string,
    executable: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<CommandResult> {
    const result = await runCommand(
      findExecutable(executable) ?? executable,
      args,
      { cwd, ...(env ? { env } : {}), timeoutMs: 10 * 60_000 },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async readFile(path: string): Promise<Uint8Array | undefined> {
    try {
      const stats = await lstat(path);
      if (!stats.isFile()) return undefined;
      return new Uint8Array(await readFile(path));
    } catch {
      return undefined;
    }
  }

  /** Written whole and private, never through a link at the path itself. */
  async writeFile(path: string, contents: Uint8Array): Promise<void> {
    await writeFileAtomic(path, contents, { mode: 0o600, ensureDir: true });
  }

  remove(path: string): Promise<void> {
    return rm(path, { recursive: true, force: true });
  }

  absolute(path: string): string {
    return path;
  }

  join(...parts: string[]): string {
    return join(...parts);
  }
}

/** What a move needs of a pod: `RemoteSessionHost` has it. */
export interface PodAccess {
  run(command: RunnerCommand): Promise<CommandResult>;
  readFile(path: string): Promise<Uint8Array | undefined>;
  writeFiles(files: { path: string; contents: Uint8Array }[]): Promise<void>;
}

export const isPodAccess = (host: unknown): host is PodAccess =>
  typeof host === "object" &&
  host !== null &&
  typeof (host as PodAccess).run === "function" &&
  typeof (host as PodAccess).readFile === "function" &&
  typeof (host as PodAccess).writeFiles === "function";

/**
 * A relay frame is at most 8 MiB and `fs.read` refuses files over 8 MiB, so
 * a file travels in pieces of this size, base64 included.
 */
export const MOVE_CHUNK_BYTES = 4 * 1024 * 1024;
const POD_ROOT = "/workspace";

export class PodMoveSide implements MoveSide {
  readonly label = "the cloud workspace";

  constructor(
    private readonly pod: PodAccess,
    private readonly maxFileBytes: number,
    /** The pod's workspace root; a test's folder stands in for it. */
    private readonly root = POD_ROOT,
  ) {}

  run(
    cwd: string,
    executable: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<CommandResult> {
    return this.pod.run({
      cwd,
      executable,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10 * 60_000,
    });
  }

  async readFile(path: string): Promise<Uint8Array | undefined> {
    // A link is not followed, here or by `fs.read` out of the workspace.
    if ((await this.run(".", "test", ["-L", path])).exitCode === 0)
      return undefined;
    if ((await this.run(".", "test", ["-f", path])).exitCode !== 0)
      return undefined;
    const count = /^\s*(\d+)\s/.exec(
      (await must(this, ".", "wc", ["-c", "--", path])) + " ",
    );
    if (!count) return undefined;
    const size = Number(count[1]);
    if (size > this.maxFileBytes)
      throw new DaedalusError(
        "CONFLICT",
        `${path} in the cloud workspace is ${size} bytes; a move carries at most ${this.maxFileBytes}`,
      );
    if (size <= MOVE_CHUNK_BYTES) return this.pod.readFile(path);
    const parts = `${path}.daedalus-parts`;
    try {
      await must(this, ".", "mkdir", ["-p", "--", parts]);
      await must(this, ".", "split", [
        "-b",
        String(MOVE_CHUNK_BYTES),
        "-d",
        "-a",
        "4",
        "--",
        path,
        `${parts}/part.`,
      ]);
      const out = new Uint8Array(size);
      let offset = 0;
      for (let index = 0; offset < size; index++) {
        const piece = await this.pod.readFile(
          `${parts}/part.${String(index).padStart(4, "0")}`,
        );
        if (!piece || offset + piece.length > size)
          throw new DaedalusError(
            "DEPENDENCY",
            `${path} changed while it was copied from the cloud workspace`,
          );
        out.set(piece, offset);
        offset += piece.length;
      }
      return out;
    } finally {
      await this.remove(parts).catch(() => undefined);
    }
  }

  async writeFile(path: string, contents: Uint8Array): Promise<void> {
    if (contents.length <= MOVE_CHUNK_BYTES) {
      await this.pod.writeFiles([{ path, contents }]);
      return;
    }
    const parts = `${path}.daedalus-parts`;
    try {
      const names: string[] = [];
      for (
        let offset = 0, index = 0;
        offset < contents.length;
        offset += MOVE_CHUNK_BYTES, index++
      ) {
        const name = `${parts}/part.${String(index).padStart(4, "0")}`;
        names.push(name);
        await this.pod.writeFiles([
          {
            path: name,
            contents: contents.subarray(offset, offset + MOVE_CHUNK_BYTES),
          },
        ]);
      }
      await must(this, ".", "bash", [
        "-c",
        'out=$1; shift; cat -- "$@" > "$out"',
        "bash",
        path,
        ...names,
      ]);
    } finally {
      await this.remove(parts).catch(() => undefined);
    }
  }

  async remove(path: string): Promise<void> {
    await must(this, ".", "rm", ["-rf", "--", path]);
  }

  absolute(path: string): string {
    return posix.join(this.root, path);
  }

  join(...parts: string[]): string {
    return posix.join(...parts);
  }
}

/** Where Claude keeps conversations in the pod, from its workspace root. */
export const POD_CLAUDE_PROJECTS = ".home/.claude/projects";

/** Claude's folder for a working directory: every other character a dash. */
export const claudeProjectKey = (workingDirectory: string): string =>
  workingDirectory.replace(/[^a-zA-Z0-9]/g, "-");

/** The pod's absolute form of a session's workspace-relative folder. */
export const podWorkingDirectory = (relative: string): string =>
  posix.join(POD_ROOT, relative);

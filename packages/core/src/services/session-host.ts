import {
  TmuxPtyBridge,
  type TmuxClient,
  type TmuxLaunch,
} from "@daedalus/platform";
import type { AgentProviderName, AgentSession } from "../domain";
import { DaedalusError } from "../errors";

/**
 * Where a session's process runs. Today every session runs in tmux on this
 * Mac; a cloud host runs it in a container or VM somewhere else.
 *
 * DRAFT. Nothing calls this yet. It is shaped from what `AgentService` already
 * asks of `TmuxClient`, plus the two things a second machine adds: a terminal
 * that is not a local PTY, and state that has to be copied before a session
 * can continue there.
 *
 * What stays on the Mac: the SQLite database, the board, tasks, secrets and
 * every decision about a session. A host only runs processes and holds files.
 */
export interface SessionHost {
  /** `"local"` for this Mac; a stable id for each cloud host. */
  readonly id: string;
  readonly kind: "local" | "cloud";

  /**
   * Whether the host can take sessions right now. `undefined` means it is
   * reachable; a string is the reason it is not, shown to the user.
   */
  probe(): Promise<string | undefined>;

  /** Starts the provider under `launch.session`. Mirrors `createSession`. */
  start(launch: SessionHostLaunch): Promise<void>;
  isLive(session: string): Promise<boolean>;
  /** Throws when the host did not answer, which is not the same as none. */
  listLive(): Promise<string[]>;
  capture(session: string, options?: { styled?: boolean }): Promise<string>;
  sendKeys(session: string, keys: string[]): Promise<void>;
  send(session: string, text: string): Promise<void>;
  stop(session: string, force?: boolean): Promise<void>;

  /**
   * A live terminal on the session, for the desktop and phone views. Replaces
   * the two places that build a `TmuxPtyBridge` themselves
   * (apps/desktop/src/bun/index.ts and remote.ts).
   */
  openTerminal(
    session: string,
    size: TerminalSize,
    onOutput: (output: Uint8Array) => void,
  ): Promise<SessionTerminal>;

  /**
   * Copies out what another host needs to continue the session. The session
   * must be stopped first: a provider still writing its transcript would
   * leave the copy behind the original.
   */
  exportCheckpoint(session: AgentSession): Promise<SessionCheckpoint>;

  /**
   * Lays a checkpoint down on this host and returns where the session's
   * working directory now is. After this, `AgentService` resumes the
   * conversation with `start` and the provider's own resume arguments.
   */
  importCheckpoint(checkpoint: SessionCheckpoint): Promise<{
    workingDirectory: string;
  }>;
}

export interface SessionHostLaunch extends TmuxLaunch {
  /**
   * The session's secrets, kept apart from `env` so a cloud host can inject
   * them into the process without writing them to its disk or its logs.
   * A local host merges them into `env`.
   */
  secrets?: Record<string, string>;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** The part of `TmuxPtyBridge` that `TerminalConnection` uses. */
export interface SessionTerminal {
  /** Resolves when the terminal closes from either end. */
  start(): Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * Everything a session needs to continue on another host. It holds no process
 * state: moving a session means stopping it, copying this, and resuming the
 * provider's conversation on the other side.
 */
export interface SessionCheckpoint {
  sessionId: string;
  provider: AgentProviderName;
  /** The id the provider resumes from (`claude --resume`, `codex resume`). */
  providerSessionId: string | null;
  /**
   * The working directory relative to the workspace root, so the other host
   * can rebuild the same layout under its own root.
   */
  workingDirectory: string;
  worktrees: CheckpointWorktree[];
  /**
   * The provider's conversation files, by path relative to the provider's
   * home: for Claude, `projects/<cwd-slug>/<id>.jsonl`; for Codex, its
   * rollout file. Claude keys the folder by the working directory's absolute
   * path, so the importing host has to rename it to match its own path.
   */
  transcript: CheckpointFile[];
  /** BRIEF.md, JOURNAL.md and the rest of the workspace files the agent reads. */
  workspaceFiles: CheckpointFile[];
}

export interface CheckpointWorktree {
  repositoryId: string;
  /** Relative to the workspace root, as for `workingDirectory`. */
  path: string;
  branchName: string;
  /** The commit the branch was at, pushed to the remote before export. */
  headCommit: string;
  /** `git diff --binary HEAD` plus untracked files, or null when clean. */
  uncommittedPatch: Uint8Array | null;
}

export interface CheckpointFile {
  path: string;
  contents: Uint8Array;
}

/** The host every session runs on today: tmux on this Mac. */
export class LocalSessionHost implements SessionHost {
  readonly id = "local";
  readonly kind = "local" as const;

  constructor(
    private readonly tmux: TmuxClient,
    private readonly terminal: { socketName: string; executable: string },
  ) {}

  async probe(): Promise<string | undefined> {
    return (await this.tmux.probe()) ? undefined : "tmux is not available";
  }

  start({ secrets, ...launch }: SessionHostLaunch): Promise<void> {
    return this.tmux.createSession({
      ...launch,
      env: { ...launch.env, ...secrets },
    });
  }

  isLive(session: string): Promise<boolean> {
    return this.tmux.hasSession(session);
  }

  listLive(): Promise<string[]> {
    return this.tmux.listSessions();
  }

  capture(session: string, options?: { styled?: boolean }): Promise<string> {
    return this.tmux.capture(session, options);
  }

  sendKeys(session: string, keys: string[]): Promise<void> {
    return this.tmux.sendKeys(session, keys);
  }

  send(session: string, text: string): Promise<void> {
    return this.tmux.send(session, text);
  }

  stop(session: string, force?: boolean): Promise<void> {
    return this.tmux.stop(session, force);
  }

  async openTerminal(
    session: string,
    size: TerminalSize,
    onOutput: (output: Uint8Array) => void,
  ): Promise<SessionTerminal> {
    return new TmuxPtyBridge(
      onOutput,
      { socketName: this.terminal.socketName, session },
      size,
      this.terminal.executable,
    );
  }

  async exportCheckpoint(): Promise<SessionCheckpoint> {
    throw new DaedalusError("INTERNAL", "Checkpoints are not built yet");
  }

  async importCheckpoint(): Promise<{ workingDirectory: string }> {
    throw new DaedalusError("INTERNAL", "Checkpoints are not built yet");
  }
}

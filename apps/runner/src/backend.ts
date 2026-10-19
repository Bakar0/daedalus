import type { SessiondMethod, SessiondMethods } from "./sessiond-protocol";

export interface Terminal {
  start(): Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * Everything the runner asks of the session container. The runner runs no
 * tmux and no workspace command itself; `SessiondClient` implements this over
 * a Unix socket, and its answers are untrusted.
 */
export interface SessionBackend {
  call<M extends SessiondMethod>(
    method: M,
    params: SessiondMethods[M]["params"],
  ): Promise<SessiondMethods[M]["result"]>;
  /** Rejects with code LOST when the session is not live. */
  openTerminal(
    session: string,
    size: { cols: number; rows: number },
    onOutput: (output: Uint8Array) => void,
  ): Promise<Terminal>;
}

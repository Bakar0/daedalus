import type { RunnerMethods } from "@daedalus/remote-protocol";

/**
 * The protocol between the runner container and `sessiond` in the session
 * container (artifacts/cloud-sessions/h1-pod-spec.md). Internal to
 * `apps/runner`: the runner is the only client.
 *
 * The socket is `RUNNER_PATHS.sessionSocket`. Each connection is one of two
 * kinds, told apart by its first line (one JSON object, ended by "\n"):
 *
 *   request   {"method": <SessiondMethod>, "params": ...}
 *             answered by one line, {"result": ...} or
 *             {"error": {"code", "message"}}, and the server closes.
 *
 *   terminal  {"terminal": {"session", "cols", "rows"}}
 *             answered by one line, {"ok": true} or {"error": ...}. After
 *             that, sessiond sends raw terminal output and the runner sends
 *             input frames (see `encodeInputFrame`). The server closes when
 *             the terminal ends; the runner closes to end it.
 *
 * Nothing in either direction runs a command for the other side. The runner
 * treats every reply as untrusted, since an agent can kill `sessiond` and
 * listen on the socket in its place: replies are size limited, and a request
 * that gets no answer times out.
 */
export interface SessiondMethods extends Omit<RunnerMethods, "auth.callback"> {
  /** Sessions whose command ended, with the exit status, by session name. */
  deadPanes: { params: null; result: Record<string, number | null> };
}
export type SessiondMethod = keyof SessiondMethods;

export const SESSIOND_METHODS: readonly SessiondMethod[] = [
  "host.probe",
  "host.start",
  "host.isLive",
  "host.listLive",
  "host.capture",
  "host.sendKeys",
  "host.send",
  "host.stop",
  "host.run",
  "fs.write",
  "fs.read",
  "deadPanes",
];

/** What the Mac may ask of the runner: every method but `deadPanes`. */
export const MAC_FACING_METHODS: ReadonlySet<string> = new Set(
  SESSIOND_METHODS.filter((method) => method !== "deadPanes"),
);

/** One reply line. fs.read is at most 8 MiB, or 11 MiB as base64; host.run 2 MiB. */
export const MAX_REPLY_BYTES = 16 * 1024 * 1024;
/** A request line: fs.write batches files. */
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
/** The first line of a terminal connection, and its reply. */
export const MAX_HEADER_BYTES = 4 * 1024;
export const MAX_INPUT_FRAME_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
/** Slack added to a command's own timeout. */
export const RUN_TIMEOUT_SLACK_MS = 30_000;

export type SessiondRequest = {
  [M in SessiondMethod]: { method: M; params: SessiondMethods[M]["params"] };
}[SessiondMethod];

export interface TerminalHeader {
  terminal: { session: string; cols: number; rows: number };
}

const INPUT = 0;
const RESIZE = 1;

/** Runner to sessiond on a terminal connection: type, 4-byte length, payload. */
export function encodeInputFrame(
  message:
    | { type: "input"; data: string }
    | { type: "resize"; cols: number; rows: number },
): Uint8Array {
  const body = new TextEncoder().encode(
    message.type === "input"
      ? message.data
      : JSON.stringify({ cols: message.cols, rows: message.rows }),
  );
  const out = new Uint8Array(5 + body.length);
  out[0] = message.type === "input" ? INPUT : RESIZE;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

/** Splits a byte stream into input frames; keeps what is incomplete. */
export class InputFrameReader {
  #buffer = new Uint8Array(0);

  /** Throws on a frame that is too long or has an unknown type. */
  push(
    chunk: Uint8Array,
  ): (
    | { type: "input"; data: string }
    | { type: "resize"; cols: number; rows: number }
  )[] {
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.length);
    const frames: ReturnType<InputFrameReader["push"]> = [];
    let offset = 0;
    while (joined.length - offset >= 5) {
      const type = joined[offset];
      const length = new DataView(
        joined.buffer,
        joined.byteOffset + offset + 1,
        4,
      ).getUint32(0);
      if (length > MAX_INPUT_FRAME_BYTES)
        throw new Error("Input frame too long");
      if (joined.length - offset - 5 < length) break;
      const body = joined.subarray(offset + 5, offset + 5 + length);
      if (type === INPUT) {
        frames.push({ type: "input", data: new TextDecoder().decode(body) });
      } else if (type === RESIZE) {
        const size = JSON.parse(new TextDecoder().decode(body)) as {
          cols: unknown;
          rows: unknown;
        };
        if (typeof size.cols !== "number" || typeof size.rows !== "number")
          throw new Error("Bad resize frame");
        frames.push({ type: "resize", cols: size.cols, rows: size.rows });
      } else throw new Error("Unknown input frame");
      offset += 5 + length;
    }
    this.#buffer = joined.slice(offset);
    return frames;
  }
}

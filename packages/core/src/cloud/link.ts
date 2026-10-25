import type { TerminalServerMessage } from "@daedalus/protocol";
import {
  acceptHandshake,
  decodePayload,
  decodeRelayFrame,
  decodeSecurePlaintext,
  encodePlain,
  encodeRelayFrame,
  encodeRunnerMessage,
  encodeSealed,
  sodiumReady,
  type DaedalCall,
  type CommandResult,
  type DeviceIdentity,
  type Hello,
  type Ready,
  type RelayNotice,
  type RunnerMethod,
  type RunnerMethods,
  type RunnerSecureMessage,
  type SecureChannel,
} from "@daedalus/remote-protocol";
import { DaedalusError } from "../errors";
import { gatewayOrigin } from "./gateway-client";

/**
 * This Mac's one connection to a cloud gateway's relay, as `mac:<macId>`, and
 * the secure channel to each workspace's runner over it.
 *
 * The runner starts the Noise KK handshake (the phone's role) and this Mac
 * answers it with `acceptHandshake`, against the runner key pinned for that
 * workspace. A runner with any other key fails the handshake. Inside the
 * channel, `RunnerSecureMessage` carries requests both ways, session exits
 * and terminals (packages/remote-protocol/src/runner.ts).
 */

export interface RelaySocket {
  send(data: Uint8Array | string): void;
  close(): void;
}

export interface RelayCallbacks {
  open(): void;
  text(text: string): void;
  binary(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

export type ConnectRelay = (
  url: string,
  token: string,
  callbacks: RelayCallbacks,
) => RelaySocket;

/** A WebSocket with the bearer token on the upgrade, as the gateway wants. */
export const connectWebSocket: ConnectRelay = (url, token, callbacks) => {
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => callbacks.open());
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") callbacks.text(event.data);
    else callbacks.binary(new Uint8Array(event.data as ArrayBuffer));
  });
  socket.addEventListener("close", (event) =>
    callbacks.close(event.code, event.reason),
  );
  return {
    send: (data) => socket.send(data as string | Uint8Array<ArrayBuffer>),
    close: () => socket.close(),
  };
};

export interface RunnerTerminalEvents {
  output(data: Uint8Array): void;
  server(message: TerminalServerMessage): void;
  /** The channel ended: closed, or the link to the runner went away. */
  closed(): void;
}

/** What a `RemoteSessionHost` needs from whatever reaches the runner. */
export interface RunnerTransport {
  /** Undefined when the runner can take requests; otherwise why not. */
  unavailable(workspaceId: string): Promise<string | undefined>;
  request<M extends RunnerMethod>(
    workspaceId: string,
    method: M,
    params: RunnerMethods[M]["params"],
    timeoutMs?: number,
  ): Promise<RunnerMethods[M]["result"]>;
  /** Undefined when this transport carries no terminals. */
  openTerminal?(
    workspaceId: string,
    session: string,
    size: { cols: number; rows: number },
    events: RunnerTerminalEvents,
  ): RunnerTerminalChannel;
}

export interface RunnerTerminalChannel {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface CloudLinkOptions {
  gatewayUrl: string;
  token: string;
  identity: DeviceIdentity;
  /**
   * The key to accept a workspace's runner with. Pins it the first time it
   * is seen; undefined refuses the runner.
   */
  runnerKey(workspaceId: string): Promise<string | undefined>;
  /** Answers `daedal.call` from a runner. */
  answer(hostId: string, call: DaedalCall): Promise<CommandResult>;
  /** A session in the workspace ended, with its exit code when known. */
  onSessionExited?(
    workspaceId: string,
    session: string,
    exitCode: number | null,
  ): void;
  /** A runner's secure channel came up or went away. */
  onRunner?(workspaceId: string, linked: boolean): void;
  /** A runner is about to ask the gateway to sleep its idle workspace. */
  onWorkspaceSleeping?(workspaceId: string): void;
  connect?: ConnectRelay;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  backoff?: { initialMs: number; maxMs: number };
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PING_MS = 25_000;

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface RunnerState {
  online: boolean;
  handshake?: { finish(ready: Ready): SecureChannel };
  channel?: SecureChannel;
  /** Frames from one runner are handled in order, one at a time. */
  queue: Promise<void>;
  pending: Map<number, Pending>;
  terminals: Map<number, RunnerTerminalEvents>;
  /** Waiters for the channel to come up. */
  waiting: Array<() => void>;
}

const workspaceOf = (deviceId: string) =>
  deviceId.startsWith("ws:") ? deviceId.slice(3) : undefined;

export class CloudLink implements RunnerTransport {
  readonly #o: CloudLinkOptions;
  readonly #runners = new Map<string, RunnerState>();
  #socket: RelaySocket | undefined;
  #connected = false;
  #stopped = true;
  #retryDelay: number;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #ping: ReturnType<typeof setInterval> | undefined;
  #nextId = 1;
  #nextChannel = 1;
  #lastError: string | undefined;

  constructor(options: CloudLinkOptions) {
    this.#o = options;
    this.#retryDelay = options.backoff?.initialMs ?? 1000;
  }

  get macId(): string {
    return this.#o.identity.id;
  }

  async start(): Promise<void> {
    await sodiumReady();
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnect);
    clearInterval(this.#ping);
    for (const workspaceId of this.#runners.keys()) this.#drop(workspaceId);
    this.#socket?.close();
    this.#socket = undefined;
  }

  /** Whether the relay connection is open right now. */
  get connected(): boolean {
    return this.#connected;
  }

  /** Whether the runner's secure channel is up. */
  linked(workspaceId: string): boolean {
    return Boolean(this.#runners.get(workspaceId)?.channel);
  }

  /** Resolves once the runner's channel is up, or false after `timeoutMs`. */
  waitForRunner(workspaceId: string, timeoutMs: number): Promise<boolean> {
    if (this.linked(workspaceId)) return Promise.resolve(true);
    const state = this.#state(workspaceId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.waiting = state.waiting.filter((waiter) => waiter !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      state.waiting.push(done);
    });
  }

  async unavailable(workspaceId: string): Promise<string | undefined> {
    if (this.linked(workspaceId)) return undefined;
    if (!this.#connected)
      return `The cloud gateway is not connected${this.#lastError ? `: ${this.#lastError}` : ""}`;
    return this.#runners.get(workspaceId)?.online
      ? "The workspace's runner is connecting"
      : "The workspace's runner is offline; wake the workspace";
  }

  request<M extends RunnerMethod>(
    workspaceId: string,
    method: M,
    params: RunnerMethods[M]["params"],
    timeoutMs = this.#o.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<RunnerMethods[M]["result"]> {
    const state = this.#runners.get(workspaceId);
    if (!state?.channel)
      return Promise.reject(
        new DaedalusError(
          "DEPENDENCY",
          "The workspace's runner is not connected",
        ),
      );
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(
          new DaedalusError(
            "DEPENDENCY",
            `The workspace's runner did not answer ${method}`,
          ),
        );
      }, timeoutMs);
      state.pending.set(id, {
        resolve: (value) => resolve(value as RunnerMethods[M]["result"]),
        reject,
        timer,
      });
      this.#send(workspaceId, { t: "req", id, method, params });
    });
  }

  openTerminal(
    workspaceId: string,
    session: string,
    size: { cols: number; rows: number },
    events: RunnerTerminalEvents,
  ): RunnerTerminalChannel {
    const state = this.#runners.get(workspaceId);
    const ch = this.#nextChannel++;
    let open = Boolean(state?.channel);
    if (state && open) {
      state.terminals.set(ch, events);
      this.#send(workspaceId, {
        t: "term.open",
        ch,
        session,
        cols: size.cols,
        rows: size.rows,
      });
    } else queueMicrotask(() => events.closed());
    return {
      input: (data) => {
        if (open)
          this.#send(workspaceId, {
            t: "term.client",
            ch,
            message: { type: "input", data },
          });
      },
      resize: (cols, rows) => {
        if (open)
          this.#send(workspaceId, {
            t: "term.client",
            ch,
            message: { type: "resize", cols, rows },
          });
      },
      close: () => {
        if (!open) return;
        open = false;
        this.#send(workspaceId, { t: "term.close", ch });
        if (state?.terminals.delete(ch)) events.closed();
      },
    };
  }

  // --- the relay connection ---------------------------------------------

  #connect(): void {
    const url = new URL("/v1/connect", gatewayOrigin(this.#o.gatewayUrl));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("macId", this.#o.identity.id);
    const socket = (this.#o.connect ?? connectWebSocket)(
      url.toString(),
      this.#o.token,
      {
        open: () => {
          if (this.#socket !== socket) return;
          this.#connected = true;
          this.#lastError = undefined;
          this.#retryDelay = this.#o.backoff?.initialMs ?? 1000;
          clearInterval(this.#ping);
          this.#ping = setInterval(() => socket.send("ping"), PING_MS);
          this.#o.log?.("cloud_link_connected");
        },
        text: (text) => this.#notice(text),
        binary: (data) => this.#frame(data),
        close: (code, reason) => {
          if (this.#socket !== socket) return;
          this.#socket = undefined;
          this.#connected = false;
          if (reason) this.#lastError = reason;
          clearInterval(this.#ping);
          for (const workspaceId of this.#runners.keys())
            this.#drop(workspaceId, true);
          this.#o.log?.("cloud_link_closed", { code, reason });
          if (!this.#stopped) this.#scheduleReconnect();
        },
      },
    );
    this.#socket = socket;
  }

  #scheduleReconnect(): void {
    const max = this.#o.backoff?.maxMs ?? 30_000;
    const delay = Math.min(max, this.#retryDelay) * (0.75 + Math.random() / 2);
    this.#retryDelay = Math.min(max, this.#retryDelay * 2);
    this.#reconnect = setTimeout(() => this.#connect(), delay);
  }

  #notice(text: string): void {
    if (text === "pong") return;
    let notice: RelayNotice;
    try {
      notice = JSON.parse(text) as RelayNotice;
    } catch {
      return;
    }
    if (notice.relay !== "peer") return;
    const workspaceId = workspaceOf(notice.deviceId);
    if (!workspaceId) return;
    const state = this.#state(workspaceId);
    state.online = notice.online;
    // A runner that comes or goes starts over; it sends a new hello.
    this.#drop(workspaceId);
  }

  #state(workspaceId: string): RunnerState {
    let state = this.#runners.get(workspaceId);
    if (!state) {
      state = {
        online: false,
        queue: Promise.resolve(),
        pending: new Map(),
        terminals: new Map(),
        waiting: [],
      };
      this.#runners.set(workspaceId, state);
    }
    return state;
  }

  /** Ends a runner's channel and everything riding on it. */
  #drop(workspaceId: string, offline = false): void {
    const state = this.#runners.get(workspaceId);
    if (!state) return;
    if (offline) state.online = false;
    const wasLinked = Boolean(state.channel);
    delete state.handshake;
    delete state.channel;
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new DaedalusError("DEPENDENCY", "The workspace's runner went away"),
      );
    }
    state.pending.clear();
    const terminals = [...state.terminals.values()];
    state.terminals.clear();
    for (const terminal of terminals) terminal.closed();
    if (wasLinked) this.#o.onRunner?.(workspaceId, false);
  }

  #frame(frame: Uint8Array): void {
    let deviceId: string;
    let payload: Uint8Array;
    try {
      ({ deviceId, payload } = decodeRelayFrame(frame));
    } catch {
      return;
    }
    const workspaceId = workspaceOf(deviceId);
    if (!workspaceId) return;
    const state = this.#state(workspaceId);
    // Copied: the frame's buffer may be reused once this returns.
    const copy = payload.slice();
    state.queue = state.queue
      .then(() => this.#payload(workspaceId, state, copy))
      .catch((error: unknown) => {
        this.#o.log?.("cloud_runner_frame_rejected", {
          workspaceId,
          message: error instanceof Error ? error.message : String(error),
        });
        this.#drop(workspaceId);
      });
  }

  async #payload(
    workspaceId: string,
    state: RunnerState,
    payload: Uint8Array,
  ): Promise<void> {
    const decoded = decodePayload(payload);
    if (decoded.kind === "plain") {
      const message = decoded.message;
      // A new handshake runs beside a live channel, which goes only once the
      // new one is proven: a hello alone, which anyone on the path could
      // replay, must not end the session's terminals. A failed handshake
      // costs only itself.
      try {
        if (message.type === "hello") {
          const key = await this.#o.runnerKey(workspaceId);
          if (!key) throw new Error("No runner key to accept this runner with");
          const handshake = acceptHandshake(
            this.#o.identity,
            key,
            message as Hello,
          );
          state.handshake = handshake;
          this.#sendRaw(workspaceId, encodePlain(handshake.welcome));
          return;
        }
        if (message.type !== "ready") return;
        if (!state.handshake) throw new Error("Ready without a handshake");
        const channel = state.handshake.finish(message as Ready);
        this.#drop(workspaceId);
        state.channel = channel;
      } catch (error) {
        delete state.handshake;
        this.#o.log?.("cloud_runner_handshake_failed", {
          workspaceId,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      state.online = true;
      this.#o.log?.("cloud_runner_linked", { workspaceId });
      this.#o.onRunner?.(workspaceId, true);
      for (const waiter of state.waiting.splice(0)) waiter();
      return;
    }
    if (!state.channel) throw new Error("Sealed frame before the handshake");
    const plaintext = decodeSecurePlaintext(
      state.channel.open(decoded.ciphertext),
    );
    if (plaintext.kind === "output") {
      state.terminals.get(plaintext.ch)?.output(plaintext.data);
      return;
    }
    this.#message(
      workspaceId,
      state,
      plaintext.message as unknown as RunnerSecureMessage,
    );
  }

  #message(
    workspaceId: string,
    state: RunnerState,
    message: RunnerSecureMessage,
  ): void {
    switch (message.t) {
      case "res":
      case "err": {
        const pending = state.pending.get(message.id);
        if (!pending) return;
        state.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.t === "res") pending.resolve(message.result);
        else
          pending.reject(
            new DaedalusError(
              message.code === "NOT_FOUND" ? "NOT_FOUND" : "INTERNAL",
              `The runner refused: ${message.message}`,
            ),
          );
        return;
      }
      case "req":
        void this.#serve(workspaceId, message);
        return;
      case "session.exited":
        this.#o.onSessionExited?.(
          workspaceId,
          message.session,
          message.exitCode,
        );
        return;
      case "workspace.sleeping":
        this.#o.onWorkspaceSleeping?.(workspaceId);
        return;
      case "term.server": {
        const terminal = state.terminals.get(message.ch);
        if (!terminal) return;
        terminal.server(message.message);
        const { message: server } = message;
        if (
          server.type === "error" ||
          (server.type === "status" &&
            (server.status === "exited" || server.status === "lost"))
        ) {
          state.terminals.delete(message.ch);
          terminal.closed();
        }
        return;
      }
      default:
        return;
    }
  }

  async #serve(
    workspaceId: string,
    message: Extract<RunnerSecureMessage, { t: "req" }>,
  ): Promise<void> {
    if (message.method !== "daedal.call") {
      this.#send(workspaceId, {
        t: "err",
        id: message.id,
        code: "UNKNOWN_METHOD",
        message: String(message.method),
      });
      return;
    }
    try {
      const result = await this.#o.answer(
        `ws:${workspaceId}`,
        message.params as DaedalCall,
      );
      this.#send(workspaceId, { t: "res", id: message.id, result });
    } catch (error) {
      this.#send(workspaceId, {
        t: "err",
        id: message.id,
        code: "FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #send(workspaceId: string, message: RunnerSecureMessage): void {
    const channel = this.#runners.get(workspaceId)?.channel;
    if (!channel) return;
    this.#sendRaw(
      workspaceId,
      encodeSealed(channel.seal(encodeRunnerMessage(message))),
    );
  }

  #sendRaw(workspaceId: string, payload: Uint8Array): void {
    this.#socket?.send(encodeRelayFrame(`ws:${workspaceId}`, payload));
  }
}

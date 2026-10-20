import {
  decodePayload,
  decodeRelayFrame,
  decodeSecurePlaintext,
  encodePlain,
  encodeRelayFrame,
  encodeRunnerMessage,
  encodeSealed,
  encodeTerminalOutput,
  startHandshake,
  type CommandResult,
  type DaedalCall,
  type DeviceIdentity,
  type RelayNotice,
  type RunnerSecureMessage,
  type SecureChannel,
  type Welcome,
} from "@daedalus/remote-protocol";
import type { SessionBackend, Terminal } from "./backend";
import { RunnerError } from "./errors";
import { IdleTracker } from "./idle";
import type { EventQueue } from "./queue";
import {
  MAC_FACING_METHODS,
  type SessiondMethod,
  type SessiondMethods,
} from "./sessiond-protocol";

export const OFFLINE_EXIT_CODE = 75;
export const OFFLINE_MESSAGE = "Daedalus on the Mac is offline";

export interface RelaySocket {
  send(data: Uint8Array): void;
  close(): void;
}

export interface RelayCallbacks {
  open(): void;
  text(text: string): void;
  binary(data: Uint8Array): void;
  close(): void;
}

export type ConnectRelay = (
  url: string,
  token: string,
  callbacks: RelayCallbacks,
) => RelaySocket;

export type { SessionBackend, Terminal } from "./backend";

export interface RunnerOptions {
  gatewayUrl: string;
  /** Read on every connect and every sleep request: the token rotates on wake. */
  readToken: () => string;
  workspaceId: string;
  macId: string;
  macKey: string;
  identity: DeviceIdentity;
  backend: SessionBackend;
  queue: EventQueue;
  connect: ConnectRelay;
  idleMinutes: number;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  backoff?: { initialMs: number; maxMs: number };
  handshakeRetryMs?: number;
}

class LinkLost extends Error {
  constructor() {
    super("The Mac went away");
  }
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

const EMPTY_OK: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
const SLEEP_RETRY_MS = 5 * 60_000;
const MAX_HANDSHAKE_TRIES = 5;

export class Runner {
  readonly #o: RunnerOptions;
  readonly #macDevice: string;
  #socket: RelaySocket | undefined;
  #stopped = false;
  #retryDelay: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #macOnline = false;
  #handshake:
    { finish: ReturnType<typeof startHandshake>["finish"] } | undefined;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #channel: SecureChannel | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #terminals = new Map<number, Terminal>();
  readonly #known = new Set<string>();
  readonly #keep = new Set<string>();
  readonly #reported = new Set<string>();
  readonly #exited: { session: string; exitCode: number | null }[] = [];
  #draining = false;
  readonly #idle: IdleTracker;
  #sleepAskedAt: number | undefined;

  constructor(options: RunnerOptions) {
    this.#o = options;
    this.#macDevice = `mac:${options.macId}`;
    this.#retryDelay = options.backoff?.initialMs ?? 1000;
    this.#idle = new IdleTracker(options.idleMinutes * 60_000);
  }

  get linked(): boolean {
    return this.#channel !== undefined;
  }

  #log(message: string): void {
    this.#o.log?.(message);
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#dropLink();
    this.#socket?.close();
  }

  // --- relay connection -------------------------------------------------

  #connect(): void {
    const url = new URL("/v1/connect", this.#o.gatewayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("runnerKey", this.#o.identity.publicKey);
    let token: string;
    try {
      token = this.#o.readToken();
    } catch (error) {
      this.#log(`cannot read the runner token: ${(error as Error).message}`);
      this.#scheduleReconnect();
      return;
    }
    const socket = this.#o.connect(url.toString(), token, {
      open: () => {
        this.#log("connected to the gateway");
        this.#retryDelay = this.#o.backoff?.initialMs ?? 1000;
      },
      text: (text) => this.#onNotice(text),
      binary: (data) => this.#onFrame(data),
      close: () => {
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        this.#macOnline = false;
        this.#dropLink();
        this.#scheduleReconnect();
      },
    });
    this.#socket = socket;
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const max = this.#o.backoff?.maxMs ?? 30_000;
    const delay = Math.min(max, this.#retryDelay) * (0.75 + Math.random() / 2);
    this.#retryDelay = Math.min(max, this.#retryDelay * 2);
    this.#log(`gateway connection lost; retrying in ${Math.round(delay)} ms`);
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  #onNotice(text: string): void {
    let notice: RelayNotice;
    try {
      notice = JSON.parse(text) as RelayNotice;
    } catch {
      return;
    }
    if (notice.relay === "replaced") {
      this.#log("replaced by another connection");
      return;
    }
    if (notice.relay !== "peer" || notice.deviceId !== this.#macDevice) return;
    this.#macOnline = notice.online;
    this.#dropLink();
    if (notice.online) this.#beginHandshake(1);
  }

  // --- handshake --------------------------------------------------------

  #beginHandshake(attempt: number): void {
    if (!this.#macOnline || this.#channel) return;
    const started = startHandshake(this.#o.identity, {
      macId: this.#o.macId,
      macKey: this.#o.macKey,
    });
    this.#handshake = { finish: started.finish };
    this.#sendRaw(encodePlain(started.hello));
    clearTimeout(this.#handshakeTimer);
    if (attempt < MAX_HANDSHAKE_TRIES)
      this.#handshakeTimer = setTimeout(
        () => this.#beginHandshake(attempt + 1),
        this.#o.handshakeRetryMs ?? 5000,
      );
  }

  #sendRaw(payload: Uint8Array): void {
    this.#socket?.send(encodeRelayFrame(this.#macDevice, payload));
  }

  #onFrame(frame: Uint8Array): void {
    try {
      const { deviceId, payload } = decodeRelayFrame(frame);
      if (deviceId !== this.#macDevice) return;
      const decoded = decodePayload(payload);
      if (decoded.kind === "plain") {
        if (decoded.message.type !== "welcome" || !this.#handshake) return;
        const { channel, ready } = this.#handshake.finish(
          decoded.message as Welcome,
        );
        this.#handshake = undefined;
        clearTimeout(this.#handshakeTimer);
        this.#sendRaw(encodePlain(ready));
        this.#channel = channel;
        this.#log("secure channel to the Mac is up");
        this.#onLinked();
        return;
      }
      if (!this.#channel) return;
      const plaintext = decodeSecurePlaintext(
        this.#channel.open(decoded.ciphertext),
      );
      if (plaintext.kind === "message")
        this.#onMessage(plaintext.message as unknown as RunnerSecureMessage);
    } catch (error) {
      // A frame that fails authentication or parsing ends the channel; the
      // Mac starts a new handshake when it sees the runner go.
      this.#log(`dropped the Mac channel: ${(error as Error).message}`);
      this.#dropLink();
    }
  }

  #dropLink(): void {
    this.#handshake = undefined;
    clearTimeout(this.#handshakeTimer);
    this.#channel = undefined;
    for (const terminal of this.#terminals.values()) terminal.close();
    this.#terminals.clear();
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(new LinkLost());
  }

  #onLinked(): void {
    for (const exit of this.#exited.splice(0))
      this.#send({ t: "session.exited", ...exit });
    void this.#drain();
  }

  // --- secure messages --------------------------------------------------

  #send(message: RunnerSecureMessage): void {
    if (!this.#channel) return;
    this.#sendRaw(
      encodeSealed(this.#channel.seal(encodeRunnerMessage(message))),
    );
  }

  #sendOutput(ch: number, data: Uint8Array): void {
    if (!this.#channel) return;
    this.#sendRaw(
      encodeSealed(this.#channel.seal(encodeTerminalOutput(ch, data))),
    );
  }

  #onMessage(message: RunnerSecureMessage): void {
    switch (message.t) {
      case "req":
        void this.#serve(message.id, String(message.method), message.params);
        return;
      case "res": {
        const entry = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        entry?.resolve(message.result);
        return;
      }
      case "err": {
        const entry = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        entry?.reject(new RunnerError(message.code, message.message));
        return;
      }
      case "term.open":
        void this.#openTerminal(message);
        return;
      case "term.client": {
        const terminal = this.#terminals.get(message.ch);
        if (!terminal) return;
        if (message.message.type === "input")
          terminal.write(message.message.data);
        else terminal.resize(message.message.cols, message.message.rows);
        return;
      }
      case "term.close":
        this.#terminals.get(message.ch)?.close();
        this.#terminals.delete(message.ch);
        return;
      default:
        return;
    }
  }

  async #serve(id: number, method: string, params: unknown): Promise<void> {
    if (!MAC_FACING_METHODS.has(method)) {
      this.#send({ t: "err", id, code: "UNKNOWN_METHOD", message: method });
      return;
    }
    try {
      const result = await this.#o.backend.call(
        method as SessiondMethod,
        params as never,
      );
      if (method === "host.start") {
        const launch = params as { session: string; keepOnExit?: boolean };
        this.watchSession(launch.session, launch.keepOnExit === true);
      }
      this.#send({ t: "res", id, result });
    } catch (error) {
      // The error is a RunnerError from `SessiondClient`, whose code and
      // message are already checked. Params, which can hold secrets, are
      // never part of it.
      this.#send({
        t: "err",
        id,
        code: error instanceof RunnerError ? error.code : "FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #request<T>(method: "daedal.call", params: unknown): Promise<T> {
    if (!this.#channel) return Promise.reject(new LinkLost());
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.#send({ t: "req", id, method, params });
    });
  }

  async #openTerminal(message: {
    ch: number;
    session: string;
    cols: number;
    rows: number;
  }): Promise<void> {
    const { ch, session } = message;
    try {
      const terminal = await this.#o.backend.openTerminal(
        session,
        { cols: message.cols, rows: message.rows },
        (data) => this.#sendOutput(ch, data),
      );
      if (!this.#channel) {
        terminal.close();
        return;
      }
      this.#terminals.set(ch, terminal);
      this.#send({
        t: "term.server",
        ch,
        message: { type: "status", status: "live", agentId: session },
      });
      void terminal.start().then(() => {
        if (this.#terminals.get(ch) !== terminal) return;
        this.#terminals.delete(ch);
        this.#send({
          t: "term.server",
          ch,
          message: { type: "status", status: "exited", agentId: session },
        });
      });
    } catch (error) {
      this.#send({
        t: "term.server",
        ch,
        message:
          error instanceof RunnerError && error.code === "LOST"
            ? { type: "status", status: "lost", agentId: session }
            : { type: "error", message: (error as Error).message },
      });
    }
  }

  // --- daedal calls and the event queue ---------------------------------

  /**
   * A `daedal` call from a session. Queueable calls (hook events) survive
   * the Mac being offline; any other call fails with exit code 75.
   */
  async daedalCall(call: DaedalCall): Promise<CommandResult> {
    if (this.#channel && (!call.queueable || this.#o.queue.length === 0)) {
      try {
        return await this.#request<CommandResult>("daedal.call", call);
      } catch (error) {
        if (!(error instanceof LinkLost)) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `${error instanceof Error ? error.message : error}\n`,
          };
        }
      }
    }
    if (call.queueable) {
      this.#o.queue.push(call);
      void this.#drain();
      return EMPTY_OK;
    }
    return {
      exitCode: OFFLINE_EXIT_CODE,
      stdout: "",
      stderr: `${OFFLINE_MESSAGE}\n`,
    };
  }

  /** Sends queued events to the Mac oldest first, one at a time. */
  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (let head = this.#o.queue.peek(); head; head = this.#o.queue.peek()) {
        if (!this.#channel) return;
        try {
          await this.#request<CommandResult>("daedal.call", head);
        } catch (error) {
          if (error instanceof LinkLost) return;
          // The Mac answered with an error. Retrying would fail the same way
          // and block every event behind this one.
          this.#log(
            `dropping queued event ${head.callId}: ${(error as Error).message}`,
          );
        }
        this.#o.queue.remove(head.callId);
      }
    } finally {
      this.#draining = false;
    }
  }

  // --- session watching and idle sleep ----------------------------------

  watchSession(session: string, keepOnExit = false): void {
    this.#known.add(session);
    if (keepOnExit) this.#keep.add(session);
    this.#reported.delete(session);
  }

  #reportExit(session: string, exitCode: number | null): void {
    const exit = { session, exitCode };
    if (this.#channel) this.#send({ t: "session.exited", ...exit });
    else this.#exited.push(exit);
  }

  /** One pass of session bookkeeping; the daemon calls it on a timer. */
  async tick(): Promise<void> {
    let live: string[];
    let dead: Map<string, number | null>;
    try {
      live = await this.#o.backend.call("host.listLive", null);
      dead = new Map(
        Object.entries(await this.#o.backend.call("deadPanes", null)),
      );
      live = Array.isArray(live)
        ? live.filter((name) => typeof name === "string")
        : [];
      dead = new Map(
        [...dead].filter(
          ([, status]) => status === null || typeof status === "number",
        ),
      );
    } catch {
      // The session container did not answer. That says nothing about the
      // sessions.
      return;
    }
    const liveSet = new Set(live);
    for (const session of live) this.#known.add(session);
    // Every session runs with remain-on-exit, so an ended command leaves a
    // dead pane that still holds its exit status.
    for (const [session, exitCode] of dead) {
      if (this.#reported.has(session)) continue;
      this.#reported.add(session);
      this.#reportExit(session, exitCode);
      if (!this.#keep.has(session)) {
        this.#known.delete(session);
        await this.#o.backend
          .call("host.stop", { session, force: true })
          .catch(() => {});
      }
    }
    for (const session of [...this.#known]) {
      if (liveSet.has(session)) continue;
      this.#known.delete(session);
      this.#keep.delete(session);
      // Removed from outside (a stop request): no status to report.
      if (!this.#reported.delete(session)) this.#reportExit(session, null);
    }
    for (const session of [...this.#reported])
      if (!liveSet.has(session)) this.#reported.delete(session);
    const running = live.filter((session) => !dead.has(session));
    const active = running.length > 0 || this.#terminals.size > 0;
    const now = this.#now();
    if (!this.#idle.observe(active, now)) return;
    if (
      this.#sleepAskedAt !== undefined &&
      now - this.#sleepAskedAt < SLEEP_RETRY_MS
    )
      return;
    this.#sleepAskedAt = now;
    await this.#askToSleep();
  }

  async #askToSleep(): Promise<void> {
    const url = new URL(
      `/v1/workspaces/${this.#o.workspaceId}/sleep`,
      this.#o.gatewayUrl,
    );
    try {
      const response = await (this.#o.fetch ?? fetch)(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#o.readToken()}` },
      });
      this.#log(
        `asked the gateway to sleep this workspace: ${response.status}`,
      );
    } catch (error) {
      this.#log(`sleep request failed: ${(error as Error).message}`);
    }
  }
}

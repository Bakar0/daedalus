import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ApplicationContext,
  DaedalusError,
  type PhoneAlert,
  saveRemoteEnabled,
  saveRemoteKeepAwake,
  saveRemoteMacName,
} from "@daedalus/core";
import { runCommand, TmuxPtyBridge } from "@daedalus/platform";
import type {
  RemotePairingDto,
  RemoteStateDto,
  RpcResult,
  TerminalClientMessage,
  TerminalServerMessage,
} from "@daedalus/protocol";
import {
  acceptHandshake,
  createIdentity,
  createPairingOffer,
  decodePayload,
  decodeRelayFrame,
  decodeSecurePlaintext,
  type DeviceIdentity,
  emptyWireStats,
  encodePlain,
  encodeRelayFrame,
  encodeSealed,
  encodeSecureMessage,
  encodeTerminalOutput,
  type Hello,
  type PairingOffer,
  pairingUrl,
  type PlainMessage,
  type Ready,
  RELAY_CLOSE,
  relayConnectUrl,
  relayHttpUrl,
  relayProtocols,
  type RelayNotice,
  type SecureChannel,
  type SecureMessage,
  sodiumReady,
  verifyPairingProof,
  type Welcome,
  type WireStats,
} from "@daedalus/remote-protocol";
import { isTyping, TerminalConnection, type TerminalSocket } from "./terminal";

/**
 * The requests a paired phone may make. Everything else (deletes, settings,
 * accounts, secrets, files, the clipboard) stays desktop-only. A phone that
 * can type into a session can already run anything there; the list keeps
 * the rest of the Mac out of reach of a stolen phone or a broken page.
 */
export const REMOTE_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "snapshot",
  "workspaceGet",
  "taskGet",
  "taskTimeline",
  "taskCreate",
  "taskUpdate",
  "taskSetStatus",
  "agentGet",
  "agentModels",
  "agentSpawn",
  "agentSend",
  "agentStop",
  "agentArchive",
  "agentRestore",
  "agentRevive",
  "attentionClear",
]);

export interface PairedPhone {
  id: string;
  publicKey: string;
  name: string;
  pairedAt: string;
}

interface RemoteFile {
  identity: DeviceIdentity;
  phones: PairedPhone[];
  /** Given by the relay when a phone claims this Mac for its account. */
  relayToken?: string;
}

/**
 * The Mac's device key, its relay token and its paired phones, in
 * `<home>/remote/device.json` readable only by the user. The secret key and
 * the token belong in the Keychain before this ships.
 */
export class RemoteStore {
  private constructor(
    private readonly path: string,
    private data: RemoteFile,
  ) {}

  static async open(home: string): Promise<RemoteStore> {
    await sodiumReady();
    const directory = join(home, "remote");
    const path = join(directory, "device.json");
    const file = Bun.file(path);
    if (await file.exists())
      return new RemoteStore(path, (await file.json()) as RemoteFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new RemoteStore(path, {
      identity: createIdentity(),
      phones: [],
    });
    await store.save();
    return store;
  }

  get identity(): DeviceIdentity {
    return this.data.identity;
  }

  get phones(): readonly PairedPhone[] {
    return this.data.phones;
  }

  get relayToken(): string | undefined {
    return this.data.relayToken;
  }

  /** Updates memory at once, so a reconnect right after sees the token. */
  setRelayToken(token: string): Promise<void> {
    this.data.relayToken = token;
    return this.save();
  }

  /**
   * Starts over as a new device: the account removed this Mac, so its id,
   * keys and phones are of no further use, and a fresh id can be paired.
   */
  reset(): Promise<void> {
    this.data = { identity: createIdentity(), phones: [] };
    return this.save();
  }

  phone(id: string): PairedPhone | undefined {
    return this.data.phones.find((phone) => phone.id === id);
  }

  async addPhone(phone: PairedPhone): Promise<void> {
    this.data.phones = [
      ...this.data.phones.filter((existing) => existing.id !== phone.id),
      phone,
    ];
    await this.save();
  }

  async removePhone(id: string): Promise<void> {
    this.data.phones = this.data.phones.filter((phone) => phone.id !== id);
    await this.save();
  }

  private async save(): Promise<void> {
    await Bun.write(this.path, JSON.stringify(this.data, null, 2));
    await chmod(this.path, 0o600);
  }
}

export interface RemoteTerminal {
  message(payload: string): Promise<void>;
  close(): void;
}

export type OpenRemoteTerminal = (
  agentId: string,
  socket: TerminalSocket,
  size: { cols: number; rows: number } | undefined,
) => Promise<RemoteTerminal>;

/** Any of the desktop request handlers; the allowlist picks which. */
type RequestHandler = (params: never) => unknown;
type RequestHandlers = Partial<Record<string, RequestHandler>>;

export interface RemoteConnectorOptions {
  relay: string;
  macName: string;
  store: RemoteStore;
  handlers: RequestHandlers;
  openTerminal: OpenRemoteTerminal;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Sees every raw frame in both directions, as the relay does. */
  tap?: (direction: "in" | "out", frame: Uint8Array) => void;
  /** How long to wait before retrying while locked. Tests shorten it. */
  lockedRetryMs?: number;
}

/**
 * - `waiting_for_phone`: connected, not yet claimed by an account.
 * - `online`: connected as an account's Mac.
 * - `locked`: the account has no access or is over its data limit.
 */
export type RemoteStatus =
  "connecting" | "waiting_for_phone" | "online" | "offline" | "locked";

const LOCKED_RETRY_MS = 5 * 60_000;

interface PhoneState {
  handshake?: { finish(ready: Ready): SecureChannel };
  channel?: SecureChannel;
  terminals: Map<number, RemoteTerminal>;
  /**
   * Until when the phone app counts as open and in front, so it shows
   * alerts itself. The phone repeats "visible" every 20 s; one suspended
   * mid-report stops counting after 45 s.
   */
  visibleUntil?: number;
}

/**
 * The Mac's side of remote access. One outbound WebSocket to the relay
 * carries every paired phone; nothing listens on the Mac.
 */
export class RemoteConnector {
  readonly stats: WireStats = emptyWireStats();
  #macName: string;
  #socket: WebSocket | undefined;
  #stopped = false;
  #retryMs = 1_000;
  #ping: ReturnType<typeof setInterval> | undefined;
  #offer: PairingOffer | undefined;
  /** The last accepted pairing, so a repeated request is answered again. */
  #lastPairing: { offer: PairingOffer; phoneId: string } | undefined;
  #status: RemoteStatus = "connecting";
  #statusListeners = new Set<(status: RemoteStatus) => void>();
  #overQuota = false;
  #phones = new Map<string, PhoneState>();
  #connected: Promise<void>;
  #markConnected!: () => void;

  constructor(private readonly options: RemoteConnectorOptions) {
    this.#macName = options.macName;
    this.#connected = new Promise((resolve) => {
      this.#markConnected = resolve;
    });
  }

  get macId(): string {
    return this.options.store.identity.id;
  }

  get status(): RemoteStatus {
    return this.#status;
  }

  onStatus(listener: (status: RemoteStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  #setStatus(status: RemoteStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }

  /** Resolves on the first successful connection to the relay. */
  start(): Promise<void> {
    this.#connect();
    return this.#connected;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#ping) clearInterval(this.#ping);
    for (const id of [...this.#phones.keys()]) this.#dropPhone(id);
    this.#socket?.close();
  }

  /** A one-time code for the QR code. A new one replaces the last. */
  createPairingOffer(lifetimeMs?: number): PairingOffer {
    this.#offer = createPairingOffer(
      this.options.store.identity,
      this.options.relay,
      this.#macName,
      lifetimeMs,
    );
    return this.#offer;
  }

  /**
   * Asks the relay to wake this account's phones with a push that says only
   * that a session needs them. Nothing about the session leaves the Mac.
   */
  async notifyPhones(): Promise<
    "sent" | "throttled" | "none" | "skipped" | "failed"
  > {
    const token = this.options.store.relayToken;
    if (!token) return "skipped";
    try {
      const response = await fetch(
        `${relayHttpUrl(this.options.relay)}/v1/push/notify`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Daedalus-Device": this.macId,
          },
        },
      );
      const result = (await response.json()) as
        | { ok: true; data: { sent: number; throttled: boolean } }
        | { ok: false };
      if (!result.ok) return "failed";
      this.options.log?.("remote_push", { ...result.data });
      return result.data.throttled
        ? "throttled"
        : result.data.sent > 0
          ? "sent"
          : "none";
    } catch {
      return "failed";
    }
  }

  /** Phones with a finished handshake right now. */
  get connectedPhones(): number {
    return [...this.#phones.values()].filter((state) => state.channel).length;
  }

  /** Renames this Mac on every connected phone; later ones hear on connect. */
  setMacName(name: string): void {
    this.#macName = name;
    for (const [id, state] of this.#phones)
      if (state.channel) this.#sendSecure(id, { t: "mac", name });
  }

  /** Whether a connected phone has the app open on screen right now. */
  get phoneOnScreen(): boolean {
    return [...this.#phones.values()].some(
      (state) => state.channel && (state.visibleUntil ?? 0) > Date.now(),
    );
  }

  /** Ends a forgotten phone's connection; its next hello is refused. */
  forgetPhone(id: string): void {
    this.#dropPhone(id);
  }

  /** Tells every connected phone that data changed, like `dataChanged`. */
  announce(): void {
    for (const [id, state] of this.#phones)
      if (state.channel)
        this.#sendSecure(id, { t: "event", name: "dataChanged" });
  }

  #connect(): void {
    if (this.#stopped) return;
    const token = this.options.store.relayToken;
    const socket = new WebSocket(
      relayConnectUrl(this.options.relay, this.macId, "mac", this.macId),
      relayProtocols(token),
    );
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    let opened = false;
    socket.addEventListener("open", () => {
      // A refused socket opens and closes in the same moment.
      setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        opened = true;
        this.#retryMs = 1_000;
        this.#overQuota = false;
        this.options.log?.("remote_connected", {
          relay: this.options.relay,
          claimed: Boolean(token),
        });
        this.#ping = setInterval(() => socket.send("ping"), 30_000);
        this.#setStatus(token ? "online" : "waiting_for_phone");
        this.#markConnected();
      }, 50);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.#notice(event.data);
        return;
      }
      void this.#frame(new Uint8Array(event.data as ArrayBuffer));
    });
    socket.addEventListener("close", (event) => {
      if (this.#ping) clearInterval(this.#ping);
      for (const id of [...this.#phones.keys()]) this.#dropPhone(id);
      if (this.#stopped) return;
      void this.#closed(event.code, event.reason, token, opened);
    });
  }

  /** What a closed connection means, and when to try again. */
  async #closed(
    code: number,
    reason: string,
    token: string | undefined,
    opened: boolean,
  ): Promise<void> {
    this.options.log?.("remote_disconnected", { code, reason, opened });
    let delay = this.#retryMs;
    if (code === RELAY_CLOSE.claimed) {
      delay = 0;
    } else if (
      code === RELAY_CLOSE.unauthorized ||
      code === RELAY_CLOSE.forbidden
    ) {
      // The account removed this Mac (or the relay no longer knows its
      // token). Start over as a new device that can be paired again.
      await this.options.store.reset();
      this.#offer = undefined;
      this.#lastPairing = undefined;
      this.options.log?.("remote_device_reset", { code, hadToken: !!token });
      delay = 1_000;
    } else if (
      code === RELAY_CLOSE.noEntitlement ||
      code === RELAY_CLOSE.overQuota
    ) {
      this.#setStatus("locked");
      setTimeout(
        () => this.#connect(),
        this.options.lockedRetryMs ?? LOCKED_RETRY_MS,
      );
      return;
    } else {
      this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
    }
    this.#setStatus("offline");
    setTimeout(() => this.#connect(), delay);
  }

  #notice(text: string): void {
    if (text === "pong") return;
    let notice: RelayNotice;
    try {
      notice = JSON.parse(text) as RelayNotice;
    } catch {
      return;
    }
    if (notice.relay === "peer" && !notice.online)
      this.#dropPhone(notice.deviceId);
    else if (notice.relay === "claimed")
      void this.options.store.setRelayToken(notice.token);
    else if (notice.relay === "quota") {
      // Over the month's data: stop the heavy part, keep requests going.
      this.#overQuota = true;
      for (const state of this.#phones.values()) {
        for (const terminal of state.terminals.values()) terminal.close();
        state.terminals.clear();
      }
    }
  }

  #send(phoneId: string, payload: Uint8Array): void {
    const frame = encodeRelayFrame(phoneId, payload);
    this.stats.framesOut += 1;
    this.stats.bytesOut += frame.byteLength;
    this.options.tap?.("out", frame);
    this.#socket?.send(frame);
  }

  #sendPlain(phoneId: string, message: PlainMessage): void {
    this.#send(phoneId, encodePlain(message));
  }

  #sendSecureBytes(phoneId: string, plaintext: Uint8Array): void {
    const channel = this.#phones.get(phoneId)?.channel;
    if (!channel) return;
    this.#send(phoneId, encodeSealed(channel.seal(plaintext)));
  }

  #sendSecure(phoneId: string, message: SecureMessage): void {
    this.#sendSecureBytes(phoneId, encodeSecureMessage(message));
  }

  #dropPhone(phoneId: string): void {
    const state = this.#phones.get(phoneId);
    if (!state) return;
    for (const terminal of state.terminals.values()) terminal.close();
    this.#phones.delete(phoneId);
  }

  async #frame(frame: Uint8Array): Promise<void> {
    this.stats.framesIn += 1;
    this.stats.bytesIn += frame.byteLength;
    this.options.tap?.("in", frame);
    let phoneId = "";
    try {
      const decoded = decodeRelayFrame(frame);
      phoneId = decoded.deviceId;
      const payload = decodePayload(decoded.payload);
      if (payload.kind === "plain") await this.#plain(phoneId, payload.message);
      else await this.#sealed(phoneId, payload.ciphertext);
    } catch (error) {
      this.options.log?.("remote_frame_rejected", {
        phoneId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (phoneId) {
        this.#dropPhone(phoneId);
        this.#sendPlain(phoneId, {
          type: "refused",
          reason: "The secure channel broke. Reconnect.",
        });
      }
    }
  }

  async #plain(phoneId: string, message: PlainMessage): Promise<void> {
    if (message.type === "pair") {
      const phone = { id: phoneId, publicKey: message.phoneKey };
      const last = this.#lastPairing;
      if (
        last?.phoneId === phoneId &&
        this.options.store.phone(phoneId)?.publicKey === message.phoneKey &&
        verifyPairingProof(last.offer, phone, message.proof)
      ) {
        this.#sendPlain(phoneId, {
          type: "paired",
          macName: this.#macName,
        });
        return;
      }
      const offer = this.#offer;
      if (
        !offer ||
        offer.expiresAt < Date.now() ||
        message.phoneId !== phoneId ||
        !verifyPairingProof(offer, phone, message.proof)
      ) {
        this.#sendPlain(phoneId, {
          type: "refused",
          reason: "The pairing code is wrong or has expired.",
        });
        return;
      }
      this.#offer = undefined;
      this.#lastPairing = { offer, phoneId };
      await this.options.store.addPhone({
        ...phone,
        name: message.name.slice(0, 80),
        pairedAt: new Date().toISOString(),
      });
      this.options.log?.("remote_phone_paired", { phoneId });
      this.#sendPlain(phoneId, {
        type: "paired",
        macName: this.#macName,
      });
      return;
    }
    if (message.type === "hello") {
      const paired = this.options.store.phone(phoneId);
      if (!paired || (message as Hello).phoneId !== phoneId) {
        this.#sendPlain(phoneId, {
          type: "refused",
          reason: "This phone is not paired with this Mac.",
        });
        return;
      }
      this.#dropPhone(phoneId);
      const handshake = acceptHandshake(
        this.options.store.identity,
        paired.publicKey,
        message,
      );
      this.#phones.set(phoneId, {
        handshake,
        terminals: new Map(),
      });
      this.#sendPlain(phoneId, handshake.welcome satisfies Welcome);
      return;
    }
    if (message.type === "ready") {
      const state = this.#phones.get(phoneId);
      if (!state?.handshake) throw new Error("Ready without a handshake");
      state.channel = state.handshake.finish(message);
      delete state.handshake;
      this.#sendSecure(phoneId, { t: "mac", name: this.#macName });
      this.options.log?.("remote_phone_connected", { phoneId });
    }
  }

  async #sealed(phoneId: string, ciphertext: Uint8Array): Promise<void> {
    const state = this.#phones.get(phoneId);
    if (!state?.channel) throw new Error("Sealed message before handshake");
    const decoded = decodeSecurePlaintext(state.channel.open(ciphertext));
    if (decoded.kind !== "message") return;
    const message = decoded.message;
    if (message.t === "req") {
      const result = await this.#request(message.method, message.params);
      this.#sendSecure(phoneId, { t: "res", id: message.id, result });
    } else if (message.t === "term.open") {
      await this.#openTerminal(phoneId, state, message);
    } else if (message.t === "term.client") {
      await state.terminals
        .get(message.ch)
        ?.message(
          JSON.stringify(message.message satisfies TerminalClientMessage),
        );
    } else if (message.t === "term.close") {
      state.terminals.get(message.ch)?.close();
      state.terminals.delete(message.ch);
    } else if (message.t === "presence") {
      state.visibleUntil = message.visible ? Date.now() + 45_000 : 0;
    }
  }

  async #request(method: string, params: unknown): Promise<RpcResult<unknown>> {
    const handler = this.options.handlers[method];
    if (!REMOTE_ALLOWED_METHODS.has(method) || !handler)
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `${method} is not available from a phone.`,
          details: { remote: "forbidden", method },
        },
      };
    try {
      return (await handler(params as never)) as RpcResult<unknown>;
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async #openTerminal(
    phoneId: string,
    state: PhoneState,
    message: Extract<SecureMessage, { t: "term.open" }>,
  ): Promise<void> {
    const { ch } = message;
    if (this.#overQuota) {
      this.#sendSecure(phoneId, {
        t: "term.server",
        ch,
        message: {
          type: "error",
          message: "This account reached its monthly data limit.",
        },
      });
      this.#sendSecure(phoneId, { t: "term.close", ch });
      return;
    }
    const socket: TerminalSocket = {
      send: (data) => {
        if (typeof data === "string")
          this.#sendSecure(phoneId, {
            t: "term.server",
            ch,
            message: JSON.parse(data) as TerminalServerMessage,
          });
        else this.#sendSecureBytes(phoneId, encodeTerminalOutput(ch, data));
      },
      getBufferedAmount: () => this.#socket?.bufferedAmount ?? 0,
      close: () => {
        state.terminals.delete(ch);
        this.#sendSecure(phoneId, { t: "term.close", ch });
      },
    };
    const size =
      message.cols !== undefined && message.rows !== undefined
        ? { cols: message.cols, rows: message.rows }
        : undefined;
    try {
      state.terminals.set(
        ch,
        await this.options.openTerminal(message.agentId, socket, size),
      );
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        } satisfies TerminalServerMessage),
      );
      socket.close?.();
    }
  }
}

/**
 * A phone and the Mac show one tmux window, which can have one size, and by
 * default tmux gives it to whichever client was used last. A phone-sized
 * window then shows up narrower on the Mac, and a Mac-sized one leaves the
 * phone's extra rows and columns dotted. While a phone has the session open
 * the window is pinned to the phone's size (`window-size manual`); when the
 * last phone leaves, the pin is removed and tmux sizes it from the Mac again.
 */
export class PhoneWindowSize {
  readonly #open = new Map<string, number>();
  /** The phone's last size per session, to take the window back with. */
  readonly #sizes = new Map<string, { cols: number; rows: number }>();
  /** Sessions the Mac took back by typing in them. */
  readonly #yielded = new Set<string>();

  constructor(
    private readonly tmux: { socketName: string; executable: string },
    private readonly run: typeof runCommand = runCommand,
  ) {}

  async #tmux(args: string[]): Promise<void> {
    await this.run(this.tmux.executable, ["-L", this.tmux.socketName, ...args]);
  }

  async hold(session: string, size: { cols: number; rows: number }) {
    this.#open.set(session, (this.#open.get(session) ?? 0) + 1);
    await this.resize(session, size);
  }

  async resize(
    session: string,
    { cols, rows }: { cols: number; rows: number },
  ) {
    this.#sizes.set(session, { cols, rows });
    this.#yielded.delete(session);
    const width = Math.max(20, Math.min(500, Math.floor(cols)));
    const height = Math.max(5, Math.min(300, Math.floor(rows)));
    await this.#tmux([
      "set-option",
      "-w",
      "-t",
      session,
      "window-size",
      "manual",
      ";",
      "resize-window",
      "-t",
      session,
      "-x",
      String(width),
      "-y",
      String(height),
    ]);
  }

  /**
   * Typing on the Mac means the user is back there: the window returns to
   * the Mac's size while the phone stays attached. Typing on the phone takes
   * it again (`reclaim`).
   */
  async yieldToMac(session: string) {
    if (!this.#open.has(session) || this.#yielded.has(session)) return;
    this.#yielded.add(session);
    await this.#tmux(["set-option", "-w", "-u", "-t", session, "window-size"]);
  }

  async reclaim(session: string) {
    const size = this.#sizes.get(session);
    if (this.#yielded.has(session) && size) await this.resize(session, size);
  }

  async release(session: string) {
    const count = (this.#open.get(session) ?? 1) - 1;
    if (count > 0) {
      this.#open.set(session, count);
      return;
    }
    this.#open.delete(session);
    this.#sizes.delete(session);
    this.#yielded.delete(session);
    await this.#tmux(["set-option", "-w", "-u", "-t", session, "window-size"]);
  }
}

/**
 * Opens an agent's tmux session for a phone the way the loopback terminal
 * server does for the window: a running session only, typing noted for the
 * delivery gate, and the window sized to the phone while it is open.
 */
export function agentTerminalOpener(
  context: ApplicationContext,
  tmux: { socketName: string; executable: string },
  sizes = new PhoneWindowSize(tmux),
): OpenRemoteTerminal {
  return async (agentId, socket, size) => {
    const agent = await context.agents.get(agentId);
    if (agent.status !== "running" && agent.status !== "starting")
      throw new Error(`Session is ${agent.status}`);
    const session = agent.tmuxSession;
    const initial = size ?? { cols: 80, rows: 24 };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void sizes.release(session).catch(() => undefined);
    };
    await sizes.hold(session, initial);
    const connection = new TerminalConnection({
      agentId: agent.id,
      socket: {
        ...socket,
        send: (data) => socket.send(data),
        close: () => {
          release();
          socket.close?.();
        },
      },
      status: "reconnected",
      createBridge: (onOutput) =>
        new TmuxPtyBridge(
          onOutput,
          { socketName: tmux.socketName, session },
          initial,
          tmux.executable,
        ),
      onInput: (data) => {
        if (isTyping(data)) context.deliveryGate.noteKeystroke(agent.id);
      },
    });
    await connection.start();
    return {
      async message(payload) {
        await connection.message(payload);
        try {
          const parsed = JSON.parse(payload) as TerminalClientMessage;
          if (parsed.type === "resize")
            await sizes.resize(session, {
              cols: parsed.cols,
              rows: parsed.rows,
            });
          else if (parsed.type === "input" && isTyping(parsed.data))
            await sizes.reclaim(session);
        } catch {
          // Not JSON; the connection already reported it.
        }
      },
      close() {
        connection.close();
        release();
      },
    };
  };
}

/** What the RPC layer needs of the remote host. */
export interface DesktopRemoteHost {
  state(): RemoteStateDto;
  setEnabled(enabled: boolean): Promise<RemoteStateDto>;
  setKeepAwake(enabled: boolean): Promise<RemoteStateDto>;
  setMacName(name: string): Promise<RemoteStateDto>;
  pairingCode(): RemotePairingDto;
  removePhone(id: string): Promise<RemoteStateDto>;
}

export interface RemoteHostOptions {
  context: ApplicationContext;
  macName: string;
  handlers: () => RequestHandlers;
  openTerminal: OpenRemoteTerminal;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Keeps a connector running while Settings › Remote is on, and none while
 * it is off. The store is opened on first use, so a user who never turns
 * remote access on never gets a device key.
 */
export class RemoteHost implements DesktopRemoteHost {
  #store: RemoteStore | undefined;
  #connector: RemoteConnector | undefined;
  #awake: Bun.Subprocess | undefined;

  constructor(private readonly options: RemoteHostOptions) {}

  /** Starts the connector if the setting is on. Call once at launch. */
  async start(): Promise<void> {
    if (this.options.context.config.remoteEnabled) await this.#run();
    this.#keepAwake();
  }

  /**
   * `caffeinate -i` while phone access and Keep awake are both on: no idle
   * sleep, so a session can still reach the phone with nobody at the Mac.
   * The display still sleeps, and a closed lid still sleeps a laptop. `-w`
   * ends it with this process, so a crash cannot leave the Mac awake.
   */
  #keepAwake(): void {
    const { config } = this.options.context;
    const wanted = config.remoteEnabled && config.remoteKeepAwake;
    if (wanted && !this.#awake) {
      this.#awake = Bun.spawn(
        ["/usr/bin/caffeinate", "-i", "-w", String(process.pid)],
        { stdout: "ignore", stderr: "ignore" },
      );
      this.options.log?.("remote_keep_awake", { on: true });
    } else if (!wanted && this.#awake) {
      this.#awake.kill();
      this.#awake = undefined;
      this.options.log?.("remote_keep_awake", { on: false });
    }
  }

  /** Whether the Mac is being kept awake right now. */
  get keepingAwake(): boolean {
    return Boolean(this.#awake);
  }

  /** What phones call this Mac: the chosen name, else the computer's. */
  get macName(): string {
    return (
      this.options.context.config.remoteMacName.trim() || this.options.macName
    );
  }

  async setMacName(name: string): Promise<RemoteStateDto> {
    await saveRemoteMacName(
      this.options.context.config,
      name.trim().slice(0, 60),
    );
    this.#connector?.setMacName(this.macName);
    return this.state();
  }

  async setKeepAwake(enabled: boolean): Promise<RemoteStateDto> {
    await saveRemoteKeepAwake(this.options.context.config, enabled);
    this.#keepAwake();
    return this.state();
  }

  async #run(): Promise<void> {
    if (this.#connector) return;
    this.#store ??= await RemoteStore.open(this.options.context.config.home);
    this.#connector = new RemoteConnector({
      relay: this.options.context.config.remoteRelay,
      macName: this.macName,
      store: this.#store,
      handlers: this.options.handlers(),
      openTerminal: this.options.openTerminal,
      ...(this.options.log ? { log: this.options.log } : {}),
    });
    void this.#connector.start();
    this.options.context.notifications.setPhone((alert) =>
      this.takeAlert(alert),
    );
  }

  /**
   * The notification service hands over a blocking alert when nobody has
   * been at this Mac for five minutes. True means a phone has it, and the
   * Mac shows no macOS notification of its own: a phone with the app open
   * shows it there, otherwise a push says a session needs the user. With
   * no phone to reach, the Mac notifies as it always did.
   */
  async takeAlert(_alert: Parameters<PhoneAlert>[0]): Promise<boolean> {
    const connector = this.#connector;
    if (!connector || connector.status !== "online") return false;
    if (connector.phoneOnScreen) return true;
    const pushed = await connector.notifyPhones();
    return pushed === "sent" || pushed === "throttled";
  }

  stop(): void {
    this.#awake?.kill();
    this.#awake = undefined;
    this.options.context.notifications.setPhone(undefined);
    this.#connector?.stop();
    this.#connector = undefined;
  }

  announce(): void {
    this.#connector?.announce();
  }

  state(): RemoteStateDto {
    const { config } = this.options.context;
    return {
      enabled: config.remoteEnabled,
      keepAwake: config.remoteKeepAwake,
      status: this.#connector?.status ?? "off",
      relay: config.remoteRelay,
      macName: this.macName,
      connectedPhones: this.#connector?.connectedPhones ?? 0,
      phones: (this.#store?.phones ?? []).map(({ id, name, pairedAt }) => ({
        id,
        name,
        pairedAt,
      })),
    };
  }

  async setEnabled(enabled: boolean): Promise<RemoteStateDto> {
    await saveRemoteEnabled(this.options.context.config, enabled);
    if (enabled) await this.#run();
    else this.stop();
    this.#keepAwake();
    return this.state();
  }

  pairingCode(): RemotePairingDto {
    const connector = this.#connector;
    if (
      !connector ||
      (connector.status !== "waiting_for_phone" &&
        connector.status !== "online")
    )
      throw new DaedalusError(
        "CONFLICT",
        "Pairing needs this Mac connected to the relay.",
      );
    const offer = connector.createPairingOffer();
    return { url: pairingUrl(offer), expiresAt: offer.expiresAt };
  }

  async removePhone(id: string): Promise<RemoteStateDto> {
    await this.#store?.removePhone(id);
    this.#connector?.forgetPhone(id);
    return this.state();
  }
}

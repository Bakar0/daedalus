import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ApplicationContext } from "@daedalus/core";
import { TmuxPtyBridge } from "@daedalus/platform";
import type {
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
  type PlainMessage,
  type Ready,
  relayConnectUrl,
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
}

/**
 * The Mac's device key and its paired phones, in `<home>/remote/device.json`
 * readable only by the user. Phase 0 keeps the secret key in that file; the
 * Keychain is the place for it before this ships.
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

type RequestHandler = (params: never) => unknown;

export interface RemoteConnectorOptions {
  relay: string;
  macName: string;
  store: RemoteStore;
  handlers: Record<string, RequestHandler>;
  openTerminal: OpenRemoteTerminal;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Sees every raw frame in both directions, as the relay does. */
  tap?: (direction: "in" | "out", frame: Uint8Array) => void;
}

interface PhoneState {
  handshake?: { finish(ready: Ready): SecureChannel };
  channel?: SecureChannel;
  terminals: Map<number, RemoteTerminal>;
}

/**
 * The Mac's side of remote access. One outbound WebSocket to the relay
 * carries every paired phone; nothing listens on the Mac.
 */
export class RemoteConnector {
  readonly stats: WireStats = emptyWireStats();
  #socket: WebSocket | undefined;
  #stopped = false;
  #retryMs = 1_000;
  #ping: ReturnType<typeof setInterval> | undefined;
  #offer: PairingOffer | undefined;
  #phones = new Map<string, PhoneState>();
  #connected: Promise<void>;
  #markConnected!: () => void;

  constructor(private readonly options: RemoteConnectorOptions) {
    this.#connected = new Promise((resolve) => {
      this.#markConnected = resolve;
    });
  }

  get macId(): string {
    return this.options.store.identity.id;
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
      lifetimeMs,
    );
    return this.#offer;
  }

  /** Tells every connected phone that data changed, like `dataChanged`. */
  announce(): void {
    for (const [id, state] of this.#phones)
      if (state.channel)
        this.#sendSecure(id, { t: "event", name: "dataChanged" });
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(
      relayConnectUrl(this.options.relay, this.macId, "mac", this.macId),
    );
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#retryMs = 1_000;
      this.options.log?.("remote_connected", { relay: this.options.relay });
      this.#ping = setInterval(() => socket.send("ping"), 30_000);
      this.#markConnected();
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.#notice(event.data);
        return;
      }
      void this.#frame(new Uint8Array(event.data as ArrayBuffer));
    });
    socket.addEventListener("close", () => {
      if (this.#ping) clearInterval(this.#ping);
      for (const id of [...this.#phones.keys()]) this.#dropPhone(id);
      if (this.#stopped) return;
      this.options.log?.("remote_disconnected", { retryMs: this.#retryMs });
      setTimeout(() => this.#connect(), this.#retryMs);
      this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
    });
  }

  #notice(text: string): void {
    if (text === "pong") return;
    try {
      const notice = JSON.parse(text) as RelayNotice;
      if (notice.relay === "peer" && !notice.online)
        this.#dropPhone(notice.deviceId);
    } catch {
      // Not a notice this version knows.
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
      const offer = this.#offer;
      const phone = { id: phoneId, publicKey: message.phoneKey };
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
      await this.options.store.addPhone({
        ...phone,
        name: message.name.slice(0, 80),
        pairedAt: new Date().toISOString(),
      });
      this.options.log?.("remote_phone_paired", { phoneId });
      this.#sendPlain(phoneId, {
        type: "paired",
        macName: this.options.macName,
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
 * Opens an agent's tmux session for a phone the way the loopback terminal
 * server does for the window: a running session only, typing noted for the
 * delivery gate.
 */
export function agentTerminalOpener(
  context: ApplicationContext,
  tmux: { socketName: string; executable: string },
): OpenRemoteTerminal {
  return async (agentId, socket, size) => {
    const agent = await context.agents.get(agentId);
    if (agent.status !== "running" && agent.status !== "starting")
      throw new Error(`Session is ${agent.status}`);
    const connection = new TerminalConnection({
      agentId: agent.id,
      socket,
      status: "reconnected",
      createBridge: (onOutput) =>
        new TmuxPtyBridge(
          onOutput,
          { socketName: tmux.socketName, session: agent.tmuxSession },
          size,
          tmux.executable,
        ),
      onInput: (data) => {
        if (isTyping(data)) context.deliveryGate.noteKeystroke(agent.id);
      },
    });
    await connection.start();
    return connection;
  };
}

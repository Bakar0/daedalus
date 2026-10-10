import { createHash } from "node:crypto";
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
  RemoteActivityDto,
  RemotePairingDto,
  RemoteStateDto,
  RpcResult,
  TerminalClientMessage,
  TerminalServerMessage,
} from "@daedalus/protocol";
import {
  acceptHandshake,
  claimKey,
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
  pairingCode,
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
  verifyPairingProof,
  type Welcome,
  type WireStats,
} from "@daedalus/remote-protocol";
import {
  type AuditEntry,
  excludeFromBackups,
  RemoteAudit,
  RemoteStore,
  type SecretVault,
} from "./remote-store";
import { isTyping, TerminalConnection, type TerminalSocket } from "./terminal";

export {
  type AuditEntry,
  KeychainVault,
  type PairedPhone,
  RemoteAudit,
  RemoteStore,
} from "./remote-store";

/**
 * The requests a paired phone may make. Everything else (deletes, settings,
 * accounts, secrets, files, the clipboard) has no handler for a phone.
 *
 * This is not a security boundary, and Settings › Remote says so: a phone
 * can start a terminal session (`agentSpawn` with `terminal: true`) or type
 * into any session, and from a shell everything on the Mac is reachable. A
 * paired phone is as trusted as the Mac's own keyboard. What protects the
 * Mac is pairing (confirmed on both screens), the phone's app lock, and
 * removing a lost phone; what records it is the audit log.
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
  /** Records what phones do; see `RemoteAudit`. */
  audit?: Pick<RemoteAudit, "record">;
  /** A phone finished a handshake. */
  onPhoneConnected?: (phone: { id: string; name: string }) => void;
  /** A phone asks to pair, or the request ended (undefined). */
  onPairingRequest?: (request: PairingRequest | undefined) => void;
}

/**
 * - `waiting_for_phone`: connected, not yet claimed by an account.
 * - `online`: connected as an account's Mac.
 * - `locked`: the account has no access or is over its data limit.
 * - `removed`: the relay refused this Mac's credentials, which is what a Mac
 *   removed from its account sees. It stops and waits for the user to start
 *   over rather than erasing its keys on the relay's word.
 */
export type RemoteStatus =
  | "connecting"
  | "waiting_for_phone"
  | "online"
  | "offline"
  | "locked"
  | "removed";

/** A phone that proved it scanned the code, waiting for the user to allow it. */
export interface PairingRequest {
  phoneId: string;
  phoneName: string;
  /** Six digits the phone shows too. */
  code: string;
  expiresAt: number;
}

/** How long the user has to allow or deny a phone. */
const CONFIRM_MS = 2 * 60_000;

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("base64url");

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
  #lastPong = 0;
  #offer: PairingOffer | undefined;
  /** Whether this Mac had no account when the current code was shown. */
  #offerUnclaimed = false;
  /** The last accepted pairing, so a repeated request is answered again. */
  #lastPairing: { offer: PairingOffer; phoneId: string } | undefined;
  #asking:
    | (PairingRequest & {
        offer: PairingOffer;
        phoneKey: string;
        firstPairing: boolean;
        timer: ReturnType<typeof setTimeout>;
      })
    | undefined;
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

  /**
   * A one-time code for the QR code. A new one replaces the last. The relay
   * is told the hash of its claim key first, so only someone holding the
   * code can claim this Mac.
   */
  async createPairingOffer(lifetimeMs?: number): Promise<PairingOffer> {
    const offer = createPairingOffer(
      this.options.store.identity,
      this.options.relay,
      this.#macName,
      lifetimeMs,
    );
    const response = await this.#macCall("/v1/macs/offer", {
      claimHash: sha256(claimKey(offer)),
      expiresAt: offer.expiresAt,
    });
    if (!response.ok)
      throw new DaedalusError(
        "DEPENDENCY",
        "The relay did not accept the pairing code. Try again.",
      );
    this.#offer = offer;
    this.#offerUnclaimed = !this.options.store.relayToken;
    return offer;
  }

  /** A request to the relay as this Mac. */
  async #macCall(path: string, body: unknown = {}): Promise<{ ok: boolean }> {
    try {
      const response = await fetch(
        `${relayHttpUrl(this.options.relay)}${path}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.store.relayCredential}`,
            "X-Daedalus-Device": this.macId,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      return (await response.json()) as { ok: boolean };
    } catch {
      return { ok: false };
    }
  }

  /** The phone waiting for the user to allow it, if any. */
  get pairingRequest(): PairingRequest | undefined {
    const request = this.#asking;
    return request
      ? {
          phoneId: request.phoneId,
          phoneName: request.phoneName,
          code: request.code,
          expiresAt: request.expiresAt,
        }
      : undefined;
  }

  /**
   * The user's answer. Declining the first phone of a Mac that had no
   * account means someone else claimed it with the code, so the Mac also
   * leaves that account and starts over.
   */
  async confirmPairing(allow: boolean): Promise<void> {
    const request = this.#asking;
    if (!request) return;
    clearTimeout(request.timer);
    this.#asking = undefined;
    this.options.onPairingRequest?.(undefined);
    if (!allow) {
      this.options.log?.("remote_pairing_declined", {
        phoneId: request.phoneId,
      });
      this.#sendPlain(request.phoneId, {
        type: "refused",
        reason: "Your Mac declined this phone.",
      });
      if (request.firstPairing && this.options.store.phones.length === 0)
        await this.leaveAccount();
      return;
    }
    this.#lastPairing = { offer: request.offer, phoneId: request.phoneId };
    await this.options.store.addPhone({
      id: request.phoneId,
      publicKey: request.phoneKey,
      name: request.phoneName,
      pairedAt: new Date().toISOString(),
    });
    this.options.log?.("remote_phone_paired", { phoneId: request.phoneId });
    this.#sendPlain(request.phoneId, {
      type: "paired",
      macName: this.#macName,
    });
  }

  /**
   * Takes this Mac off its account on the relay and starts over as a new,
   * unpaired device.
   */
  async leaveAccount(): Promise<void> {
    if (this.options.store.relayToken) await this.#macCall("/v1/macs/leave");
    await this.startOver();
  }

  /** A new identity and no phones; connects again as an unclaimed Mac. */
  async startOver(): Promise<void> {
    await this.options.store.reset();
    this.#offer = undefined;
    this.#lastPairing = undefined;
    this.options.log?.("remote_device_reset", {});
    for (const id of [...this.#phones.keys()]) this.#dropPhone(id);
    const removed = this.#status === "removed";
    this.#setStatus("connecting");
    // A live socket closes and reconnects with the new identity; a removed
    // Mac has none and connects now.
    if (removed) this.#connect();
    else this.#socket?.close();
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
    const token = this.options.store.relayCredential;
    const claimed = Boolean(this.options.store.relayToken);
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
          claimed,
        });
        // The relay answers every ping. Two and a half intervals without an
        // answer means the connection is gone without saying so (a sleep,
        // a network change, a relay redeploy): close it and reconnect.
        this.#lastPong = Date.now();
        this.#ping = setInterval(() => {
          if (Date.now() - this.#lastPong > 75_000) {
            this.options.log?.("remote_silent", {});
            socket.close();
            return;
          }
          socket.send("ping");
        }, 30_000);
        this.#setStatus(claimed ? "online" : "waiting_for_phone");
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
    token: string,
    opened: boolean,
  ): Promise<void> {
    this.options.log?.("remote_disconnected", { code, reason, opened });
    let delay = this.#retryMs;
    if (
      code === RELAY_CLOSE.claimed ||
      token !== this.options.store.relayCredential
    ) {
      // Claimed, or this Mac started over while connected: go again with the
      // new credentials.
      delay = 0;
    } else if (
      code === RELAY_CLOSE.unauthorized ||
      code === RELAY_CLOSE.forbidden
    ) {
      // The account removed this Mac, or the relay no longer knows its
      // credentials. The user decides whether to start over (Settings).
      this.options.log?.("remote_removed", { code, reason });
      this.#setStatus("removed");
      return;
    } else if (
      code === RELAY_CLOSE.noEntitlement ||
      code === RELAY_CLOSE.overQuota ||
      code === RELAY_CLOSE.budgetExhausted ||
      code === RELAY_CLOSE.rateLimited
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
    if (text === "pong") {
      this.#lastPong = Date.now();
      return;
    }
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
    else if (notice.relay === "account")
      void this.options.store.setAccount(notice.email);
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
      await this.#pairRequest(phoneId, message);
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
      this.options.onPhoneConnected?.({
        id: phoneId,
        name: this.options.store.phone(phoneId)?.name ?? "A phone",
      });
    }
  }

  /**
   * A phone that scanned the code proves it with the code's secret. It is
   * then held until the user allows it on this Mac, comparing six digits
   * with the phone's screen. The phone repeats its request every second
   * until answered, so each repeat gets `waiting`.
   */
  async #pairRequest(
    phoneId: string,
    message: Extract<PlainMessage, { type: "pair" }>,
  ): Promise<void> {
    const phone = { id: phoneId, publicKey: message.phoneKey };
    const name = message.name.slice(0, 80);
    const last = this.#lastPairing;
    if (
      last?.phoneId === phoneId &&
      this.options.store.phone(phoneId)?.publicKey === message.phoneKey &&
      verifyPairingProof(last.offer, phone, message.name, message.proof)
    ) {
      this.#sendPlain(phoneId, { type: "paired", macName: this.#macName });
      return;
    }
    const pending = this.#asking;
    if (
      pending?.phoneId === phoneId &&
      pending.phoneKey === message.phoneKey &&
      verifyPairingProof(pending.offer, phone, message.name, message.proof)
    ) {
      this.#sendPlain(phoneId, { type: "waiting" });
      return;
    }
    const offer = this.#offer;
    if (
      !offer ||
      offer.expiresAt < Date.now() ||
      message.phoneId !== phoneId ||
      !verifyPairingProof(offer, phone, message.name, message.proof)
    ) {
      this.#sendPlain(phoneId, {
        type: "refused",
        reason: "The pairing code is wrong or has expired.",
      });
      return;
    }
    this.#offer = undefined;
    const expiresAt = Date.now() + CONFIRM_MS;
    this.#asking = {
      phoneId,
      phoneName: name,
      phoneKey: message.phoneKey,
      code: pairingCode(offer, phone),
      expiresAt,
      offer,
      firstPairing: this.#offerUnclaimed,
      timer: setTimeout(() => void this.confirmPairing(false), CONFIRM_MS),
    };
    this.options.log?.("remote_pairing_requested", { phoneId });
    this.options.onPairingRequest?.(this.pairingRequest);
    this.#sendPlain(phoneId, { type: "waiting" });
  }

  async #sealed(phoneId: string, ciphertext: Uint8Array): Promise<void> {
    const state = this.#phones.get(phoneId);
    if (!state?.channel) throw new Error("Sealed message before handshake");
    const decoded = decodeSecurePlaintext(state.channel.open(ciphertext));
    if (decoded.kind !== "message") return;
    const message = decoded.message;
    if (message.t === "req") {
      const result = await this.#request(message.method, message.params);
      this.#audit(phoneId, {
        action: message.method,
        ...auditTarget(message.params),
        ok: result.ok,
        ...(result.ok ? {} : { code: result.error.code }),
      });
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

  #audit(phoneId: string, entry: Omit<AuditEntry, "at" | "phoneId" | "phone">) {
    this.options.audit?.record({
      phoneId,
      phone: this.options.store.phone(phoneId)?.name ?? "",
      ...entry,
    });
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
    const counted = { bytesIn: 0, bytesOut: 0, done: false };
    const recordClose = () => {
      if (counted.done) return;
      counted.done = true;
      this.#audit(phoneId, {
        action: "terminal.close",
        target: message.agentId,
        ok: true,
        bytesIn: counted.bytesIn,
        bytesOut: counted.bytesOut,
      });
    };
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
        else {
          counted.bytesOut += data.byteLength;
          this.#sendSecureBytes(phoneId, encodeTerminalOutput(ch, data));
        }
      },
      getBufferedAmount: () => this.#socket?.bufferedAmount ?? 0,
      close: () => {
        state.terminals.delete(ch);
        recordClose();
        this.#sendSecure(phoneId, { t: "term.close", ch });
      },
    };
    const size =
      message.cols !== undefined && message.rows !== undefined
        ? { cols: message.cols, rows: message.rows }
        : undefined;
    try {
      const terminal = await this.options.openTerminal(
        message.agentId,
        socket,
        size,
      );
      this.#audit(phoneId, {
        action: "terminal.open",
        target: message.agentId,
        ok: true,
      });
      state.terminals.set(ch, {
        message: (payload) => {
          counted.bytesIn += inputBytes(payload);
          return terminal.message(payload);
        },
        close: () => {
          recordClose();
          terminal.close();
        },
      });
    } catch (error) {
      this.#audit(phoneId, {
        action: "terminal.open",
        target: message.agentId,
        ok: false,
      });
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

/** The ids a request touched, for the audit log; never its text. */
function auditTarget(params: unknown): { target?: string } {
  if (!params || typeof params !== "object") return {};
  const ids = [
    "workspace",
    "workspaceId",
    "reference",
    "taskId",
    "id",
    "agentId",
    "sessionId",
  ]
    .map((key) => (params as Record<string, unknown>)[key])
    .filter(
      (value): value is string =>
        typeof value === "string" && value.length <= 80,
    );
  return ids.length ? { target: [...new Set(ids)].join(" ") } : {};
}

/** How many bytes a terminal message typed, for the audit log. */
function inputBytes(payload: string): number {
  try {
    const message = JSON.parse(payload) as TerminalClientMessage;
    return message.type === "input" ? message.data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * tmux's prefix key. From the phone it is dropped, so typing cannot reach
 * tmux's own command prompt (prefix, then `:`), where `run-shell` would run
 * anything outside the session. Programs in the session do not get Ctrl-B
 * from a phone.
 */
const TMUX_PREFIX = "\u0002";

export function withoutTmuxPrefix(payload: string): string {
  if (!payload.includes("\\u0002") && !payload.includes(TMUX_PREFIX))
    return payload;
  try {
    const message = JSON.parse(payload) as TerminalClientMessage;
    if (message.type !== "input") return payload;
    return JSON.stringify({
      ...message,
      data: message.data.replaceAll(TMUX_PREFIX, ""),
    });
  } catch {
    return payload;
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
      async message(raw) {
        const payload = withoutTmuxPrefix(raw);
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
  pairingCode(): Promise<RemotePairingDto>;
  confirmPairing(allow: boolean): Promise<RemoteStateDto>;
  leaveAccount(): Promise<RemoteStateDto>;
  startOver(): Promise<RemoteStateDto>;
  removePhone(id: string): Promise<RemoteStateDto>;
  activity(): Promise<RemoteActivityDto[]>;
}

export interface RemoteHostOptions {
  context: ApplicationContext;
  macName: string;
  handlers: () => RequestHandlers;
  openTerminal: OpenRemoteTerminal;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Passed to the connector; tests shorten it. */
  lockedRetryMs?: number;
  /**
   * Where the Mac's key goes. Left out, the Keychain on macOS, unless
   * DAEDALUS_REMOTE_VAULT=file (the checks, which must not touch it).
   */
  vault?: SecretVault | null;
}

/** A phone that reconnects within this long is not announced again. */
const ANNOUNCE_AFTER_MS = 30 * 60_000;

/**
 * Keeps a connector running while Settings › Remote is on, and none while
 * it is off. The store is opened on first use, so a user who never turns
 * remote access on never gets a device key.
 */
export class RemoteHost implements DesktopRemoteHost {
  #store: RemoteStore | undefined;
  #connector: RemoteConnector | undefined;
  #awake: Bun.Subprocess | undefined;
  readonly #audit: RemoteAudit;
  /** When each phone last finished a handshake. */
  readonly #lastSeen = new Map<string, number>();

  constructor(private readonly options: RemoteHostOptions) {
    this.#audit = new RemoteAudit(options.context.config.home);
  }

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
    const { home } = this.options.context.config;
    if (!this.#store) {
      this.#store = await RemoteStore.open(
        home,
        this.options.vault,
        this.options.log,
      );
      excludeFromBackups(home);
    }
    this.#connector = new RemoteConnector({
      relay: this.options.context.config.remoteRelay,
      macName: this.macName,
      store: this.#store,
      handlers: this.options.handlers(),
      openTerminal: this.options.openTerminal,
      ...(this.options.log ? { log: this.options.log } : {}),
      ...(this.options.lockedRetryMs
        ? { lockedRetryMs: this.options.lockedRetryMs }
        : {}),
      audit: this.#audit,
      onPhoneConnected: (phone) => this.#phoneConnected(phone),
      onPairingRequest: (request) => {
        if (request)
          void this.options.context.notifications.notify({
            level: "info",
            title: "A phone asks to pair",
            body: `${request.phoneName} wants to pair. Check the code in Settings › Remote, then allow or decline it.`,
            desktop: true,
          });
      },
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

  /**
   * Says so on the Mac when a phone connects, so an unexpected one is
   * noticed. A phone that comes back within half an hour is not repeated.
   */
  #phoneConnected(phone: { id: string; name: string }): void {
    const last = this.#lastSeen.get(phone.id) ?? 0;
    this.#lastSeen.set(phone.id, Date.now());
    if (Date.now() - last < ANNOUNCE_AFTER_MS) return;
    void this.options.context.notifications.notify({
      level: "info",
      title: "Phone connected",
      body: `${phone.name} is connected to this Mac and can run commands on it.`,
      desktop: true,
    });
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
      ...(this.#store?.relayToken && this.#store.account
        ? { account: this.#store.account }
        : {}),
      ...(this.#connector?.pairingRequest
        ? { pairingRequest: this.#connector.pairingRequest }
        : {}),
    };
  }

  async setEnabled(enabled: boolean): Promise<RemoteStateDto> {
    await saveRemoteEnabled(this.options.context.config, enabled);
    if (enabled) await this.#run();
    else this.stop();
    this.#keepAwake();
    return this.state();
  }

  async pairingCode(): Promise<RemotePairingDto> {
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
    const offer = await connector.createPairingOffer();
    return { url: pairingUrl(offer), expiresAt: offer.expiresAt };
  }

  async confirmPairing(allow: boolean): Promise<RemoteStateDto> {
    await this.#connector?.confirmPairing(allow);
    return this.state();
  }

  async leaveAccount(): Promise<RemoteStateDto> {
    await this.#connector?.leaveAccount();
    return this.state();
  }

  async startOver(): Promise<RemoteStateDto> {
    await this.#connector?.startOver();
    return this.state();
  }

  activity(): Promise<RemoteActivityDto[]> {
    return this.#audit.recent(50);
  }

  async removePhone(id: string): Promise<RemoteStateDto> {
    await this.#store?.removePhone(id);
    this.#connector?.forgetPhone(id);
    return this.state();
  }
}

import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@daedalus/protocol";
import {
  claimKey,
  type DeviceIdentity,
  type PairingOffer,
  pairingProof,
  type SecureChannel,
  startHandshake,
} from "./crypto";
import {
  decodePayload,
  decodeRelayFrame,
  decodeSecurePlaintext,
  encodePlain,
  encodeRelayFrame,
  encodeSealed,
  encodeSecureMessage,
  type PlainMessage,
  type SecureMessage,
} from "./frames";

/** The URL a device opens to join the relay room of one Mac. */
export function relayConnectUrl(
  relay: string,
  macId: string,
  role: "mac" | "phone",
  deviceId: string,
  name?: string,
): string {
  const url = new URL("/v1/connect", relay);
  url.searchParams.set("room", macId);
  url.searchParams.set("role", role);
  url.searchParams.set("device", deviceId);
  if (name) url.searchParams.set("name", name);
  return url.toString();
}

/** The relay's HTTP address, from the WebSocket one in a pairing code. */
export function relayHttpUrl(relay: string): string {
  const url = new URL(relay);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  return url.origin;
}

/** Sent with every connection; the token rides as `auth.<token>`. */
export const RELAY_PROTOCOL = "daedalus.v1";

export const relayProtocols = (token?: string): string[] =>
  token ? [RELAY_PROTOCOL, `auth.${token}`] : [RELAY_PROTOCOL];

/** Close codes the relay uses when it refuses or ends a connection. */
export const RELAY_CLOSE = {
  replaced: 4000,
  claimed: 4001,
  unauthorized: 4401,
  noEntitlement: 4402,
  forbidden: 4403,
  overQuota: 4429,
  /** The relay's monthly budget is spent; it reopens on the 1st. */
  budgetExhausted: 4430,
  rateLimited: 4431,
} as const;

/** Counts what crossed the wire, as the relay saw it. */
export interface WireStats {
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
}

export const emptyWireStats = (): WireStats => ({
  framesIn: 0,
  framesOut: 0,
  bytesIn: 0,
  bytesOut: 0,
});

export interface PairedMac {
  relay: string;
  macId: string;
  macKey: string;
  macName: string;
}

interface PhoneOptions {
  /** Sees every raw frame in both directions, as the relay does. */
  tap?: (direction: "in" | "out", frame: Uint8Array) => void;
}

export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Opens a socket and waits until it is usable. A refusal arrives as an
 * accepted socket closed at once with a `RELAY_CLOSE` code, which becomes
 * the error.
 */
function openSocket(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, relayProtocols(token));
    socket.binaryType = "arraybuffer";
    let settled = false;
    socket.addEventListener(
      "open",
      () => {
        // A refused socket opens and closes in the same moment; give the
        // close a turn to arrive before calling it usable.
        setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(socket);
        }, 50);
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (event) => {
        if (settled) return;
        settled = true;
        reject(
          new RelayError(
            String(event.code),
            event.reason || `Could not reach the relay at ${url}`,
          ),
        );
      },
      { once: true },
    );
  });
}

/** The signed-in phone's account on the relay. */
export class RelayAccount {
  readonly base: string;

  constructor(
    relay: string,
    private readonly token: string,
  ) {
    this.base = relayHttpUrl(relay);
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = (await response.json()) as
      | { ok: true; data: T }
      | { ok: false; error: { code: string; message: string } };
    if (!result.ok)
      throw new RelayError(result.error.code, result.error.message);
    return result.data;
  }

  me(): Promise<{
    user: { id: string; email: string };
    entitlement: {
      plan: string;
      maxMacs: number;
      maxPhones: number;
      monthlyMb: number;
    } | null;
    devices: Array<{
      id: string;
      kind: "mac" | "phone";
      name: string;
      lastSeenAt: string | null;
    }>;
    usageBytes: number;
  }> {
    return this.#call("GET", "/v1/me");
  }

  claimMac(
    macId: string,
    name: string,
    key: string,
  ): Promise<{ macId: string }> {
    return this.#call("POST", "/v1/pairings/claim", {
      macId,
      name,
      claimKey: key,
    });
  }

  redeemInvite(code: string): Promise<unknown> {
    return this.#call("POST", "/v1/invites/redeem", { code });
  }

  removeDevice(id: string): Promise<null> {
    return this.#call("DELETE", `/v1/devices/${encodeURIComponent(id)}`);
  }

  pushKey(): Promise<{ publicKey: string }> {
    return this.#call("GET", "/v1/push/key");
  }

  setPushSubscription(deviceId: string, endpoint: string): Promise<null> {
    return this.#call("PUT", "/v1/push/subscription", { deviceId, endpoint });
  }

  removePushSubscription(deviceId: string): Promise<null> {
    return this.#call("DELETE", "/v1/push/subscription", { deviceId });
  }

  signOut(): Promise<null> {
    return this.#call("POST", "/v1/signout");
  }

  /** Ends every sign-in of this account, this one included. */
  signOutEverywhere(): Promise<null> {
    return this.#call("POST", "/v1/signout-all");
  }
}

export interface PairOptions {
  /**
   * The relay this app talks to. A code naming any other is refused, since
   * claiming sends the session token to the relay the code names.
   */
  relay?: string;
  /** The Mac is now asking its user to allow this phone. */
  onWaiting?: () => void;
  /** How long to wait for the Mac and its user. */
  timeoutMs?: number;
}

/**
 * Pairs this phone with the Mac that showed `offer`: the account claims the
 * Mac on the relay with the claim key from the code, then the phone proves
 * to the Mac that it scanned the code, and the Mac's user allows it there.
 * The Mac's public key comes from the offer itself, never from the relay.
 * Claiming makes the Mac reconnect with its new device token, so the
 * request is repeated until the Mac is back and answers.
 */
export async function pairWithMac(
  phone: DeviceIdentity,
  offer: PairingOffer,
  phoneName: string,
  token: string,
  options: PairOptions = {},
): Promise<PairedMac> {
  if (
    options.relay !== undefined &&
    relayHttpUrl(offer.relay) !== relayHttpUrl(options.relay)
  )
    throw new Error("This pairing code is for a different relay.");
  if (offer.expiresAt < Date.now())
    throw new Error("This pairing code has expired");
  await new RelayAccount(offer.relay, token).claimMac(
    offer.macId,
    offer.name,
    claimKey(offer),
  );
  const socket = await openSocket(
    relayConnectUrl(offer.relay, offer.macId, "phone", phone.id, phoneName),
    token,
  );
  let resend: ReturnType<typeof setInterval> | undefined;
  try {
    const answer = await new Promise<PlainMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The Mac did not answer the pairing request")),
        options.timeoutMs ?? 150_000,
      );
      let waiting = false;
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") return;
        const { payload } = decodeRelayFrame(
          new Uint8Array(event.data as ArrayBuffer),
        );
        const decoded = decodePayload(payload);
        if (decoded.kind !== "plain") return;
        if (decoded.message.type === "waiting") {
          if (!waiting) options.onWaiting?.();
          waiting = true;
          return;
        }
        clearTimeout(timer);
        resolve(decoded.message);
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        reject(
          new RelayError(String(event.code), event.reason || "Disconnected"),
        );
      });
      const request = encodeRelayFrame(
        "",
        encodePlain({
          type: "pair",
          phoneId: phone.id,
          phoneKey: phone.publicKey,
          name: phoneName,
          proof: pairingProof(offer, phone, phoneName),
        }),
      );
      socket.send(request);
      resend = setInterval(() => socket.send(request), 1_000);
    });
    if (answer.type === "refused") throw new Error(answer.reason);
    if (answer.type !== "paired")
      throw new Error(`Unexpected answer: ${answer.type}`);
    return {
      relay: offer.relay,
      macId: offer.macId,
      macKey: offer.macKey,
      macName: answer.macName,
    };
  } finally {
    if (resend) clearInterval(resend);
    socket.close();
  }
}

export interface PhoneTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** A connected, end-to-end encrypted session with one paired Mac. */
export class PhoneConnection {
  readonly stats = emptyWireStats();
  #socket!: WebSocket;
  #channel!: SecureChannel;
  #nextRequest = 1;
  #nextChannel = 1;
  #pending = new Map<number, (result: unknown) => void>();
  #terminals = new Map<
    number,
    {
      onOutput: (data: Uint8Array) => void;
      onMessage: (message: TerminalServerMessage) => void;
    }
  >();
  #eventListeners = new Set<() => void>();
  #nameListeners = new Set<(name: string) => void>();
  #macName: string | undefined;
  #closedReason: string | undefined;
  #closeListeners = new Set<(reason: string) => void>();

  private constructor(
    private readonly phone: DeviceIdentity,
    private readonly mac: PairedMac,
    private readonly token: string,
    private readonly options: PhoneOptions,
  ) {}

  static async connect(
    phone: DeviceIdentity,
    mac: PairedMac,
    token: string,
    options: PhoneOptions = {},
    timeoutMs = 15_000,
  ): Promise<PhoneConnection> {
    const connection = new PhoneConnection(phone, mac, token, options);
    await connection.#open(timeoutMs);
    return connection;
  }

  async #open(timeoutMs: number): Promise<void> {
    this.#socket = await openSocket(
      relayConnectUrl(this.mac.relay, this.mac.macId, "phone", this.phone.id),
      this.token,
    );
    const handshake = startHandshake(this.phone, this.mac);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The Mac did not finish the handshake")),
        timeoutMs,
      );
      let ready = false;
      this.#socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") return;
        const frame = new Uint8Array(event.data as ArrayBuffer);
        this.#count("in", frame);
        const decoded = decodePayload(decodeRelayFrame(frame).payload);
        if (!ready) {
          if (decoded.kind !== "plain") return;
          if (decoded.message.type === "refused") {
            clearTimeout(timer);
            reject(new Error(decoded.message.reason));
            return;
          }
          if (decoded.message.type !== "welcome") return;
          const finished = handshake.finish(decoded.message);
          this.#channel = finished.channel;
          this.#sendPlain(finished.ready);
          ready = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (decoded.kind !== "sealed") return;
        try {
          this.#receive(this.#channel.open(decoded.ciphertext));
        } catch (error) {
          this.#socket.close();
          this.#emitClose(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      this.#socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        const reason = event.reason || "The relay closed the connection";
        if (!ready) reject(new RelayError(String(event.code), reason));
        this.#emitClose(reason);
      });
      this.#sendPlain(handshake.hello);
    });
  }

  #count(direction: "in" | "out", frame: Uint8Array): void {
    if (direction === "in") {
      this.stats.framesIn += 1;
      this.stats.bytesIn += frame.byteLength;
    } else {
      this.stats.framesOut += 1;
      this.stats.bytesOut += frame.byteLength;
    }
    this.options.tap?.(direction, frame);
  }

  #sendFrame(payload: Uint8Array): void {
    const frame = encodeRelayFrame("", payload);
    this.#count("out", frame);
    this.#socket.send(frame);
  }

  #sendPlain(message: PlainMessage): void {
    this.#sendFrame(encodePlain(message));
  }

  #sendSecure(message: SecureMessage): void {
    this.#sendFrame(
      encodeSealed(this.#channel.seal(encodeSecureMessage(message))),
    );
  }

  #receive(plaintext: Uint8Array): void {
    const decoded = decodeSecurePlaintext(plaintext);
    if (decoded.kind === "output") {
      this.#terminals.get(decoded.ch)?.onOutput(decoded.data);
      return;
    }
    const message = decoded.message;
    if (message.t === "res") {
      this.#pending.get(message.id)?.(message.result);
      this.#pending.delete(message.id);
    } else if (message.t === "event") {
      for (const listener of this.#eventListeners) listener();
    } else if (message.t === "term.server") {
      this.#terminals.get(message.ch)?.onMessage(message.message);
    } else if (message.t === "term.close") {
      this.#terminals.delete(message.ch);
    } else if (message.t === "mac") {
      this.#macName = message.name;
      for (const listener of this.#nameListeners) listener(message.name);
    }
  }

  #emitClose(reason: string): void {
    this.#closedReason ??= reason;
    for (const resolve of this.#pending.values())
      resolve({ ok: false, error: { code: "DEPENDENCY", message: reason } });
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener(reason);
    this.#closeListeners.clear();
  }

  /** Same request names and result envelope as the desktop RPC. */
  request(method: string, params: unknown = {}): Promise<unknown> {
    // A closed connection answers at once rather than leaving the caller
    // waiting for a reply that cannot come.
    if (this.#closedReason !== undefined)
      return Promise.resolve({
        ok: false,
        error: { code: "DEPENDENCY", message: this.#closedReason },
      });
    const id = this.#nextRequest++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#sendSecure({ t: "req", id, method, params });
    });
  }

  /** Tells the Mac whether the app is on screen, so it can skip pushes. */
  setVisible(visible: boolean): void {
    this.#sendSecure({ t: "presence", visible });
  }

  /** The Mac's name, on connecting and whenever it is renamed. */
  onMacName(listener: (name: string) => void): () => void {
    this.#nameListeners.add(listener);
    if (this.#macName !== undefined) listener(this.#macName);
    return () => this.#nameListeners.delete(listener);
  }

  onDataChanged(listener: () => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): void {
    this.#closeListeners.add(listener);
  }

  openTerminal(
    agentId: string,
    size: { cols: number; rows: number },
    onOutput: (data: Uint8Array) => void,
    onMessage: (message: TerminalServerMessage) => void = () => {},
  ): PhoneTerminal {
    const ch = this.#nextChannel++;
    this.#terminals.set(ch, { onOutput, onMessage });
    this.#sendSecure({ t: "term.open", ch, agentId, ...size });
    const send = (message: TerminalClientMessage) =>
      this.#sendSecure({ t: "term.client", ch, message });
    return {
      write: (data) => send({ type: "input", data }),
      resize: (cols, rows) => send({ type: "resize", cols, rows }),
      close: () => {
        this.#terminals.delete(ch);
        this.#sendSecure({ t: "term.close", ch });
      },
    };
  }

  close(): void {
    this.#socket.close();
  }
}

import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@daedalus/protocol";
import {
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
): string {
  const url = new URL("/v1/connect", relay);
  url.searchParams.set("room", macId);
  url.searchParams.set("role", role);
  url.searchParams.set("device", deviceId);
  return url.toString();
}

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

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`Could not reach the relay at ${url}`)),
      { once: true },
    );
  });
}

/**
 * Pairs this phone with the Mac that showed `offer`. Resolves once the Mac
 * accepts the proof; the Mac's public key comes from the offer itself, never
 * from the relay.
 */
export async function pairWithMac(
  phone: DeviceIdentity,
  offer: PairingOffer,
  name: string,
  timeoutMs = 15_000,
): Promise<PairedMac> {
  if (offer.expiresAt < Date.now())
    throw new Error("This pairing code has expired");
  const socket = await openSocket(
    relayConnectUrl(offer.relay, offer.macId, "phone", phone.id),
  );
  try {
    const answer = await new Promise<PlainMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The Mac did not answer the pairing request")),
        timeoutMs,
      );
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") return;
        const { payload } = decodeRelayFrame(
          new Uint8Array(event.data as ArrayBuffer),
        );
        const decoded = decodePayload(payload);
        if (decoded.kind !== "plain") return;
        clearTimeout(timer);
        resolve(decoded.message);
      });
      socket.send(
        encodeRelayFrame(
          "",
          encodePlain({
            type: "pair",
            phoneId: phone.id,
            phoneKey: phone.publicKey,
            name,
            proof: pairingProof(offer, phone),
          }),
        ),
      );
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
  #closeListeners = new Set<(reason: string) => void>();

  private constructor(
    private readonly phone: DeviceIdentity,
    private readonly mac: PairedMac,
    private readonly options: PhoneOptions,
  ) {}

  static async connect(
    phone: DeviceIdentity,
    mac: PairedMac,
    options: PhoneOptions = {},
    timeoutMs = 15_000,
  ): Promise<PhoneConnection> {
    const connection = new PhoneConnection(phone, mac, options);
    await connection.#open(timeoutMs);
    return connection;
  }

  async #open(timeoutMs: number): Promise<void> {
    this.#socket = await openSocket(
      relayConnectUrl(this.mac.relay, this.mac.macId, "phone", this.phone.id),
    );
    const handshake = startHandshake(this.phone, this.mac.macKey);
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
      this.#socket.addEventListener("close", () => {
        clearTimeout(timer);
        if (!ready) reject(new Error("The relay closed the connection"));
        this.#emitClose("closed");
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
    }
  }

  #emitClose(reason: string): void {
    for (const resolve of this.#pending.values())
      resolve({ ok: false, error: { code: "DEPENDENCY", message: reason } });
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener(reason);
    this.#closeListeners.clear();
  }

  /** Same request names and result envelope as the desktop RPC. */
  request(method: string, params: unknown = {}): Promise<unknown> {
    const id = this.#nextRequest++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#sendSecure({ t: "req", id, method, params });
    });
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

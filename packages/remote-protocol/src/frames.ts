import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@daedalus/protocol";
import type { Hello, Ready, Welcome } from "./crypto";

/**
 * Relay frames are binary: one length byte, the device id, then the payload.
 * A device writes the id of the device it sends to (a phone leaves it empty,
 * since a phone only talks to its Mac) and the relay rewrites it to the id
 * of the sender before forwarding. That id is the only thing the relay reads.
 */
export function encodeRelayFrame(
  deviceId: string,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const id = new TextEncoder().encode(deviceId);
  if (id.length > 255) throw new Error("Device id is too long");
  const frame = new Uint8Array(1 + id.length + payload.length);
  frame[0] = id.length;
  frame.set(id, 1);
  frame.set(payload, 1 + id.length);
  return frame;
}

export function decodeRelayFrame(frame: Uint8Array): {
  deviceId: string;
  payload: Uint8Array;
} {
  const length = frame[0];
  if (length === undefined || frame.length < 1 + length)
    throw new Error("Truncated relay frame");
  return {
    deviceId: new TextDecoder().decode(frame.subarray(1, 1 + length)),
    payload: frame.subarray(1 + length),
  };
}

/** What the relay itself says, as text frames. */
export type RelayNotice =
  | { relay: "peer"; deviceId: string; online: boolean }
  | { relay: "replaced" }
  /** A phone claimed this Mac; the token lets it rejoin as that account's. */
  | { relay: "claimed"; token: string }
  | { relay: "quota"; limitMb: number };

/** Sent before a secure channel exists. Nothing secret travels this way. */
export type PlainMessage =
  | {
      type: "pair";
      phoneId: string;
      phoneKey: string;
      name: string;
      proof: string;
    }
  | { type: "paired"; macName: string }
  | { type: "refused"; reason: string }
  | Hello
  | Welcome
  | Ready;

/** Sent only through the secure channel. */
export type SecureMessage =
  | { t: "req"; id: number; method: string; params: unknown }
  | { t: "res"; id: number; result: unknown }
  | { t: "event"; name: "dataChanged" }
  | {
      t: "term.open";
      ch: number;
      agentId: string;
      cols?: number;
      rows?: number;
    }
  | { t: "term.client"; ch: number; message: TerminalClientMessage }
  | { t: "term.server"; ch: number; message: TerminalServerMessage }
  | { t: "term.close"; ch: number }
  /** The phone app came to the front or left it. */
  | { t: "presence"; visible: boolean }
  /** What the Mac is called; sent on connecting and on a rename. */
  | { t: "mac"; name: string };

const PLAIN = 0;
const SEALED = 1;

export function encodePlain(message: PlainMessage): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const payload = new Uint8Array(1 + body.length);
  payload[0] = PLAIN;
  payload.set(body, 1);
  return payload;
}

export function encodeSealed(ciphertext: Uint8Array): Uint8Array {
  const payload = new Uint8Array(1 + ciphertext.length);
  payload[0] = SEALED;
  payload.set(ciphertext, 1);
  return payload;
}

export function decodePayload(
  payload: Uint8Array,
):
  | { kind: "plain"; message: PlainMessage }
  | { kind: "sealed"; ciphertext: Uint8Array } {
  if (payload[0] === PLAIN)
    return {
      kind: "plain",
      message: JSON.parse(
        new TextDecoder().decode(payload.subarray(1)),
      ) as PlainMessage,
    };
  if (payload[0] === SEALED)
    return { kind: "sealed", ciphertext: payload.subarray(1) };
  throw new Error("Unknown payload kind");
}

/**
 * Inside the secure channel, terminal output skips JSON: one kind byte, a
 * 4-byte channel number, then the raw bytes. Everything else is JSON.
 */
const JSON_MESSAGE = 0;
const TERMINAL_OUTPUT = 1;

export type SecurePlaintext =
  | { kind: "message"; message: SecureMessage }
  | { kind: "output"; ch: number; data: Uint8Array };

export function encodeSecureMessage(message: SecureMessage): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(1 + body.length);
  out[0] = JSON_MESSAGE;
  out.set(body, 1);
  return out;
}

export function encodeTerminalOutput(ch: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + data.length);
  out[0] = TERMINAL_OUTPUT;
  new DataView(out.buffer).setUint32(1, ch);
  out.set(data, 5);
  return out;
}

export function decodeSecurePlaintext(plaintext: Uint8Array): SecurePlaintext {
  if (plaintext[0] === JSON_MESSAGE)
    return {
      kind: "message",
      message: JSON.parse(
        new TextDecoder().decode(plaintext.subarray(1)),
      ) as SecureMessage,
    };
  if (plaintext[0] === TERMINAL_OUTPUT && plaintext.length >= 5)
    return {
      kind: "output",
      ch: new DataView(
        plaintext.buffer,
        plaintext.byteOffset,
        plaintext.byteLength,
      ).getUint32(1),
      data: plaintext.subarray(5),
    };
  throw new Error("Unknown secure message kind");
}

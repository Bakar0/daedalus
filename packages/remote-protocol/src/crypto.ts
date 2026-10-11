import sodium, { type StateAddress } from "libsodium-wrappers";
import {
  type CipherState,
  type KeyPair,
  kkInitiator,
  kkResponder,
} from "./noise";

/**
 * End-to-end encryption between a phone and a Mac. The relay forwards these
 * bytes and holds no key that opens them.
 *
 * Each device has a long-lived X25519 key pair. Pairing tells the phone the
 * Mac's public key (from the QR code) and the Mac the phone's (proved with
 * the one-time secret in that QR code). Every connection then runs a Noise
 * KK handshake (noise.ts): only the paired devices can derive the keys, so a
 * relay that swaps in its own ephemeral key gets a channel nobody can read;
 * the ephemeral keys mean a stolen device key does not open old traffic; and
 * a stolen key lets its holder pose as neither device to the one it stole
 * from.
 *
 * Messages go through libsodium's secretstream, which rejects a tampered,
 * replayed, reordered or dropped message. A connection that hits one is
 * closed and the phone reconnects with a new handshake.
 */

export async function sodiumReady(): Promise<void> {
  await sodium.ready;
}

const B64 = () => sodium.base64_variants.URLSAFE_NO_PADDING;
export const toBase64 = (bytes: Uint8Array): string =>
  sodium.to_base64(bytes, B64());
export const fromBase64 = (text: string): Uint8Array =>
  sodium.from_base64(text, B64());

export interface DeviceIdentity {
  /** Random, public, and what the relay routes by. */
  id: string;
  publicKey: string;
  secretKey: string;
}

export function createIdentity(): DeviceIdentity {
  const pair = sodium.crypto_kx_keypair();
  return {
    id: toBase64(sodium.randombytes_buf(16)),
    publicKey: toBase64(pair.publicKey),
    secretKey: toBase64(pair.privateKey),
  };
}

/** What the Mac shows as a QR code. */
export interface PairingOffer {
  v: 2;
  relay: string;
  macId: string;
  macKey: string;
  /** The Mac's name, shown on the phone before it connects. */
  name: string;
  secret: string;
  expiresAt: number;
}

const OFFER_PREFIX = "daedalus-pair:";

/** How long a pairing code works. Short, since anyone who sees it can use it. */
export const PAIRING_LIFETIME_MS = 2 * 60_000;

export function createPairingOffer(
  mac: DeviceIdentity,
  relay: string,
  name: string,
  lifetimeMs = PAIRING_LIFETIME_MS,
  now = Date.now(),
): PairingOffer {
  return {
    v: 2,
    relay,
    macId: mac.id,
    macKey: mac.publicKey,
    name,
    secret: toBase64(sodium.randombytes_buf(32)),
    expiresAt: now + lifetimeMs,
  };
}

export const encodePairingOffer = (offer: PairingOffer): string =>
  OFFER_PREFIX + toBase64(sodium.from_string(JSON.stringify(offer)));

/**
 * What the QR code holds: a link to the phone page on the relay, with the
 * code in the fragment. A phone camera opens the link; the fragment never
 * reaches a server.
 */
export function pairingUrl(offer: PairingOffer): string {
  const url = new URL(offer.relay);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${url.origin}/pair#${encodePairingOffer(offer)}`;
}

/** Accepts the bare code or the link `pairingUrl` makes. */
export function decodePairingOffer(input: string): PairingOffer {
  const hash = input.indexOf("#");
  const text = hash >= 0 ? input.slice(hash + 1) : input;
  if (!text.startsWith(OFFER_PREFIX))
    throw new Error("Not a Daedalus pairing code");
  const offer = JSON.parse(
    sodium.to_string(fromBase64(text.slice(OFFER_PREFIX.length))),
  ) as PairingOffer;
  if (offer.v !== 2)
    throw new Error(
      "This pairing code is from an older Daedalus. Update the Mac.",
    );
  if (
    typeof offer.relay !== "string" ||
    typeof offer.macId !== "string" ||
    typeof offer.macKey !== "string" ||
    typeof offer.name !== "string" ||
    typeof offer.secret !== "string" ||
    typeof offer.expiresAt !== "number"
  )
    throw new Error("Malformed pairing code");
  return offer;
}

/** A keyed BLAKE2b of `label`, under the offer's one-time secret. */
const fromSecret = (offer: PairingOffer, bytes: number, label: string) =>
  sodium.crypto_generichash(
    bytes,
    sodium.from_string(label),
    fromBase64(offer.secret),
  );

/**
 * What the phone shows the relay to claim the Mac. The Mac registers its
 * hash when it shows the code, so knowing the Mac's id is not enough.
 */
export const claimKey = (offer: PairingOffer): string =>
  toBase64(fromSecret(offer, 32, `daedalus-claim-v2|${offer.macId}`));

type PhoneKey = Pick<DeviceIdentity, "id" | "publicKey">;

/**
 * Six digits both screens show while the Mac asks the user to allow the
 * phone. They depend on the phone's key, so a phone that raced the owner's
 * with the same QR code shows different digits from the owner's phone.
 */
export function pairingCode(offer: PairingOffer, phone: PhoneKey): string {
  const digest = fromSecret(
    offer,
    16,
    `daedalus-pair-code-v2|${offer.macId}|${phone.id}|${phone.publicKey}`,
  );
  const value = new DataView(digest.buffer, digest.byteOffset).getUint32(0);
  return String(value % 1_000_000).padStart(6, "0");
}

const pairingInput = (macId: string, phone: PhoneKey, name: string) =>
  sodium.from_string(
    `daedalus-pair-v2|${macId}|${phone.id}|${phone.publicKey}|${name}`,
  );

/** The phone's proof that it scanned this offer, covering its name too. */
export function pairingProof(
  offer: PairingOffer,
  phone: PhoneKey,
  name: string,
): string {
  return toBase64(
    sodium.crypto_auth(
      pairingInput(offer.macId, phone, name),
      fromBase64(offer.secret),
    ),
  );
}

export function verifyPairingProof(
  offer: PairingOffer,
  phone: PhoneKey,
  name: string,
  proof: string,
): boolean {
  try {
    return sodium.crypto_auth_verify(
      fromBase64(proof),
      pairingInput(offer.macId, phone, name),
      fromBase64(offer.secret),
    );
  } catch {
    return false;
  }
}

/** One direction-pair of secretstream state, ready to seal and open. */
export class SecureChannel {
  readonly #push: StateAddress;
  readonly #pull: StateAddress;

  constructor(push: StateAddress, pull: StateAddress) {
    this.#push = push;
    this.#pull = pull;
  }

  seal(plaintext: Uint8Array): Uint8Array {
    return sodium.crypto_secretstream_xchacha20poly1305_push(
      this.#push,
      plaintext,
      null,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
  }

  /** Throws on anything the sender did not seal, in the order it sealed. */
  open(ciphertext: Uint8Array): Uint8Array {
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
      this.#pull,
      ciphertext,
      null,
    );
    if (!result) throw new Error("Message failed authentication");
    return result.message;
  }
}

const keyPair = (identity: DeviceIdentity): KeyPair => ({
  publicKey: fromBase64(identity.publicKey),
  privateKey: fromBase64(identity.secretKey),
});

/**
 * Binds the handshake to this protocol, this Mac and this phone: a hello
 * meant for another Mac, or one from v1, fails to decrypt.
 */
const prologue = (macId: string, phoneId: string) =>
  sodium.from_string(`daedalus-remote-v2|${macId}|${phoneId}`);

/** Secretstream keys from Noise's split, kept apart from Noise's own use. */
const streamKey = (cipher: CipherState) =>
  sodium.crypto_generichash(
    sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
    sodium.from_string("daedalus-secretstream"),
    cipher.key,
  );

const EMPTY = new Uint8Array();

export interface Hello {
  type: "hello";
  phoneId: string;
  /** Noise KK message 1. */
  message: string;
}

export interface Welcome {
  type: "welcome";
  /** Noise KK message 2. */
  message: string;
  /** The Mac's secretstream header, sealed with the Mac's transport key. */
  header: string;
}

export interface Ready {
  type: "ready";
  /**
   * The phone's secretstream header, sealed with the first Noise transport
   * key. The Mac trusts the phone only once this opens: it is the first
   * message that needs the phone's own static key.
   */
  message: string;
}

/** Phone side: send `hello`, then finish with the Mac's `welcome`. */
export function startHandshake(
  phone: DeviceIdentity,
  mac: { macId: string; macKey: string },
): {
  hello: Hello;
  finish(welcome: Welcome): { channel: SecureChannel; ready: Ready };
} {
  const noise = kkInitiator({
    prologue: prologue(mac.macId, phone.id),
    local: keyPair(phone),
    remoteStatic: fromBase64(mac.macKey),
  });
  return {
    hello: {
      type: "hello",
      phoneId: phone.id,
      message: toBase64(noise.writeMessage1(EMPTY)),
    },
    finish(welcome) {
      const { result } = noise.readMessage2(fromBase64(welcome.message));
      const macHeader = result.responderToInitiator.decrypt(
        EMPTY,
        fromBase64(welcome.header),
      );
      const push = sodium.crypto_secretstream_xchacha20poly1305_init_push(
        streamKey(result.initiatorToResponder),
      );
      const pull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        macHeader,
        streamKey(result.responderToInitiator),
      );
      return {
        channel: new SecureChannel(push.state, pull),
        ready: {
          type: "ready",
          message: toBase64(
            result.initiatorToResponder.encrypt(EMPTY, push.header),
          ),
        },
      };
    },
  };
}

/**
 * Mac side: answer a paired phone's `hello`, then finish with its `ready`.
 * Throws on a hello or ready that does not come from that phone.
 */
export function acceptHandshake(
  mac: DeviceIdentity,
  phoneKey: string,
  hello: Hello,
): { welcome: Welcome; finish(ready: Ready): SecureChannel } {
  const noise = kkResponder({
    prologue: prologue(mac.id, hello.phoneId),
    local: keyPair(mac),
    remoteStatic: fromBase64(phoneKey),
  });
  noise.readMessage1(fromBase64(hello.message));
  const { message, result } = noise.writeMessage2(EMPTY);
  const push = sodium.crypto_secretstream_xchacha20poly1305_init_push(
    streamKey(result.responderToInitiator),
  );
  return {
    welcome: {
      type: "welcome",
      message: toBase64(message),
      header: toBase64(result.responderToInitiator.encrypt(EMPTY, push.header)),
    },
    finish(ready) {
      const phoneHeader = result.initiatorToResponder.decrypt(
        EMPTY,
        fromBase64(ready.message),
      );
      const pull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        phoneHeader,
        streamKey(result.initiatorToResponder),
      );
      return new SecureChannel(push.state, pull);
    },
  };
}

/**
 * Seals data at rest under a 32-byte secret (the phone's app lock: a
 * passkey's PRF output). The key is hashed first, so the raw secret is
 * never used as a cipher key directly.
 */
export function sealAtRest(secret: Uint8Array, plaintext: string): string {
  const key = sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,
    sodium.from_string("daedalus-app-lock-v1"),
    secret,
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(
    sodium.from_string(plaintext),
    nonce,
    key,
  );
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return toBase64(out);
}

/** Throws when the secret is not the one the data was sealed with. */
export function openAtRest(secret: Uint8Array, sealed: string): string {
  const key = sodium.crypto_generichash(
    sodium.crypto_secretbox_KEYBYTES,
    sodium.from_string("daedalus-app-lock-v1"),
    secret,
  );
  const bytes = fromBase64(sealed);
  const nonceBytes = sodium.crypto_secretbox_NONCEBYTES;
  return sodium.to_string(
    sodium.crypto_secretbox_open_easy(
      bytes.subarray(nonceBytes),
      bytes.subarray(0, nonceBytes),
      key,
    ),
  );
}

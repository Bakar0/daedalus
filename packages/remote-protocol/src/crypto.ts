import sodium, { type StateAddress } from "libsodium-wrappers";

/**
 * End-to-end encryption between a phone and a Mac. The relay forwards these
 * bytes and holds no key that opens them.
 *
 * Each device has a long-lived X25519 key pair. Pairing tells the phone the
 * Mac's public key (from the QR code) and the Mac the phone's (proved with
 * the one-time secret in that QR code). Every connection then runs a short
 * handshake: both sides send a fresh ephemeral key, and the session keys
 * hash the static-static and the ephemeral-ephemeral exchanges together. The
 * static part means only the paired devices can derive the keys, so a relay
 * that swaps in its own ephemeral key gets a channel nobody can read. The
 * ephemeral part means a stolen device key does not open old traffic.
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
  v: 1;
  relay: string;
  macId: string;
  macKey: string;
  /** The Mac's name, shown on the phone before it connects. */
  name: string;
  secret: string;
  expiresAt: number;
}

const OFFER_PREFIX = "daedalus-pair:";

export function createPairingOffer(
  mac: DeviceIdentity,
  relay: string,
  name: string,
  lifetimeMs = 5 * 60_000,
  now = Date.now(),
): PairingOffer {
  return {
    v: 1,
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

export function decodePairingOffer(text: string): PairingOffer {
  if (!text.startsWith(OFFER_PREFIX))
    throw new Error("Not a Daedalus pairing code");
  const offer = JSON.parse(
    sodium.to_string(fromBase64(text.slice(OFFER_PREFIX.length))),
  ) as PairingOffer;
  if (
    offer.v !== 1 ||
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

const pairingInput = (macId: string, phoneId: string, phoneKey: string) =>
  sodium.from_string(`daedalus-pair-v1|${macId}|${phoneId}|${phoneKey}`);

/** The phone's proof that it scanned this offer. */
export function pairingProof(
  offer: PairingOffer,
  phone: Pick<DeviceIdentity, "id" | "publicKey">,
): string {
  return toBase64(
    sodium.crypto_auth(
      pairingInput(offer.macId, phone.id, phone.publicKey),
      fromBase64(offer.secret),
    ),
  );
}

export function verifyPairingProof(
  offer: PairingOffer,
  phone: Pick<DeviceIdentity, "id" | "publicKey">,
  proof: string,
): boolean {
  try {
    return sodium.crypto_auth_verify(
      fromBase64(proof),
      pairingInput(offer.macId, phone.id, phone.publicKey),
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

function sessionKeys(
  role: "mac" | "phone",
  staticPair: { publicKey: Uint8Array; privateKey: Uint8Array },
  ephemeralPair: { publicKey: Uint8Array; privateKey: Uint8Array },
  peerStatic: Uint8Array,
  peerEphemeral: Uint8Array,
): { rx: Uint8Array; tx: Uint8Array } {
  const derive =
    role === "mac"
      ? sodium.crypto_kx_server_session_keys
      : sodium.crypto_kx_client_session_keys;
  const fixed = derive(staticPair.publicKey, staticPair.privateKey, peerStatic);
  const fresh = derive(
    ephemeralPair.publicKey,
    ephemeralPair.privateKey,
    peerEphemeral,
  );
  const mix = (a: Uint8Array, b: Uint8Array) => {
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    return sodium.crypto_generichash(
      sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
      joined,
      sodium.from_string("daedalus-remote-v1"),
    );
  };
  return {
    rx: mix(fixed.sharedRx, fresh.sharedRx),
    tx: mix(fixed.sharedTx, fresh.sharedTx),
  };
}

const keyPair = (identity: DeviceIdentity) => ({
  publicKey: fromBase64(identity.publicKey),
  privateKey: fromBase64(identity.secretKey),
});

export interface Hello {
  type: "hello";
  phoneId: string;
  ephemeral: string;
}

export interface Welcome {
  type: "welcome";
  ephemeral: string;
  header: string;
}

export interface Ready {
  type: "ready";
  header: string;
}

/** Phone side: send `hello`, then finish with the Mac's `welcome`. */
export function startHandshake(
  phone: DeviceIdentity,
  macKey: string,
): {
  hello: Hello;
  finish(welcome: Welcome): { channel: SecureChannel; ready: Ready };
} {
  const ephemeral = sodium.crypto_kx_keypair();
  return {
    hello: {
      type: "hello",
      phoneId: phone.id,
      ephemeral: toBase64(ephemeral.publicKey),
    },
    finish(welcome) {
      const keys = sessionKeys(
        "phone",
        keyPair(phone),
        ephemeral,
        fromBase64(macKey),
        fromBase64(welcome.ephemeral),
      );
      const push = sodium.crypto_secretstream_xchacha20poly1305_init_push(
        keys.tx,
      );
      const pull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        fromBase64(welcome.header),
        keys.rx,
      );
      return {
        channel: new SecureChannel(push.state, pull),
        ready: { type: "ready", header: toBase64(push.header) },
      };
    },
  };
}

/** Mac side: answer a paired phone's `hello`, then finish with its `ready`. */
export function acceptHandshake(
  mac: DeviceIdentity,
  phoneKey: string,
  hello: Hello,
): { welcome: Welcome; finish(ready: Ready): SecureChannel } {
  const ephemeral = sodium.crypto_kx_keypair();
  const keys = sessionKeys(
    "mac",
    keyPair(mac),
    ephemeral,
    fromBase64(phoneKey),
    fromBase64(hello.ephemeral),
  );
  const push = sodium.crypto_secretstream_xchacha20poly1305_init_push(keys.tx);
  return {
    welcome: {
      type: "welcome",
      ephemeral: toBase64(ephemeral.publicKey),
      header: toBase64(push.header),
    },
    finish(ready) {
      const pull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        fromBase64(ready.header),
        keys.rx,
      );
      return new SecureChannel(push.state, pull);
    },
  };
}

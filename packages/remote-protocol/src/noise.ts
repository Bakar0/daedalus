import sodium from "libsodium-wrappers";

/**
 * Noise_KK_25519_ChaChaPoly_BLAKE2b (noiseprotocol.org/noise.html, rev 34),
 * for the one handshake this protocol runs: both sides already know the
 * other's static key, the phone starts (`-> e, es, ss`) and the Mac answers
 * (`<- e, ee, se`). Checked against the cacophony test vectors in
 * crypto.test.ts.
 *
 * Over the ss+ee handshake it replaces, KK adds es and se, so a stolen Mac
 * key no longer lets its holder pose as a phone to that Mac, nor a stolen
 * phone key as the Mac to that phone; and a transcript hash over the
 * prologue, both static keys and every message sent.
 */

const PROTOCOL_NAME = "Noise_KK_25519_ChaChaPoly_BLAKE2b";
const HASHLEN = 64;
const BLOCKLEN = 128;

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const hash = (data: Uint8Array): Uint8Array =>
  sodium.crypto_generichash(HASHLEN, data, null);

function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  const block = new Uint8Array(BLOCKLEN);
  block.set(key.length > BLOCKLEN ? hash(key) : key);
  const inner = block.map((byte) => byte ^ 0x36);
  const outer = block.map((byte) => byte ^ 0x5c);
  return hash(concat(outer, hash(concat(inner, data))));
}

function hkdf(
  chainingKey: Uint8Array,
  input: Uint8Array,
): [Uint8Array, Uint8Array] {
  const temp = hmac(chainingKey, input);
  const first = hmac(temp, Uint8Array.of(1));
  const second = hmac(temp, concat(first, Uint8Array.of(2)));
  return [first, second];
}

const dh = (pair: KeyPair, publicKey: Uint8Array): Uint8Array =>
  sodium.crypto_scalarmult(pair.privateKey, publicKey);

/** 32 zero bits, then the counter as a little-endian 64-bit number. */
function nonce(n: number): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, BigInt(n), true);
  return out;
}

/** A key and its message counter (the spec's CipherState). */
export class CipherState {
  #n = 0;
  constructor(readonly key: Uint8Array) {}

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
      plaintext,
      ad,
      null,
      nonce(this.#n++),
      this.key,
    );
  }

  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const plaintext = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      ad,
      nonce(this.#n),
      this.key,
    );
    this.#n += 1;
    return plaintext;
  }
}

/** The spec's SymmetricState: chaining key, handshake hash, current key. */
class Symmetric {
  ck: Uint8Array;
  h: Uint8Array;
  cipher: CipherState | undefined;

  constructor(prologue: Uint8Array) {
    const name = sodium.from_string(PROTOCOL_NAME);
    this.h = new Uint8Array(HASHLEN);
    this.h.set(name);
    this.ck = this.h;
    this.mixHash(prologue);
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(concat(this.h, data));
  }

  mixKey(input: Uint8Array): void {
    const [ck, key] = hkdf(this.ck, input);
    this.ck = ck;
    this.cipher = new CipherState(key.slice(0, 32));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const out = this.cipher
      ? this.cipher.encrypt(this.h, plaintext)
      : plaintext;
    this.mixHash(out);
    return out;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const out = this.cipher
      ? this.cipher.decrypt(this.h, ciphertext)
      : ciphertext;
    this.mixHash(ciphertext);
    return out;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.ck, new Uint8Array());
    return [
      new CipherState(first.slice(0, 32)),
      new CipherState(second.slice(0, 32)),
    ];
  }
}

export interface KkResult {
  /** Encrypts from the initiator to the responder. */
  initiatorToResponder: CipherState;
  responderToInitiator: CipherState;
  handshakeHash: Uint8Array;
}

const DHLEN = 32;

/** The phone's side: write message 1, then read message 2. */
export function kkInitiator(options: {
  prologue: Uint8Array;
  local: KeyPair;
  remoteStatic: Uint8Array;
  /** For the test vectors only; otherwise a fresh key pair. */
  ephemeral?: KeyPair;
  /** For the key-compromise test only: an attacker's stand-in for DH. */
  staticDh?: (remote: Uint8Array) => Uint8Array;
}) {
  const state = new Symmetric(options.prologue);
  state.mixHash(options.local.publicKey);
  state.mixHash(options.remoteStatic);
  const e = options.ephemeral ?? sodium.crypto_kx_keypair();
  const staticDh =
    options.staticDh ?? ((remote: Uint8Array) => dh(options.local, remote));
  return {
    writeMessage1(payload: Uint8Array): Uint8Array {
      state.mixHash(e.publicKey);
      state.mixKey(dh(e, options.remoteStatic)); // es
      state.mixKey(staticDh(options.remoteStatic)); // ss
      return concat(e.publicKey, state.encryptAndHash(payload));
    },
    readMessage2(message: Uint8Array): {
      payload: Uint8Array;
      result: KkResult;
    } {
      if (message.length < DHLEN + 16) throw new Error("Short handshake");
      const re = message.subarray(0, DHLEN);
      state.mixHash(re);
      state.mixKey(dh(e, re)); // ee
      state.mixKey(staticDh(re)); // se
      const payload = state.decryptAndHash(message.subarray(DHLEN));
      const [i2r, r2i] = state.split();
      return {
        payload,
        result: {
          initiatorToResponder: i2r,
          responderToInitiator: r2i,
          handshakeHash: state.h,
        },
      };
    },
  };
}

/** The Mac's side: read message 1, then write message 2. */
export function kkResponder(options: {
  prologue: Uint8Array;
  local: KeyPair;
  remoteStatic: Uint8Array;
  ephemeral?: KeyPair;
}) {
  const state = new Symmetric(options.prologue);
  state.mixHash(options.remoteStatic);
  state.mixHash(options.local.publicKey);
  const e = options.ephemeral ?? sodium.crypto_kx_keypair();
  let re: Uint8Array | undefined;
  return {
    readMessage1(message: Uint8Array): Uint8Array {
      if (message.length < DHLEN + 16) throw new Error("Short handshake");
      re = message.slice(0, DHLEN);
      state.mixHash(re);
      state.mixKey(dh(options.local, re)); // es
      state.mixKey(dh(options.local, options.remoteStatic)); // ss
      return state.decryptAndHash(message.subarray(DHLEN));
    },
    writeMessage2(payload: Uint8Array): {
      message: Uint8Array;
      result: KkResult;
    } {
      if (!re) throw new Error("Message 1 not read");
      state.mixHash(e.publicKey);
      state.mixKey(dh(e, re)); // ee
      state.mixKey(dh(e, options.remoteStatic)); // se
      const message = concat(e.publicKey, state.encryptAndHash(payload));
      const [i2r, r2i] = state.split();
      return {
        message,
        result: {
          initiatorToResponder: i2r,
          responderToInitiator: r2i,
          handshakeHash: state.h,
        },
      };
    },
  };
}

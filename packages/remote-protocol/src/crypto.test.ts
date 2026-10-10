import { beforeAll, describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import {
  acceptHandshake,
  claimKey,
  createIdentity,
  createPairingOffer,
  decodePairingOffer,
  encodePairingOffer,
  fromBase64,
  pairingCode,
  pairingProof,
  pairingUrl,
  sodiumReady,
  startHandshake,
  toBase64,
  verifyPairingProof,
} from "./crypto";
import { kkInitiator, kkResponder } from "./noise";
import {
  decodeRelayFrame,
  decodeSecurePlaintext,
  encodeRelayFrame,
  encodeSecureMessage,
  encodeTerminalOutput,
} from "./frames";

beforeAll(sodiumReady);

const text = (value: string) => new TextEncoder().encode(value);

function connect() {
  const mac = createIdentity();
  const phone = createIdentity();
  const phoneSide = startHandshake(phone, {
    macId: mac.id,
    macKey: mac.publicKey,
  });
  const macSide = acceptHandshake(mac, phone.publicKey, phoneSide.hello);
  const { channel: phoneChannel, ready } = phoneSide.finish(macSide.welcome);
  const macChannel = macSide.finish(ready);
  return { mac, phone, macChannel, phoneChannel };
}

describe("pairing", () => {
  test("the code round-trips and the proof checks", () => {
    const mac = createIdentity();
    const phone = createIdentity();
    const offer = decodePairingOffer(
      encodePairingOffer(createPairingOffer(mac, "wss://relay.example", "Mac")),
    );
    expect(offer.macKey).toBe(mac.publicKey);
    expect(
      verifyPairingProof(
        offer,
        phone,
        "iPhone",
        pairingProof(offer, phone, "iPhone"),
      ),
    ).toBe(true);
  });

  test("a proof for another key, name or code fails", () => {
    const mac = createIdentity();
    const phone = createIdentity();
    const intruder = createIdentity();
    const offer = createPairingOffer(mac, "wss://relay.example", "Mac");
    const proof = pairingProof(offer, phone, "iPhone");
    expect(
      verifyPairingProof(
        offer,
        { id: phone.id, publicKey: intruder.publicKey },
        "iPhone",
        proof,
      ),
    ).toBe(false);
    // The relay forwards the name; it cannot change it.
    expect(verifyPairingProof(offer, phone, "Renamed", proof)).toBe(false);
    const otherOffer = createPairingOffer(mac, "wss://relay.example", "Mac");
    expect(verifyPairingProof(otherOffer, phone, "iPhone", proof)).toBe(false);
    expect(verifyPairingProof(offer, phone, "iPhone", "not-base64!")).toBe(
      false,
    );
  });

  test("codes last two minutes", () => {
    const offer = createPairingOffer(
      createIdentity(),
      "wss://relay.example",
      "Mac",
      undefined,
      1_000,
    );
    expect(offer.expiresAt).toBe(1_000 + 2 * 60_000);
  });

  test("the claim key and the six digits come from the code's secret", () => {
    const mac = createIdentity();
    const offer = createPairingOffer(mac, "wss://relay.example", "Mac");
    const again = createPairingOffer(mac, "wss://relay.example", "Mac");
    expect(claimKey(offer)).toBe(claimKey(offer));
    expect(claimKey(offer)).not.toBe(claimKey(again));
    expect(fromBase64(claimKey(offer)).length).toBe(32);
    const phone = createIdentity();
    const racer = createIdentity();
    expect(pairingCode(offer, phone)).toMatch(/^\d{6}$/);
    expect(pairingCode(offer, phone)).toBe(pairingCode(offer, phone));
    // A phone that raced the owner's with the same QR code shows other
    // digits (one time in a million they match).
    expect(pairingCode(offer, racer)).not.toBe(pairingCode(offer, phone));
  });

  test("the QR link carries the code in its fragment", () => {
    const offer = createPairingOffer(
      createIdentity(),
      "wss://relay.example",
      "Mac",
    );
    const url = pairingUrl(offer);
    expect(url.startsWith("https://relay.example/pair#daedalus-pair:")).toBe(
      true,
    );
    expect(decodePairingOffer(url)).toEqual(offer);
  });

  test("anything but a v2 pairing code is rejected", () => {
    expect(() => decodePairingOffer("https://example.com")).toThrow();
    const old = {
      ...createPairingOffer(createIdentity(), "wss://relay.example", "Mac"),
      v: 1,
    };
    expect(() =>
      decodePairingOffer(
        `daedalus-pair:${toBase64(sodium.from_string(JSON.stringify(old)))}`,
      ),
    ).toThrow("older Daedalus");
  });
});

describe("Noise KK", () => {
  // From the cacophony test vectors (github.com/haskell-cryptography/
  // cacophony, vectors/cacophony.txt), Noise_KK_25519_ChaChaPoly_BLAKE2b.
  const vector = {
    prologue: "4a6f686e2047616c74",
    initStatic:
      "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
    initEphemeral:
      "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
    respStatic:
      "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
    respEphemeral:
      "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
    handshakeHash:
      "76dbc866183c8ee7363dbf0ebab8d6355010245f9817aa78359818a03a052586d7e8b4bb2ae5622a1a61212df90af04bb2b2cc189ce0e819ba0c4970c9f71805",
    messages: [
      [
        "4c756477696720766f6e204d69736573",
        "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944f79a1d4b21fc3ea4a0c87213b8b4f0599d758682c26a3ae5e09195a3e742bc74",
      ],
      [
        "4d757272617920526f746862617264",
        "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843e20b1bf85731f75d7e21b5d54baaa66341de4292c3d42571c1bd7e7f1abe38",
      ],
      [
        "462e20412e20486179656b",
        "25bfaa58833b07cdd6af7c07f2c51daac681a8ac0a02dd373259bd",
      ],
      [
        "4361726c204d656e676572",
        "ef586cff556dec8ef0053871ff0d4bf3f2c72e842487ec6d1da69f",
      ],
    ],
  } as const;

  test("matches the published test vector", () => {
    const hex = sodium.from_hex;
    const pair = (secret: string) => ({
      privateKey: hex(secret),
      publicKey: sodium.crypto_scalarmult_base(hex(secret)),
    });
    const initiatorStatic = pair(vector.initStatic);
    const responderStatic = pair(vector.respStatic);
    const initiator = kkInitiator({
      prologue: hex(vector.prologue),
      local: initiatorStatic,
      remoteStatic: responderStatic.publicKey,
      ephemeral: pair(vector.initEphemeral),
    });
    const responder = kkResponder({
      prologue: hex(vector.prologue),
      local: responderStatic,
      remoteStatic: initiatorStatic.publicKey,
      ephemeral: pair(vector.respEphemeral),
    });
    const [m1, m2, m3, m4] = vector.messages;
    const first = initiator.writeMessage1(hex(m1[0]));
    expect(sodium.to_hex(first)).toBe(m1[1]);
    expect(sodium.to_hex(responder.readMessage1(first))).toBe(m1[0]);
    const second = responder.writeMessage2(hex(m2[0]));
    expect(sodium.to_hex(second.message)).toBe(m2[1]);
    const read = initiator.readMessage2(second.message);
    expect(sodium.to_hex(read.payload)).toBe(m2[0]);
    expect(sodium.to_hex(read.result.handshakeHash)).toBe(vector.handshakeHash);
    expect(sodium.to_hex(second.result.handshakeHash)).toBe(
      vector.handshakeHash,
    );
    const empty = new Uint8Array();
    expect(
      sodium.to_hex(
        read.result.initiatorToResponder.encrypt(empty, hex(m3[0])),
      ),
    ).toBe(m3[1]);
    expect(
      sodium.to_hex(
        second.result.responderToInitiator.encrypt(empty, hex(m4[0])),
      ),
    ).toBe(m4[1]);
  });

  test("the Mac's own stolen key does not let anyone pose as its phone", () => {
    // The attack the old ss+ee handshake allowed: with only the Mac's secret
    // key and the phone's public key, compute the static-static secret from
    // the Mac's side and pose as the phone.
    const mac = createIdentity();
    const phone = createIdentity();
    const macSecret = fromBase64(mac.secretKey);
    const prologue = sodium.from_string(
      `daedalus-remote-v2|${mac.id}|${phone.id}`,
    );
    const attacker = kkInitiator({
      prologue,
      local: {
        publicKey: fromBase64(phone.publicKey),
        privateKey: new Uint8Array(32),
      },
      remoteStatic: fromBase64(mac.publicKey),
      // ss is computable from the Mac's key; se is not, and this is the
      // attacker's best guess at it.
      staticDh: (remote) =>
        sodium.crypto_scalarmult(
          macSecret,
          toBase64(remote) === mac.publicKey
            ? fromBase64(phone.publicKey)
            : remote,
        ),
    });
    const accept = acceptHandshake(mac, phone.publicKey, {
      type: "hello",
      phoneId: phone.id,
      message: toBase64(attacker.writeMessage1(new Uint8Array())),
    });
    expect(() =>
      attacker.readMessage2(fromBase64(accept.welcome.message)),
    ).toThrow();
    // And the Mac never accepts a ready it did not get from the phone.
    expect(() =>
      accept.finish({ type: "ready", message: toBase64(new Uint8Array(48)) }),
    ).toThrow();
  });

  test("a hello for another Mac does not open", () => {
    const mac = createIdentity();
    const other = createIdentity();
    const phone = createIdentity();
    const hello = startHandshake(phone, {
      macId: other.id,
      macKey: mac.publicKey,
    }).hello;
    expect(() => acceptHandshake(mac, phone.publicKey, hello)).toThrow();
  });
});

describe("secure channel", () => {
  test("both directions decrypt", () => {
    const { macChannel, phoneChannel } = connect();
    const toMac = phoneChannel.seal(text("hello mac"));
    expect(new TextDecoder().decode(macChannel.open(toMac))).toBe("hello mac");
    const toPhone = macChannel.seal(text("hello phone"));
    expect(new TextDecoder().decode(phoneChannel.open(toPhone))).toBe(
      "hello phone",
    );
  });

  test("the ciphertext does not contain the plaintext", () => {
    const { phoneChannel } = connect();
    const sealed = phoneChannel.seal(text("SECRET-MARKER-123"));
    expect(new TextDecoder().decode(sealed)).not.toContain("SECRET-MARKER");
  });

  test("tampered, replayed and reordered messages are rejected", () => {
    const tampered = connect();
    const sealed = tampered.phoneChannel.seal(text("one"));
    sealed[sealed.length - 1]! ^= 1;
    expect(() => tampered.macChannel.open(sealed)).toThrow();

    const replayed = connect();
    const once = replayed.phoneChannel.seal(text("one"));
    replayed.macChannel.open(once);
    expect(() => replayed.macChannel.open(once)).toThrow();

    const reordered = connect();
    reordered.phoneChannel.seal(text("first"));
    const second = reordered.phoneChannel.seal(text("second"));
    expect(() => reordered.macChannel.open(second)).toThrow();
  });

  test("a relay that swaps the ephemeral key gets an unusable channel", () => {
    const mac = createIdentity();
    const phone = createIdentity();
    const relay = createIdentity();
    const phoneSide = startHandshake(phone, {
      macId: mac.id,
      macKey: mac.publicKey,
    });
    // The relay answers the phone itself, but it does not hold the Mac's
    // static key, so the keys it derives do not match the phone's.
    // Message 1 is already bound to the Mac's static key, so the relay
    // cannot even read the hello.
    expect(() =>
      acceptHandshake(
        { ...relay, id: mac.id },
        phone.publicKey,
        phoneSide.hello,
      ),
    ).toThrow();
  });

  test("an old device key without the ephemeral keys opens nothing", () => {
    const first = connect();
    const second = connect();
    const sealed = first.phoneChannel.seal(text("first session"));
    expect(() => second.macChannel.open(sealed)).toThrow();
  });
});

describe("frames", () => {
  test("relay frames carry the id and payload", () => {
    const frame = encodeRelayFrame("phone-1234", text("payload"));
    const decoded = decodeRelayFrame(frame);
    expect(decoded.deviceId).toBe("phone-1234");
    expect(new TextDecoder().decode(decoded.payload)).toBe("payload");
  });

  test("terminal output and messages decode", () => {
    const output = decodeSecurePlaintext(encodeTerminalOutput(7, text("ls")));
    expect(output).toEqual({ kind: "output", ch: 7, data: text("ls") });
    const message = decodeSecurePlaintext(
      encodeSecureMessage({ t: "event", name: "dataChanged" }),
    );
    expect(message).toEqual({
      kind: "message",
      message: { t: "event", name: "dataChanged" },
    });
  });
});

import { beforeAll, describe, expect, test } from "bun:test";
import {
  acceptHandshake,
  createIdentity,
  createPairingOffer,
  decodePairingOffer,
  encodePairingOffer,
  pairingProof,
  pairingUrl,
  sodiumReady,
  startHandshake,
  verifyPairingProof,
} from "./crypto";
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
  const phoneSide = startHandshake(phone, mac.publicKey);
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
    expect(verifyPairingProof(offer, phone, pairingProof(offer, phone))).toBe(
      true,
    );
  });

  test("a proof for another phone key or another code fails", () => {
    const mac = createIdentity();
    const phone = createIdentity();
    const intruder = createIdentity();
    const offer = createPairingOffer(mac, "wss://relay.example", "Mac");
    const proof = pairingProof(offer, phone);
    expect(
      verifyPairingProof(
        offer,
        { id: phone.id, publicKey: intruder.publicKey },
        proof,
      ),
    ).toBe(false);
    const otherOffer = createPairingOffer(mac, "wss://relay.example", "Mac");
    expect(verifyPairingProof(otherOffer, phone, proof)).toBe(false);
    expect(verifyPairingProof(offer, phone, "not-base64!")).toBe(false);
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

  test("anything but a pairing code is rejected", () => {
    expect(() => decodePairingOffer("https://example.com")).toThrow();
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
    const phoneSide = startHandshake(phone, mac.publicKey);
    // The relay answers the phone itself, but it does not hold the Mac's
    // static key, so the keys it derives do not match the phone's.
    const forged = acceptHandshake(relay, phone.publicKey, phoneSide.hello);
    const { channel, ready } = phoneSide.finish(forged.welcome);
    const relayChannel = forged.finish(ready);
    expect(() => channel.open(relayChannel.seal(text("fake")))).toThrow();
    expect(() => relayChannel.open(channel.seal(text("secret")))).toThrow();
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

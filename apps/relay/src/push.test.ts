// Runs under `bun test`; the relay's own tsconfig leaves tests out, since
// they use Bun's types rather than Cloudflare's.
import { expect, test } from "bun:test";
import { allowedEndpoint, vapidAuthorization } from "./push";

const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");

test("the VAPID header verifies with the public key it names", async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKey = b64(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateJwk = JSON.stringify(
    await crypto.subtle.exportKey("jwk", pair.privateKey),
  );
  const header = await vapidAuthorization(
    "https://fcm.googleapis.com/fcm/send/abc",
    { publicKey, privateJwk, subject: "https://relay.example" },
    Date.parse("2026-10-10T00:00:00Z"),
  );
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  expect(match?.[2]).toBe(publicKey);
  const [head, claims, signature] = match![1]!.split(".");
  expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
    aud: "https://fcm.googleapis.com",
    exp: Date.parse("2026-10-10T12:00:00Z") / 1000,
    sub: "https://relay.example",
  });
  const verifier = await crypto.subtle.importKey(
    "raw",
    Buffer.from(publicKey, "base64url"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifier,
      Buffer.from(signature!, "base64url"),
      new TextEncoder().encode(`${head}.${claims}`),
    ),
  ).toBe(true);
});

test("only known push services are accepted as endpoints", () => {
  expect(allowedEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
  expect(allowedEndpoint("https://web.push.apple.com/abc")).toBe(true);
  expect(allowedEndpoint("http://fcm.googleapis.com/fcm/send/x")).toBe(false);
  expect(allowedEndpoint("https://evil.example/fcm.googleapis.com")).toBe(
    false,
  );
  expect(allowedEndpoint("https://169.254.169.254/")).toBe(false);
  expect(allowedEndpoint("not a url")).toBe(false);
  expect(
    allowedEndpoint("http://127.0.0.1:9/push/1", "http://127.0.0.1:9/"),
  ).toBe(true);
});

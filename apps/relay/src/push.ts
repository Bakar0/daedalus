import { base64url } from "./util";

/**
 * Web Push without a payload. The phone's service worker shows a fixed line
 * ("A session on your Mac needs you"), so a push carries nothing to encrypt
 * and nothing the push service or the relay could read. All a push needs is
 * a VAPID signature (RFC 8292): an ES256 JWT naming the push service.
 */

/** Push services a phone's subscription may point at. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

/**
 * The relay posts to whatever endpoint a phone registered, so only known
 * push services are accepted. `extra` lets the local check use its own.
 */
export function allowedEndpoint(endpoint: string, extra?: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (extra && endpoint.startsWith(extra)) return true;
  return (
    url.protocol === "https:" &&
    PUSH_HOSTS.some((pattern) => pattern.test(url.hostname))
  );
}

const encodeJson = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

export interface VapidKeys {
  /** The uncompressed P-256 public key, base64url (65 bytes). */
  publicKey: string;
  /** The private key as a JWK, JSON. */
  privateJwk: string;
  /** `mailto:` or `https:` contact for the push service operator. */
  subject: string;
}

export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  now = Date.now(),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(keys.privateJwk) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const unsigned = `${encodeJson({ typ: "JWT", alg: "ES256" })}.${encodeJson({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: keys.subject,
  })}`;
  // WebCrypto's ECDSA signature is already r || s, the form JWS wants.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `vapid t=${unsigned}.${base64url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

/** Sends one empty push. `gone` means the subscription no longer exists. */
export async function sendPush(
  endpoint: string,
  keys: VapidKeys,
): Promise<{ ok: boolean; gone: boolean; status: number }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(endpoint, keys),
      TTL: "3600",
      Urgency: "high",
      Topic: "daedalus-attention",
      "Content-Length": "0",
    },
  });
  return {
    ok: response.ok,
    gone: response.status === 404 || response.status === 410,
    status: response.status,
  };
}

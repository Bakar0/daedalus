import { fromBase64, toBase64 } from "@daedalus/remote-protocol";
import { appLock, setAppLock, unlock } from "./storage";

/** WebAuthn wants bytes backed by a plain ArrayBuffer. */
const bytes = (text: string) => new Uint8Array(fromBase64(text));

/**
 * The app lock: a passkey on this phone, with user verification (Face ID,
 * a fingerprint or the screen lock), whose PRF extension returns a secret
 * that seals the device key and sign-in token (storage.ts). Without the
 * passkey, what the browser stores opens nothing. The relay never sees the
 * passkey; it is made for this page's host only.
 *
 * The app locks when it opens and after five minutes in the background.
 */

export const RELOCK_AFTER_MS = 5 * 60_000;

type PrfResults = {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
};

const prfInput = (salt: string) => ({
  prf: { eval: { first: bytes(salt) } },
});

async function secretFrom(
  credentialId: string,
  salt: string,
): Promise<Uint8Array> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: bytes(credentialId) }],
      userVerification: "required",
      extensions: prfInput(salt) as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const first = (
    assertion?.getClientExtensionResults() as PrfResults | undefined
  )?.prf?.results?.first;
  if (!first) throw new Error("This passkey cannot unlock the app.");
  return new Uint8Array(first);
}

/** Whether this browser can make passkeys at all. */
export const lockAvailable = (): boolean =>
  typeof PublicKeyCredential !== "undefined" && isSecureContext;

/**
 * Makes a passkey and seals the app under it. Throws when the browser or the
 * passkey provider has no PRF support, since then nothing could be sealed.
 */
export async function turnOnLock(): Promise<void> {
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: location.hostname, name: "Daedalus" },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "Daedalus on this phone",
        displayName: "Daedalus on this phone",
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      extensions: prfInput(salt) as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was made.");
  const results = credential.getClientExtensionResults() as PrfResults;
  if (!results.prf?.enabled)
    throw new Error(
      "This phone's passkeys cannot lock the app (no PRF support). Update the browser or the password manager.",
    );
  const credentialId = toBase64(new Uint8Array(credential.rawId));
  // Some providers return the PRF output only on a sign-in, not at creation.
  const first = results.prf.results?.first;
  const secret = first
    ? new Uint8Array(first)
    : await secretFrom(credentialId, salt);
  setAppLock({ credentialId, salt }, secret);
}

/** Asks for the passkey and opens the sealed key and token. */
export async function unlockApp(): Promise<void> {
  const lock = appLock();
  if (!lock) return;
  unlock(await secretFrom(lock.credentialId, lock.salt));
}

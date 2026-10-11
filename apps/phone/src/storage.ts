import {
  createIdentity,
  type DeviceIdentity,
  openAtRest,
  type PairedMac,
  sealAtRest,
} from "@daedalus/remote-protocol";

/**
 * What this phone remembers: its sign-in token, its device key, and the Macs
 * it paired with. Browser storage is per-site and stays on this phone. A
 * store app (Capacitor, later) moves the key and token to the Keychain or
 * Android Keystore.
 *
 * With the app lock on, the token and the key are sealed under a secret
 * only the phone's passkey gives back (lock.ts). Storage then holds the
 * sealed copy; the open one lives in this tab's memory while unlocked.
 *
 * Every access is guarded: a private window or blocked site data can make
 * storage throw, and the app then still works until the tab closes.
 */
interface Secrets {
  token?: string;
  identity?: DeviceIdentity;
}

interface Stored extends Secrets {
  macs?: PairedMac[];
  lock?: AppLock;
}

/** A passkey that unlocks the app, and what it unlocks. */
export interface AppLock {
  credentialId: string;
  /** The PRF input; the passkey turns it into the sealing secret. */
  salt: string;
  sealed: string;
}

const KEY = "daedalus.phone.v1";
const PENDING_PAIR = "daedalus.phone.pending-pair";
const SIGN_IN = "daedalus.phone.signin";
let memory: Stored = {};
/** While unlocked: the passkey's secret, to seal changes again. */
let lockSecret: Uint8Array | undefined;
let unlocked: Secrets | undefined;

function raw(): Stored {
  try {
    const text = localStorage.getItem(KEY);
    if (text) memory = JSON.parse(text) as Stored;
  } catch {
    // Storage unavailable; keep what this tab has.
  }
  return memory;
}

function read(): Stored {
  const stored = raw();
  return stored.lock ? { ...stored, ...unlocked } : stored;
}

function write(next: Stored): void {
  let toStore = next;
  if (next.lock) {
    if (!lockSecret) throw new Error("The app is locked");
    const { token, identity, ...rest } = next;
    unlocked = {
      ...(token ? { token } : {}),
      ...(identity ? { identity } : {}),
    };
    toStore = {
      ...rest,
      lock: {
        ...next.lock,
        sealed: sealAtRest(lockSecret, JSON.stringify(unlocked)),
      },
    };
  }
  memory = toStore;
  try {
    localStorage.setItem(KEY, JSON.stringify(toStore));
  } catch {
    // Storage unavailable; memory still holds it for this tab.
  }
}

/** The lock, if one is set; whether it is open is `isLocked`. */
export const appLock = (): AppLock | undefined => raw().lock;

export const isLocked = (): boolean => Boolean(raw().lock) && !unlocked;

/** Opens the sealed token and key with the passkey's secret. */
export function unlock(secret: Uint8Array): void {
  const lock = raw().lock;
  if (!lock) return;
  unlocked = JSON.parse(openAtRest(secret, lock.sealed)) as Secrets;
  lockSecret = secret;
}

/** Forgets the open copy; the passkey is needed again. */
export function relock(): void {
  unlocked = undefined;
  lockSecret = undefined;
}

/** Seals the token and key under a new passkey's secret. */
export function setAppLock(
  lock: Omit<AppLock, "sealed">,
  secret: Uint8Array,
): void {
  const current = read();
  lockSecret = secret;
  write({ ...current, lock: { ...lock, sealed: "" } });
}

/** Turns the lock off (while unlocked): the secrets are stored open again. */
export function removeAppLock(): void {
  const { lock: _lock, ...current } = read();
  relock();
  write(current);
}

/** For a lost passkey: everything on this phone is forgotten. */
export function forgetEverything(): void {
  relock();
  memory = {};
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}

export const storedToken = (): string | undefined => read().token;

export function setToken(token: string | undefined): void {
  const { token: _old, ...rest } = read();
  write(token ? { ...rest, token } : rest);
}

/** This phone's device key, made on first use. Call after `sodiumReady`. */
export function phoneIdentity(): DeviceIdentity {
  const stored = read();
  if (stored.identity) return stored.identity;
  const identity = createIdentity();
  write({ ...stored, identity });
  return identity;
}

export const pairedMacs = (): PairedMac[] => read().macs ?? [];

export function addMac(mac: PairedMac): void {
  const stored = read();
  write({
    ...stored,
    macs: [
      ...(stored.macs ?? []).filter((item) => item.macId !== mac.macId),
      mac,
    ],
  });
}

export function removeMac(macId: string): void {
  const stored = read();
  write({
    ...stored,
    macs: (stored.macs ?? []).filter((item) => item.macId !== macId),
  });
}

/**
 * A scanned pairing code waits here while the phone signs in, which leaves
 * the page for Google and comes back.
 */
export function pendingPair(): string | undefined {
  try {
    return sessionStorage.getItem(PENDING_PAIR) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setPendingPair(code: string | undefined): void {
  try {
    if (code) sessionStorage.setItem(PENDING_PAIR, code);
    else sessionStorage.removeItem(PENDING_PAIR);
  } catch {
    // Without storage the code is lost on the sign-in round trip; the user
    // scans it again.
  }
}

/**
 * A sign-in this tab started: a random nonce that goes out in the return
 * address and must come back with the token. Kept per tab, so a link opened
 * anywhere else cannot plant a token.
 */
export function startSignIn(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  try {
    sessionStorage.setItem(SIGN_IN, nonce);
  } catch {
    // Without storage the token cannot be accepted; the user sees the
    // sign-in page again.
  }
  return nonce;
}

export function signInNonce(): string | undefined {
  try {
    const nonce = sessionStorage.getItem(SIGN_IN) ?? undefined;
    sessionStorage.removeItem(SIGN_IN);
    return nonce;
  } catch {
    return undefined;
  }
}

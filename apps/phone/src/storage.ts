import {
  createIdentity,
  type DeviceIdentity,
  type PairedMac,
} from "@daedalus/remote-protocol";

/**
 * What this phone remembers: its sign-in token, its device key, and the Macs
 * it paired with. Browser storage is per-site and stays on this phone. A
 * store app (Capacitor, later) moves the key and token to the Keychain or
 * Android Keystore.
 *
 * Every access is guarded: a private window or blocked site data can make
 * storage throw, and the app then still works until the tab closes.
 */
interface Stored {
  token?: string;
  identity?: DeviceIdentity;
  macs?: PairedMac[];
}

const KEY = "daedalus.phone.v1";
const PENDING_PAIR = "daedalus.phone.pending-pair";
let memory: Stored = {};

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) memory = JSON.parse(raw) as Stored;
  } catch {
    // Storage unavailable; keep what this tab has.
  }
  return memory;
}

function write(next: Stored): void {
  memory = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable; memory still holds it for this tab.
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createIdentity,
  sodiumReady,
  type DeviceIdentity,
} from "@daedalus/remote-protocol";

/**
 * The runner's long-lived key pair, on the workspace volume so a sleep and
 * wake keeps it: the gateway refuses a different key for the same workspace.
 */
export async function loadOrCreateIdentity(
  stateDirectory: string,
): Promise<DeviceIdentity> {
  await sodiumReady();
  const file = join(stateDirectory, "identity.json");
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as DeviceIdentity;
    if (stored.id && stored.publicKey && stored.secretKey) return stored;
  } catch {
    // Missing or unreadable: make a new one.
  }
  const identity = createIdentity();
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
  return identity;
}

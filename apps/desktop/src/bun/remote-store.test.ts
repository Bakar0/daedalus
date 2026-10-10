import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceSecrets,
  RemoteAudit,
  RemoteStore,
  type SecretVault,
} from "./remote-store";
import { withoutTmuxPrefix } from "./remote";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "daedalus-remote-store-"));
  homes.push(home);
  return home;
}

class MemoryVault implements SecretVault {
  secrets: DeviceSecrets | undefined;
  failing = false;
  async read() {
    if (this.failing) throw new Error("locked");
    return this.secrets;
  }
  async write(secrets: DeviceSecrets) {
    if (this.failing) throw new Error("locked");
    this.secrets = secrets;
  }
}

const deviceFile = (home: string) => join(home, "remote", "device.json");

describe("RemoteStore", () => {
  test("keeps the key and relay credentials in the vault, not the file", async () => {
    const home = await newHome();
    const vault = new MemoryVault();
    const store = await RemoteStore.open(home, vault);
    await store.setRelayToken("device-token");
    const text = await Bun.file(deviceFile(home)).text();
    expect(text).not.toContain(store.identity.secretKey);
    expect(text).not.toContain("device-token");
    expect(text).not.toContain(vault.secrets!.relaySecret);
    expect(vault.secrets?.secretKey).toBe(store.identity.secretKey);

    const again = await RemoteStore.open(home, vault);
    expect(again.identity).toEqual(store.identity);
    expect(again.relayCredential).toBe("device-token");
  });

  test("moves secrets out of a file written before the vault", async () => {
    const home = await newHome();
    const old = await RemoteStore.open(home, null);
    await old.setRelayToken("old-token");
    expect(await Bun.file(deviceFile(home)).text()).toContain("old-token");

    const vault = new MemoryVault();
    const moved = await RemoteStore.open(home, vault);
    expect(moved.identity).toEqual(old.identity);
    expect(vault.secrets?.relayToken).toBe("old-token");
    expect(await Bun.file(deviceFile(home)).text()).not.toContain("old-token");
  });

  test("keeps working from the file when the vault fails", async () => {
    const home = await newHome();
    const vault = new MemoryVault();
    vault.failing = true;
    const store = await RemoteStore.open(home, vault);
    const again = await RemoteStore.open(home, vault);
    expect(again.identity).toEqual(store.identity);
  });

  test("the file is 0600 in a 0700 folder, with no temporary left", async () => {
    const home = await newHome();
    const store = await RemoteStore.open(home, null);
    await store.addPhone({
      id: "phone",
      publicKey: "key",
      name: "iPhone",
      pairedAt: "2026-10-10T00:00:00.000Z",
    });
    expect((await stat(deviceFile(home))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "remote"))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(home, "remote"))).toEqual(["device.json"]);
  });

  test("a broken file is set aside and the Mac starts over", async () => {
    const home = await newHome();
    await RemoteStore.open(home, null);
    await Bun.write(deviceFile(home), "{ cut sho");
    const store = await RemoteStore.open(home, null);
    expect(store.phones).toEqual([]);
    expect(await Bun.file(`${deviceFile(home)}.broken`).exists()).toBe(true);
  });

  test("starting over keeps the old file and makes a new identity", async () => {
    const home = await newHome();
    const store = await RemoteStore.open(home, null);
    const before = store.identity.id;
    await store.setRelayToken("token");
    await store.reset();
    expect(store.identity.id).not.toBe(before);
    expect(store.relayToken).toBeUndefined();
    expect(await Bun.file(`${deviceFile(home)}.removed`).text()).toContain(
      before,
    );
  });
});

describe("RemoteAudit", () => {
  test("records newest first and survives a reopen", async () => {
    const home = await newHome();
    await RemoteStore.open(home, null);
    const audit = new RemoteAudit(home);
    audit.record({
      phoneId: "p",
      phone: "iPhone",
      action: "agentSend",
      ok: true,
    });
    audit.record({
      phoneId: "p",
      phone: "iPhone",
      action: "workspaceDelete",
      ok: false,
      code: "VALIDATION",
    });
    await audit.recent();
    const reread = await new RemoteAudit(home).recent();
    expect(reread.map((entry) => entry.action)).toEqual([
      "workspaceDelete",
      "agentSend",
    ]);
    expect((await stat(join(home, "remote", "audit.log"))).mode & 0o777).toBe(
      0o600,
    );
  });
});

describe("withoutTmuxPrefix", () => {
  const input = (data: string) => JSON.stringify({ type: "input", data });

  test("drops Ctrl-B from phone input, so tmux's prompt is out of reach", () => {
    expect(JSON.parse(withoutTmuxPrefix(input("\u0002:run-shell x")))).toEqual({
      type: "input",
      data: ":run-shell x",
    });
  });

  test("leaves everything else alone", () => {
    const typed = input("ls -la\r");
    expect(withoutTmuxPrefix(typed)).toBe(typed);
    const resize = JSON.stringify({ type: "resize", cols: 80, rows: 24 });
    expect(withoutTmuxPrefix(resize)).toBe(resize);
    expect(withoutTmuxPrefix("not json \u0002")).toBe("not json \u0002");
  });
});

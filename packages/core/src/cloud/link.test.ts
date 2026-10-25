import { describe, expect, test } from "vitest";
import {
  createIdentity,
  decodePayload,
  decodeRelayFrame,
  decodeSecurePlaintext,
  encodePlain,
  encodeRelayFrame,
  encodeRunnerMessage,
  encodeSealed,
  encodeTerminalOutput,
  sodiumReady,
  startHandshake,
  type DeviceIdentity,
  type RunnerSecureMessage,
  type SecureChannel,
  type Welcome,
} from "@daedalus/remote-protocol";
import { CloudLink, type RelayCallbacks } from "./link";
import { RemoteSessionHost } from "./remote-session-host";

const WS = "11111111-1111-4111-8111-111111111111";

/** The gateway and one runner, as the Mac sees them. */
class FakeRelay {
  callbacks!: RelayCallbacks;
  readonly fromMac: Uint8Array[] = [];
  url = "";
  token = "";

  connect = (url: string, token: string, callbacks: RelayCallbacks) => {
    this.url = url;
    this.token = token;
    this.callbacks = callbacks;
    queueMicrotask(() => callbacks.open());
    return {
      send: (data: Uint8Array | string) => {
        if (typeof data !== "string") this.fromMac.push(data);
      },
      close: () => {},
    };
  };

  peer(online: boolean) {
    this.callbacks.text(
      JSON.stringify({ relay: "peer", deviceId: `ws:${WS}`, online }),
    );
  }

  fromRunner(payload: Uint8Array) {
    this.callbacks.binary(encodeRelayFrame(`ws:${WS}`, payload));
  }

  async next(): Promise<Uint8Array> {
    for (let i = 0; i < 200 && this.fromMac.length === 0; i++)
      await Bun.sleep(5);
    const frame = this.fromMac.shift();
    if (!frame) throw new Error("The Mac sent nothing");
    const { deviceId, payload } = decodeRelayFrame(frame);
    expect(deviceId).toBe(`ws:${WS}`);
    return payload;
  }
}

/** Runs the runner's side of the handshake; returns its channel. */
async function link(
  relay: FakeRelay,
  runner: DeviceIdentity,
  mac: DeviceIdentity,
): Promise<SecureChannel> {
  const started = startHandshake(runner, {
    macId: mac.id,
    macKey: mac.publicKey,
  });
  relay.fromRunner(encodePlain(started.hello));
  const welcome = decodePayload(await relay.next());
  if (welcome.kind !== "plain") throw new Error("Expected a welcome");
  const { channel, ready } = started.finish(welcome.message as Welcome);
  relay.fromRunner(encodePlain(ready));
  return channel;
}

const sealed = (channel: SecureChannel, message: RunnerSecureMessage) =>
  encodeSealed(channel.seal(encodeRunnerMessage(message)));

const open = (channel: SecureChannel, payload: Uint8Array) => {
  const decoded = decodePayload(payload);
  if (decoded.kind !== "sealed") throw new Error("Expected a sealed frame");
  const plain = decodeSecurePlaintext(channel.open(decoded.ciphertext));
  if (plain.kind !== "message") throw new Error("Expected a message");
  return plain.message as unknown as RunnerSecureMessage;
};

const setUp = async (
  runnerKey?: string,
  onWorkspaceSleeping?: (workspaceId: string) => void,
) => {
  await sodiumReady();
  const mac = createIdentity();
  const runner = createIdentity();
  const relay = new FakeRelay();
  const answered: unknown[] = [];
  const cloudLink = new CloudLink({
    gatewayUrl: "https://gateway.test:8443",
    token: "user-token",
    identity: mac,
    runnerKey: async () => runnerKey ?? runner.publicKey,
    answer: async (hostId, call) => {
      answered.push({ hostId, call });
      return { exitCode: 0, stdout: "answered\n", stderr: "" };
    },
    connect: relay.connect,
    requestTimeoutMs: 2_000,
    ...(onWorkspaceSleeping ? { onWorkspaceSleeping } : {}),
  });
  await cloudLink.start();
  await Bun.sleep(1);
  relay.peer(true);
  return { mac, runner, relay, cloudLink, answered };
};

describe("cloud link", () => {
  test("joins as the Mac with the user token", async () => {
    const { relay, mac, cloudLink } = await setUp();
    const url = new URL(relay.url);
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v1/connect");
    expect(url.searchParams.get("macId")).toBe(mac.id);
    expect(relay.token).toBe("user-token");
    cloudLink.stop();
  });

  test("a runner about to sleep its workspace says so to the Mac", async () => {
    const sleeping: string[] = [];
    const { relay, mac, runner, cloudLink } = await setUp(undefined, (id) =>
      sleeping.push(id),
    );
    const channel = await link(relay, runner, mac);
    await Bun.sleep(5);
    relay.fromRunner(sealed(channel, { t: "workspace.sleeping" }));
    await Bun.sleep(5);
    expect(sleeping).toEqual([WS]);
    cloudLink.stop();
  });

  test("answers the runner's handshake and carries runner methods", async () => {
    const { relay, mac, runner, cloudLink } = await setUp();
    const channel = await link(relay, runner, mac);
    await Bun.sleep(5);
    expect(cloudLink.linked(WS)).toBe(true);
    const host = new RemoteSessionHost(WS, cloudLink);
    const live = host.listLive();
    const request = open(channel, await relay.next());
    expect(request).toMatchObject({ t: "req", method: "host.listLive" });
    relay.fromRunner(
      sealed(channel, {
        t: "res",
        id: (request as { id: number }).id,
        result: ["daedalus_x"],
      }),
    );
    expect(await live).toEqual(["daedalus_x"]);
    cloudLink.stop();
  });

  test("answers daedal.call from the runner", async () => {
    const { relay, mac, runner, cloudLink, answered } = await setUp();
    const channel = await link(relay, runner, mac);
    const call = {
      callId: "c1",
      argv: ["team", "list"],
      cwd: ".",
      env: {},
      queueable: false,
      at: new Date().toISOString(),
    };
    relay.fromRunner(
      sealed(channel, { t: "req", id: 9, method: "daedal.call", params: call }),
    );
    expect(open(channel, await relay.next())).toEqual({
      t: "res",
      id: 9,
      result: { exitCode: 0, stdout: "answered\n", stderr: "" },
    });
    expect(answered).toEqual([{ hostId: `ws:${WS}`, call }]);
    cloudLink.stop();
  });

  test("refuses a runner whose key is not the pinned one", async () => {
    await sodiumReady();
    const impostor = createIdentity();
    const { relay, mac, runner, cloudLink } = await setUp(impostor.publicKey);
    await expect(link(relay, runner, mac)).rejects.toThrow();
    await Bun.sleep(5);
    expect(cloudLink.linked(WS)).toBe(false);
    await expect(
      new RemoteSessionHost(WS, cloudLink).listLive(),
    ).rejects.toMatchObject({ code: "DEPENDENCY" });
    cloudLink.stop();
  });

  test("opens a terminal and passes output until the runner ends it", async () => {
    const { relay, mac, runner, cloudLink } = await setUp();
    const channel = await link(relay, runner, mac);
    await Bun.sleep(5);
    const output: number[] = [];
    const terminal = await new RemoteSessionHost(WS, cloudLink).openTerminal(
      "daedalus_x",
      { cols: 100, rows: 30 },
      (data) => output.push(...data),
    );
    const ended = terminal.start();
    const opened = open(channel, await relay.next());
    expect(opened).toMatchObject({
      t: "term.open",
      session: "daedalus_x",
      cols: 100,
      rows: 30,
    });
    const ch = (opened as { ch: number }).ch;
    relay.fromRunner(
      encodeSealed(
        channel.seal(encodeTerminalOutput(ch, new Uint8Array([104, 105]))),
      ),
    );
    terminal.write("ls\r");
    expect(open(channel, await relay.next())).toEqual({
      t: "term.client",
      ch,
      message: { type: "input", data: "ls\r" },
    });
    relay.fromRunner(
      sealed(channel, {
        t: "term.server",
        ch,
        message: { type: "status", status: "exited", agentId: "daedalus_x" },
      }),
    );
    await ended;
    expect(output).toEqual([104, 105]);
    cloudLink.stop();
  });

  test("a hello that does not finish leaves the live channel alone", async () => {
    const { relay, mac, runner, cloudLink } = await setUp();
    const channel = await link(relay, runner, mac);
    await Bun.sleep(5);
    // An impostor's hello fails at once; a replayed one gets a welcome
    // but never a ready.
    const impostor = createIdentity();
    relay.fromRunner(
      encodePlain(
        startHandshake(impostor, { macId: mac.id, macKey: mac.publicKey })
          .hello,
      ),
    );
    relay.fromRunner(
      encodePlain(
        startHandshake(runner, { macId: mac.id, macKey: mac.publicKey }).hello,
      ),
    );
    await relay.next();
    await Bun.sleep(5);
    expect(cloudLink.linked(WS)).toBe(true);
    const live = new RemoteSessionHost(WS, cloudLink).listLive();
    const request = open(channel, await relay.next());
    relay.fromRunner(
      sealed(channel, {
        t: "res",
        id: (request as { id: number }).id,
        result: [],
      }),
    );
    expect(await live).toEqual([]);
    cloudLink.stop();
  });

  test("a completed new handshake replaces the channel", async () => {
    const { relay, mac, runner, cloudLink } = await setUp();
    await link(relay, runner, mac);
    const second = await link(relay, runner, mac);
    await Bun.sleep(5);
    const live = new RemoteSessionHost(WS, cloudLink).listLive();
    const request = open(second, await relay.next());
    relay.fromRunner(
      sealed(second, {
        t: "res",
        id: (request as { id: number }).id,
        result: ["s"],
      }),
    );
    expect(await live).toEqual(["s"]);
    cloudLink.stop();
  });

  test("fails pending requests when the runner goes away", async () => {
    const { relay, mac, runner, cloudLink } = await setUp();
    await link(relay, runner, mac);
    await Bun.sleep(5);
    const pending = new RemoteSessionHost(WS, cloudLink).isLive("x");
    await relay.next();
    relay.peer(false);
    await expect(pending).rejects.toMatchObject({ code: "DEPENDENCY" });
    expect(await cloudLink.unavailable(WS)).toContain("offline");
    cloudLink.stop();
  });
});

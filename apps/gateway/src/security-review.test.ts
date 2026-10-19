import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeRelayFrame, encodeRelayFrame } from "@daedalus/remote-protocol";
import { loadConfig } from "./config";
import { Controller } from "./controller";
import { FakeKube } from "./fake-kube";
import { Relay, type Peer, type PeerSocket } from "./relay";
import { createGateway } from "./server";
import { Store } from "./store";

/**
 * Security review of cloud sessions stage 0; the ids name findings in
 * artifacts/cloud-sessions/security-review.md. `test.failing` passes while
 * the weakness is there; when it is fixed, it fails and should become a
 * plain `test`.
 */

const WS = "0f8e2c1a-7b3d-4e5f-9a6b-1c2d3e4f5a6b";
const key = (fill: number) => Buffer.alloc(32, fill).toString("base64url");

let dir: string;
let kube: FakeKube;
let store: Store;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gateway-review-"));
  kube = new FakeKube();
  const config = loadConfig({
    DAEDALUS_GATEWAY_DEV_LOGIN: "true",
    DAEDALUS_GATEWAY_INTERNAL_URL: "http://daedalus-gateway.daedalus:8080",
    DAEDALUS_GATEWAY_NAMESPACE: "daedalus",
  });
  config.dbPath = join(dir, "gateway.sqlite");
  store = new Store(config.dbPath);
  const gateway = createGateway({
    config,
    store,
    controller: new Controller(kube, config, []),
    relay: new Relay(),
    log: () => {},
  });
  server = Bun.serve({ ...gateway, port: 0 });
  base = `http://localhost:${server.port}`;
});

afterEach(async () => {
  await server.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login(email: string): Promise<string> {
  const response = await fetch(`${base}/v1/dev/login`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return ((await response.json()) as { token: string }).token;
}

describe("security review: gateway", () => {
  test.failing(
    "L-8: a workspace cannot ask for zero CPU and memory (no limit at all)",
    async () => {
      const token = await login("alice@example.com");
      const response = await fetch(`${base}/v1/workspaces`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: WS,
          name: "zero",
          macId: "macAAAAAAAAAAAAAAAAAAA",
          macKey: key(1),
          resources: { cpu: "0", memory: "0" },
        }),
      });
      // Today: 201, and the pod gets limits of 0, which Kubernetes reads as
      // "no limit" (QoS BestEffort; memory.max is "max" in the pod).
      expect(response.status).toBe(400);
    },
  );
});

/** A socket the relay can hold, recording what it is sent. */
function fakeSocket(data: Peer) {
  const sent: (string | Uint8Array)[] = [];
  const socket = {
    data,
    send: (message: string | Uint8Array) => sent.push(message),
    close: () => {},
  } as unknown as PeerSocket;
  return { socket, sent };
}

describe("security review: relay", () => {
  test.failing(
    "L-1: a runner reaches only the Mac its workspace was made from",
    () => {
      const relay = new Relay();
      const user = "u1";
      const ownMac = fakeSocket({
        role: "mac",
        userId: user,
        deviceId: "mac:own",
      });
      const otherMac = fakeSocket({
        role: "mac",
        userId: user,
        deviceId: "mac:other",
      });
      const runner = fakeSocket({
        role: "runner",
        userId: user,
        deviceId: `ws:${WS}`,
        workspaceId: WS,
        macDeviceId: "mac:own",
      });
      for (const peer of [ownMac, otherMac, runner]) relay.open(peer.socket);
      otherMac.sent.length = 0;
      relay.message(
        runner.socket,
        Buffer.from(encodeRelayFrame("mac:other", new Uint8Array([7]))),
      );
      const frames = otherMac.sent.filter(
        (item): item is Uint8Array => typeof item !== "string",
      );
      // Today the frame arrives, from `ws:<id>`.
      expect(frames.map((frame) => decodeRelayFrame(frame).deviceId)).toEqual(
        [],
      );
    },
  );
});

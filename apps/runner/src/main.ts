import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_ENV, RUNNER_PATHS } from "@daedalus/remote-protocol";
import { loadOrCreateIdentity } from "./identity";
import { EventQueue } from "./queue";
import { Runner, type ConnectRelay } from "./runner";
import { SessiondClient } from "./sessiond-client";
import { socketPath } from "./shim-protocol";
import { listenForShim, prepareShimSocket } from "./shim-server";

// The entry point of the runner container (uid 1000). It runs no tmux and no
// workspace command and does not mount /workspace: the session container's
// `sessiond` does that work (artifacts/cloud-sessions/h1-pod-spec.md).
const VERSION = "0.1.0";

const log = (message: string): void => {
  console.log(`[runner] ${message}`);
};

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`[runner] ${name} is not set`);
    process.exit(1);
  }
  return value as string;
};

const connectRelay: ConnectRelay = (url, token, callbacks) => {
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  } as never);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => callbacks.open();
  socket.onmessage = (event) => {
    if (typeof event.data === "string") callbacks.text(event.data);
    else callbacks.binary(new Uint8Array(event.data as ArrayBuffer));
  };
  socket.onclose = () => callbacks.close();
  socket.onerror = () => {};
  return {
    send: (data) => socket.send(data as Uint8Array<ArrayBuffer>),
    close: () => socket.close(),
  };
};

/** The token is a file the gateway rotates on wake, so it is read each time. */
const readToken = (): string => {
  const token = readFileSync(RUNNER_PATHS.token, "utf8").trim();
  if (!token) throw new Error("the token file is empty");
  return token;
};

async function main(): Promise<void> {
  const gatewayUrl = required(RUNNER_ENV.gatewayUrl);
  const workspaceId = required(RUNNER_ENV.workspaceId);
  const macId = required(RUNNER_ENV.macId);
  const macKey = required(RUNNER_ENV.macKey);
  const idleMinutes = Number(process.env[RUNNER_ENV.idleMinutes] ?? 30);

  mkdirSync(RUNNER_PATHS.state, { recursive: true, mode: 0o700 });
  const identity = await loadOrCreateIdentity(RUNNER_PATHS.state);

  const runner = new Runner({
    gatewayUrl,
    readToken,
    workspaceId,
    macId,
    macKey,
    identity,
    backend: new SessiondClient(RUNNER_PATHS.sessionSocket),
    queue: new EventQueue(join(RUNNER_PATHS.state, "queue.jsonl")),
    connect: connectRelay,
    idleMinutes: Number.isFinite(idleMinutes) ? idleMinutes : 30,
    log,
  });

  const path = socketPath();
  prepareShimSocket(path);
  listenForShim(path, (call) => runner.daedalCall(call));
  // Any uid in the pod may call `daedal`; sessions run as another uid.
  chmodSync(path, 0o666);

  // Both daemons are PID 1 in their container, and the kernel drops signals for
  // PID 1 unless it has a handler, so without these a sleep waits out the grace
  // period and then kills the pod.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log(`${signal} received, exiting`);
      process.exit(0);
    });
  }

  runner.start();
  setInterval(() => void runner.tick(), 2000);
  log(`runner ${VERSION} for workspace ${workspaceId} started`);
}

await main();

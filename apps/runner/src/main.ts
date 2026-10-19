import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CommandTmuxClient, findTmuxExecutable } from "@daedalus/platform";
import {
  RUNNER_ENV,
  RUNNER_PATHS,
  type CommandResult,
} from "@daedalus/remote-protocol";
import { createHandlers } from "./handlers";
import { loadOrCreateIdentity } from "./identity";
import { EventQueue } from "./queue";
import { Runner, tmuxTerminals, type ConnectRelay } from "./runner";
import { socketPath, type ShimRequest } from "./shim-protocol";

const VERSION = "0.1.0";
const TMUX_SOCKET = "daedalus";
const TICK_MS = 2000;

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

async function main(): Promise<void> {
  const gatewayUrl = required(RUNNER_ENV.gatewayUrl);
  const token = required(RUNNER_ENV.runnerToken);
  const workspaceId = required(RUNNER_ENV.workspaceId);
  const macId = required(RUNNER_ENV.macId);
  const macKey = required(RUNNER_ENV.macKey);
  const idleMinutes = Number(process.env[RUNNER_ENV.idleMinutes] ?? 30);
  // Sessions and commands inherit this process's environment, so the token
  // and keys leave it before anything is started.
  for (const name of Object.values(RUNNER_ENV)) delete process.env[name];

  mkdirSync(RUNNER_PATHS.state, { recursive: true, mode: 0o700 });
  const home = join(RUNNER_PATHS.workspace, ".home");
  mkdirSync(home, { recursive: true });
  const identity = await loadOrCreateIdentity(RUNNER_PATHS.state);

  const tmuxPath = findTmuxExecutable();
  const tmux = new CommandTmuxClient(
    TMUX_SOCKET,
    tmuxPath,
    undefined,
    RUNNER_PATHS.workspace,
  );
  const baseEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
  };
  let runner: Runner | undefined;
  const handlers = createHandlers({
    root: RUNNER_PATHS.workspace,
    tmux,
    version: VERSION,
    baseEnv,
    onSessionStarted: (session) => runner?.watchSession(session),
  });
  runner = new Runner({
    gatewayUrl,
    token,
    workspaceId,
    macId,
    macKey,
    identity,
    handlers,
    queue: new EventQueue(join(RUNNER_PATHS.state, "queue.jsonl")),
    tmux,
    openTerminal: tmuxTerminals(TMUX_SOCKET),
    connect: connectRelay,
    idleMinutes: Number.isFinite(idleMinutes) ? idleMinutes : 30,
    log,
  });

  const path = socketPath();
  if (existsSync(path)) rmSync(path);
  const calls = runner;
  Bun.listen<{ buffer: string }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { buffer: "" };
      },
      async data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        let result: CommandResult;
        try {
          const request = JSON.parse(socket.data.buffer) as ShimRequest;
          result = await calls.daedalCall({
            callId: crypto.randomUUID(),
            argv: request.argv,
            cwd: request.cwd,
            env: request.env,
            ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
            queueable: request.queueable,
            at: new Date().toISOString(),
          });
        } catch (error) {
          result = {
            exitCode: 1,
            stdout: "",
            stderr: `${(error as Error).message}\n`,
          };
        }
        socket.write(`${JSON.stringify(result)}\n`);
        socket.end();
      },
    },
  });

  runner.start();
  setInterval(() => void runner.tick(), TICK_MS);
  log(`runner ${VERSION} for workspace ${workspaceId} started`);
}

await main();

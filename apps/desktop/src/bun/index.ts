import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  PATHS,
} from "electrobun/main";
import { createApplicationContext } from "@daedalus/core";
import {
  captureTmuxPane,
  CommandTmuxClient,
  ensureDirectory,
  pathExists,
  resizeTmuxPane,
  sendTmuxInput,
  TmuxControlBridge,
} from "@daedalus/platform";
import type {
  DesktopRpcSchema,
  TerminalServerMessage,
} from "@daedalus/protocol";
import { APPLICATION_MENU } from "./menu";
import { createDesktopRequestHandlers, desktopDataFingerprint } from "./rpc";
import { authorizeTerminalRequest, TerminalConnection } from "./terminal";

interface SocketData {
  initialSize?: { cols: number; rows: number };
  targetId: string;
  targetKind: "agent" | "integrated";
}

const context = await createApplicationContext(
  resolve(PATHS.RESOURCES_FOLDER, "app/migrations"),
);
const cliEntrypoint = resolve(PATHS.RESOURCES_FOLDER, "app/cli/daedal.js");
if (await pathExists(cliEntrypoint)) {
  const binDirectory = join(context.config.home, "bin");
  const cliShim = join(binDirectory, "daedal");
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  await ensureDirectory(binDirectory);
  await writeFile(
    cliShim,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliEntrypoint)} "$@"\n`,
    "utf8",
  );
  await chmod(cliShim, 0o755);
}
const terminalTmux = context.tmux;
if (!(terminalTmux instanceof CommandTmuxClient))
  throw new Error("Desktop terminal requires the command tmux adapter");
const terminalTarget = (session: string) => ({
  socketName: terminalTmux.socketName,
  session,
});
const preexistingLiveIds = new Set([
  ...context.repositories
    .listAgents()
    .filter(
      (agent) => agent.status === "running" || agent.status === "starting",
    )
    .map((agent) => `agent:${agent.id}`),
  ...context.repositories
    .listIntegratedTerminals()
    .filter(
      (terminal) =>
        terminal.status === "running" || terminal.status === "starting",
    )
    .map((terminal) => `integrated:${terminal.id}`),
]);
const connections = new Map<
  Bun.ServerWebSocket<SocketData>,
  TerminalConnection
>();

const token = randomBytes(24).toString("hex");
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const target = authorizeTerminalRequest(request, token);
    if (!target) {
      return new Response("Not found", { status: 404 });
    }
    return server.upgrade(request, {
      data: {
        initialSize: target.initialSize,
        targetId: target.id,
        targetKind: target.kind,
      },
    })
      ? undefined
      : new Response("WebSocket upgrade failed", { status: 400 });
  },
  websocket: {
    async open(socket) {
      try {
        const target =
          socket.data.targetKind === "agent"
            ? await context.agents.get(socket.data.targetId)
            : await context.terminals.get(socket.data.targetId);
        if (target.status !== "running" && target.status !== "starting") {
          const status: TerminalServerMessage = {
            type: "status",
            status: target.status,
            agentId: target.id,
          };
          socket.send(JSON.stringify(status));
          socket.close();
          return;
        }
        const tmuxTarget = terminalTarget(target.tmuxSession);
        const connection = new TerminalConnection({
          agentId: target.id,
          socket,
          status: preexistingLiveIds.has(
            `${socket.data.targetKind}:${target.id}`,
          )
            ? "reconnected"
            : "live",
          capture: () =>
            captureTmuxPane(tmuxTarget, undefined, terminalTmux.executable),
          prepareCapture: socket.data.initialSize
            ? () =>
                resizeTmuxPane(
                  tmuxTarget,
                  socket.data.initialSize!.cols,
                  socket.data.initialSize!.rows,
                  terminalTmux.executable,
                )
            : undefined,
          sendInput: (data) =>
            sendTmuxInput(tmuxTarget, data, terminalTmux.executable),
          createBridge: (onOutput) =>
            new TmuxControlBridge(
              onOutput,
              tmuxTarget,
              terminalTmux.executable,
            ),
          onError: (error) =>
            void context.logger.write("error", "terminal_connection_failed", {
              targetId: target.id,
              targetKind: socket.data.targetKind,
              message: error instanceof Error ? error.message : String(error),
            }),
        });
        connections.set(socket, connection);
        await connection.start();
      } catch (error) {
        const unavailable: TerminalServerMessage = {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        };
        socket.send(JSON.stringify(unavailable));
        socket.close();
      }
    },
    close(socket) {
      connections.get(socket)?.close();
      connections.delete(socket);
    },
    message(socket, payload) {
      void connections.get(socket)?.message(payload);
    },
  },
});

const terminalEndpoint = `ws://127.0.0.1:${server.port}/terminal?token=${token}`;
const rendererUrl = `views://mainview/index.html?terminal=${encodeURIComponent(terminalEndpoint)}`;

// WebKit text controls use the native responder chain for standard editing
// commands on macOS. Defining these roles restores Cmd+C/V/X/A/Z everywhere.
ApplicationMenu.setApplicationMenu(APPLICATION_MENU);

let revision = 0;
let fingerprint = desktopDataFingerprint(context);

function announce(source: "desktop" | "external"): void {
  fingerprint = desktopDataFingerprint(context);
  rpc.send.dataChanged({ revision: ++revision, source });
}

const rpc = BrowserView.defineRPC<DesktopRpcSchema>({
  // Initial repository clones and fetches can legitimately take several
  // minutes for large histories or slower remotes.
  maxRequestTime: 10 * 60_000,
  handlers: {
    requests: createDesktopRequestHandlers(context, () => announce("desktop")),
  },
});

new BrowserWindow({
  title: "Daedalus",
  url: rendererUrl,
  rpc,
  frame: { width: 1380, height: 820, x: 80, y: 80 },
});

let checkingForExternalChanges = false;
setInterval(async () => {
  if (checkingForExternalChanges) return;
  checkingForExternalChanges = true;
  try {
    // Reconciliation updates stale sessions; SQLite fingerprinting also catches
    // mutations performed by another process such as the CLI.
    await Promise.all([
      context.agents.reconcile(),
      context.terminals.reconcile(),
    ]);
    for (const [socket, connection] of connections) {
      const target =
        socket.data.targetKind === "agent"
          ? context.repositories.findAgent(socket.data.targetId)
          : context.repositories.findIntegratedTerminal(socket.data.targetId);
      if (
        !target ||
        (target.status !== "running" && target.status !== "starting")
      ) {
        connection.end(target?.status === "lost" ? "lost" : "exited");
        connections.delete(socket);
      }
    }
    const next = desktopDataFingerprint(context);
    if (next !== fingerprint) announce("external");
  } catch (error) {
    await context.logger.write("error", "desktop_change_check_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    checkingForExternalChanges = false;
  }
}, 1_200);

await context.logger.write("info", "desktop_started", {
  terminalTransport: "loopback_websocket",
  reconnectableSessions: preexistingLiveIds.size,
});

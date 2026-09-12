import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
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
  agentId: string;
}

const context = await createApplicationContext(
  resolve(PATHS.RESOURCES_FOLDER, "app/migrations"),
);
const terminalTmux = context.tmux;
if (!(terminalTmux instanceof CommandTmuxClient))
  throw new Error("Desktop terminal requires the command tmux adapter");
const terminalTarget = (session: string) => ({
  socketName: terminalTmux.socketName,
  session,
});
const preexistingLiveIds = new Set(
  context.repositories
    .listAgents()
    .filter(
      (agent) => agent.status === "running" || agent.status === "starting",
    )
    .map((agent) => agent.id),
);
const connections = new Map<
  Bun.ServerWebSocket<SocketData>,
  TerminalConnection
>();

const token = randomBytes(24).toString("hex");
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const agentId = authorizeTerminalRequest(request, token);
    if (!agentId) {
      return new Response("Not found", { status: 404 });
    }
    return server.upgrade(request, { data: { agentId } })
      ? undefined
      : new Response("WebSocket upgrade failed", { status: 400 });
  },
  websocket: {
    async open(socket) {
      try {
        const agent = await context.agents.get(socket.data.agentId);
        if (agent.status !== "running" && agent.status !== "starting") {
          const status: TerminalServerMessage = {
            type: "status",
            status: agent.status,
            agentId: agent.id,
          };
          socket.send(JSON.stringify(status));
          socket.close();
          return;
        }
        const target = terminalTarget(agent.tmuxSession);
        const connection = new TerminalConnection({
          agentId: agent.id,
          socket,
          status: preexistingLiveIds.has(agent.id) ? "reconnected" : "live",
          capture: () =>
            captureTmuxPane(target, undefined, terminalTmux.executable),
          sendInput: (data) =>
            sendTmuxInput(target, data, terminalTmux.executable),
          createBridge: (onOutput) =>
            new TmuxControlBridge(onOutput, target, terminalTmux.executable),
          onError: (error) =>
            void context.logger.write("error", "terminal_connection_failed", {
              agentId: agent.id,
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
  maxRequestTime: 30_000,
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
    await context.agents.reconcile();
    for (const [socket, connection] of connections) {
      const agent = context.repositories.findAgent(socket.data.agentId);
      if (
        !agent ||
        (agent.status !== "running" && agent.status !== "starting")
      ) {
        connection.end(agent?.status === "lost" ? "lost" : "exited");
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

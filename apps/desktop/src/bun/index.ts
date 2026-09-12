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
  captureSpikePane,
  ensureSpikeSession,
  sendSpikeInput,
  TmuxControlBridge,
} from "@daedalus/platform";
import type {
  DesktopRpcSchema,
  TerminalClientMessage,
  TerminalServerMessage,
} from "@daedalus/protocol";
import { APPLICATION_MENU } from "./menu";
import { createDesktopRequestHandlers, desktopDataFingerprint } from "./rpc";

interface SocketData {
  authenticated: true;
}

const context = await createApplicationContext(
  resolve(PATHS.RESOURCES_FOLDER, "app/migrations"),
);
let spikeError: string | undefined;
let reconnected = false;
try {
  reconnected = !(await ensureSpikeSession(context.config.workspaceRoot));
} catch (error) {
  spikeError = error instanceof Error ? error.message : String(error);
}
const clients = new Set<Bun.ServerWebSocket<SocketData>>();
const bridge = spikeError
  ? undefined
  : new TmuxControlBridge((output) => {
      for (const client of clients) client.send(output);
    });
if (bridge) void bridge.start();

const token = randomBytes(24).toString("hex");
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const url = new URL(request.url);
    if (
      url.pathname !== "/terminal" ||
      url.searchParams.get("token") !== token
    ) {
      return new Response("Not found", { status: 404 });
    }
    return server.upgrade(request, { data: { authenticated: true } })
      ? undefined
      : new Response("WebSocket upgrade failed", { status: 400 });
  },
  websocket: {
    async open(socket) {
      clients.add(socket);
      if (spikeError) {
        const unavailable: TerminalServerMessage = {
          type: "error",
          message: spikeError,
        };
        socket.send(JSON.stringify(unavailable));
        return;
      }
      const status: TerminalServerMessage = {
        type: "status",
        status: reconnected ? "reconnected" : "connected",
      };
      socket.send(JSON.stringify(status));
      socket.send(await captureSpikePane());
    },
    close(socket) {
      clients.delete(socket);
    },
    async message(socket, payload) {
      try {
        if (typeof payload !== "string") return;
        const message = JSON.parse(payload) as TerminalClientMessage;
        if (message.type === "input") await sendSpikeInput(message.data);
        if (message.type === "resize")
          bridge?.resize(message.cols, message.rows);
      } catch (error) {
        const response: TerminalServerMessage = {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        };
        socket.send(JSON.stringify(response));
      }
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
  frame: { width: 1100, height: 760, x: 120, y: 100 },
});

let checkingForExternalChanges = false;
setInterval(async () => {
  if (checkingForExternalChanges) return;
  checkingForExternalChanges = true;
  try {
    // Reconciliation updates stale sessions; SQLite fingerprinting also catches
    // mutations performed by another process such as the CLI.
    await context.agents.reconcile();
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
  tmuxReconnected: reconnected,
  spikeError,
});

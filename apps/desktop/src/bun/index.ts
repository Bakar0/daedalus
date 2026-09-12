import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { BrowserWindow, PATHS } from "electrobun/main";
import { createApplicationContext } from "@daedalus/core";
import {
  captureSpikePane,
  ensureSpikeSession,
  sendSpikeInput,
  TmuxControlBridge,
} from "@daedalus/platform";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@daedalus/protocol";

interface SocketData {
  authenticated: true;
}

const context = await createApplicationContext(
  resolve(PATHS.RESOURCES_FOLDER, "app/migrations"),
);
const reconnected = !(await ensureSpikeSession(context.config.workspaceRoot));
const clients = new Set<Bun.ServerWebSocket<SocketData>>();
const bridge = new TmuxControlBridge((output) => {
  for (const client of clients) client.send(output);
});
void bridge.start();

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
          bridge.resize(message.cols, message.rows);
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

new BrowserWindow({
  title: "Daedalus — Terminal Spike",
  url: rendererUrl,
  frame: { width: 1100, height: 760, x: 120, y: 100 },
});

await context.logger.write("info", "desktop_started", {
  terminalTransport: "loopback_websocket",
  tmuxReconnected: reconnected,
});

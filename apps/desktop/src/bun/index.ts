import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  PATHS,
  Utils,
} from "electrobun/main";
import { createApplicationContext } from "@daedalus/core";
import {
  CommandTmuxClient,
  findExecutable,
  pathExists,
  TmuxPtyBridge,
} from "@daedalus/platform";
import type {
  DesktopCommand,
  DesktopRpcSchema,
  TerminalServerMessage,
} from "@daedalus/protocol";
import { isDesktopCommand } from "@daedalus/protocol";
import { APPLICATION_MENU } from "./menu";
import { installCliShim } from "./cli-shim";
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
const bunExecutable = findExecutable("bun", [
  "/opt/homebrew/bin/bun",
  "/usr/local/bin/bun",
]);
if ((await pathExists(cliEntrypoint)) && bunExecutable)
  await installCliShim({
    path: join(context.config.home, "bin", "daedal"),
    bunExecutable,
    cliEntrypoint,
  });
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
          createBridge: (onOutput) =>
            new TmuxPtyBridge(
              onOutput,
              tmuxTarget,
              socket.data.initialSize,
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
const nativeStatusProbePath = process.env.DAEDALUS_STATUS_PROBE_PATH;
const rendererUrl = `views://mainview/index.html?build=${Date.now()}&terminal=${encodeURIComponent(terminalEndpoint)}`;

// WebKit text controls use the native responder chain for standard editing
// commands on macOS. Defining these roles restores Cmd+C/V/X/A/Z everywhere.
ApplicationMenu.setApplicationMenu(APPLICATION_MENU);

let revision = 0;
let fingerprint = desktopDataFingerprint(context);
let telemetryFingerprint = "";

function announce(source: "desktop" | "external"): void {
  fingerprint = desktopDataFingerprint(context);
  rpc.send.dataChanged({ revision: ++revision, source });
}

const rpc = BrowserView.defineRPC<DesktopRpcSchema>({
  // Initial repository clones and fetches can legitimately take several
  // minutes for large histories or slower remotes.
  maxRequestTime: 10 * 60_000,
  handlers: {
    requests: createDesktopRequestHandlers(
      context,
      () => announce("desktop"),
      Utils.openExternal,
    ),
  },
});

ApplicationMenu.on("application-menu-clicked", (rawEvent) => {
  const event = rawEvent as { data?: { action?: unknown } };
  const command = event.data?.action;
  if (isDesktopCommand(command))
    rpc.send.command({ command: command satisfies DesktopCommand });
});

const mainWindow = new BrowserWindow({
  title: "Daedalus",
  url: rendererUrl,
  rpc,
  frame: { width: 1380, height: 820, x: 80, y: 80 },
  hidden: Boolean(nativeStatusProbePath),
  activate: !nativeStatusProbePath,
});

if (nativeStatusProbePath) {
  let probeStarted = false;
  mainWindow.webview.on("dom-ready", () => {
    if (probeStarted) return;
    probeStarted = true;
    void (async () => {
      try {
        const script = `return (async () => {
            const waitFor = async (read, attempts = 200) => {
              for (let attempt = 0; attempt < attempts; attempt += 1) {
                const value = read();
                if (value) return value;
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
            };
            const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
            const sessionsButton = await waitFor(() => document.querySelector(".app-mode-switcher button:nth-child(2)"));
            sessionsButton?.click();
            const claudeSession = await waitFor(() => document.querySelector('.session-card-main[data-provider="claude"]'));
            claudeSession?.click();
            await waitFor(() => text(".agent-session-context"));
            return {
              url: location.href,
              selectedSessionId: claudeSession?.dataset.sessionId ?? null,
              heading: text(".terminal-heading h1"),
              headingModel: text(".terminal-heading-model"),
              status: text(".agent-session-status-primary"),
              statusModel: text(".agent-session-status-model"),
              context: text(".agent-session-context"),
              usage: text(".provider-usage"),
              codexUsage: text('.provider-usage-item[data-provider="codex"]'),
              claudeUsage: text('.provider-usage-item[data-provider="claude"]'),
            };
          })()`;
        let result: unknown;
        let lastError: unknown;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          try {
            result = await rpc.request.evaluateJavascriptWithResponse(
              { script },
              { maxRequestTime: 2_000 },
            );
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            await Bun.sleep(250);
          }
        }
        if (lastError) throw lastError;
        await Bun.write(nativeStatusProbePath, JSON.stringify(result, null, 2));
      } catch (error) {
        await Bun.write(
          nativeStatusProbePath,
          JSON.stringify(
            { error: error instanceof Error ? error.message : String(error) },
            null,
            2,
          ),
        );
      } finally {
        Utils.quit();
      }
    })();
  });
}
mainWindow.on("resize", (rawEvent) => {
  const event = rawEvent as {
    data?: { width?: unknown; height?: unknown };
  };
  const { width, height } = event.data ?? {};
  if (typeof width === "number" && typeof height === "number")
    rpc.send.windowResized({ width, height });
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
    const nextTelemetryFingerprint = JSON.stringify(
      await context.telemetry.read(),
    );
    if (
      next !== fingerprint ||
      nextTelemetryFingerprint !== telemetryFingerprint
    ) {
      telemetryFingerprint = nextTelemetryFingerprint;
      announce("external");
    }
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

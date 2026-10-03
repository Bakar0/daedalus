import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  PATHS,
  Updater,
  Utils,
} from "electrobun/bun";
import {
  channelHome,
  createApplicationContext,
  sweepProviderActivity,
  WORKSPACE_FILES_CHANGED,
  type WorkspaceFilesChanged,
} from "@daedalus/core";
import {
  BUNDLED_TMUX_VARIABLE,
  CommandTmuxClient,
  isInheritedSessionVariable,
  pathExists,
  TmuxPtyBridge,
} from "@daedalus/platform";
import type {
  DesktopCommand,
  DesktopRpcSchema,
  DesktopWindowRole,
  TerminalServerMessage,
} from "@daedalus/protocol";
import {
  CHECK_FOR_UPDATES_MENU_ACTION,
  OPEN_WORLD_WINDOW_MENU_ACTION,
  isDesktopCommand,
  QUIT_MENU_ACTION,
  SHUTDOWN_MENU_ACTION,
} from "@daedalus/protocol";
import { APPLICATION_MENU } from "./menu";
import { installCliShim } from "./cli-shim";
import { QuitController } from "./quit";
import { UpdateController } from "./updates";
import { createDesktopRequestHandlers, desktopDataFingerprint } from "./rpc";
import {
  authorizeTerminalRequest,
  isTyping,
  passesInputLock,
  TerminalConnection,
} from "./terminal";

interface SocketData {
  initialSize?: { cols: number; rows: number };
  targetId: string;
  targetKind: "agent" | "integrated";
}

// A dev or canary build points at its own home so it cannot touch the stable
// app's database. Electrobun writes the channel into version.json for those
// builds and omits the file entirely for stable, and an unpackaged run has no
// bundle at all — both of those read as "no channel", which `channelHome`
// resolves to the stable home. Setting the variable rather than passing a path
// keeps every other consumer — the bundled CLI, spawned agents — on that same
// home.
const versionFile = Bun.file(resolve(PATHS.RESOURCES_FOLDER, "version.json"));
const appChannel = (await versionFile.exists())
  ? ((await versionFile.json()) as { channel?: string }).channel
  : undefined;
process.env.DAEDALUS_HOME = channelHome(
  appChannel,
  process.env.DAEDALUS_HOME ?? join(homedir(), ".daedalus"),
);

// The bundle carries its own tmux (scripts/build-tmux.ts), so agents run on a
// Mac with none installed. It is set before the context looks tmux up, and the
// variable reaches every agent session and CLI run the app starts, so all of
// them talk to the server with the same binary. A build without one, such as
// a dev build made before `build-tmux`, keeps searching PATH as before.
const bundledTmux = resolve(PATHS.RESOURCES_FOLDER, "../MacOS/tmux");
if (await pathExists(bundledTmux))
  process.env[BUNDLED_TMUX_VARIABLE] = bundledTmux;

// Opened from an agent's shell, the app inherits that agent's terminal state
// and session identity. The tmux client already keeps them out of every
// session; dropping them here keeps them out of everything else the host runs.
for (const key of Object.keys(process.env))
  if (isInheritedSessionVariable(key)) delete process.env[key];

// The window is the only surface that can draw a toast, so the host is the
// only adapter that may claim it; everywhere else a toast waits in the queue.
let windowReady = false;
const context = await createApplicationContext({
  migrationsDirectory: resolve(PATHS.RESOURCES_FOLDER, "app/migrations"),
  canDrawToasts: () => windowReady,
  // Electrobun's own notifier is attributed to this bundle and needs nothing
  // installed, so it beats the AppleScript fallback whenever the app is up.
  showNotificationInApp: ({ title, subtitle, body }) =>
    Utils.showNotification({
      title,
      ...(subtitle ? { subtitle } : {}),
      body,
    }),
  // A repository finishes cloning outside any request, so the window is told
  // the same way an external change tells it: otherwise the row would sit at
  // "preparing" until something unrelated refreshed it.
  onRepositoriesChanged: () => announce("external"),
});
// A Mac reboot kills the Daedalus tmux server and nothing else, so the context
// that just reconciled has turned every session that was running into `lost`.
// Bringing them back is done here, once, explicitly — before the change-check
// loop below starts — rather than from inside `reconcile()`, which also runs on
// that loop and on nearly every CLI command: revival wired in there would mean
// `daedal agent list` resurrecting agents.
//
// Each agent comes back idle at its prompt with its conversation loaded.
// Nothing is sent to it, so no work resumes on its own.
const revivedSessions = await context.agents
  .reviveLostSessions({ automatic: true })
  .catch((error: unknown) => {
    void context.logger.write("error", "session_revive_sweep_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  });
const revivedTerminals = await context.terminals
  .reviveLost({ automatic: true })
  .catch(() => []);
// What "Quit and stop sessions" put away, brought back. Deliberately not the
// same sweep as the one above: that one recovers sessions the OS killed and
// left `lost`, this one reopens ones Daedalus archived on purpose and promised
// to return to. A session archived by hand carries no flag and is left alone.
const resumedSessions = await context.agents
  .resumeMarkedSessions()
  .catch((error: unknown) => {
    void context.logger.write("error", "session_resume_sweep_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  });
if (
  resumedSessions &&
  (resumedSessions.resumed.length || resumedSessions.skipped.length)
)
  await context.logger.write("info", "session_resume_sweep", {
    resumed: resumedSessions.resumed.length,
    skipped: resumedSessions.skipped,
  });
if (revivedSessions)
  await context.logger.write("info", "session_revive_sweep", {
    revived: revivedSessions.revived.length,
    skipped: revivedSessions.skipped,
    ...(revivedSessions.halted ? { halted: revivedSessions.halted } : {}),
    terminals: revivedTerminals.length,
  });

// The shim runs the CLI on the bun inside the bundle, the one this process is
// running on. A bun from PATH would make the CLI depend on something the Mac
// may not have, and on a version the app was not built with.
const cliEntrypoint = resolve(PATHS.RESOURCES_FOLDER, "app/cli/daedal.js");
if (await pathExists(cliEntrypoint))
  await installCliShim({
    path: join(context.config.home, "bin", "daedal"),
    bunExecutable: process.execPath,
    cliEntrypoint,
  });
// Skills are installed from here rather than from the application context,
// so a CLI run never writes into the user's provider directories as a side
// effect of loading. The app is the thing that installs; the CLI installs when
// asked. A failure is logged and swallowed, because a provider directory
// Daedalus cannot write to is the user's to own and is no reason to refuse to
// start.
await context.skills.sync().catch(async (error: unknown) => {
  await context.logger.write("warn", "skill_sync_failed", {
    message: error instanceof Error ? error.message : String(error),
  });
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
          onInput: (data) => {
            if (socket.data.targetKind !== "agent") return true;
            // A routine agent in auto mode has its input locked: only
            // Daedalus types there. Scrolling and selecting still work.
            if (context.routineAgents.inputLocked(target.id))
              return passesInputLock(data);
            if (isTyping(data)) context.routineAgents.noteInput(target.id);
            return true;
          },
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
// The `views://` handler resolves the whole URL as a resource path, so a
// query string or fragment makes it look for a file that does not exist and
// the view loads empty. Renderer parameters therefore travel over RPC.
const rendererUrl = `views://mainview/index.html`;

// WebKit text controls use the native responder chain for standard editing
// commands on macOS. Defining these roles restores Cmd+C/V/X/A/Z everywhere.
ApplicationMenu.setApplicationMenu(APPLICATION_MENU);

let revision = 0;
let fingerprint = desktopDataFingerprint(context);
let telemetryFingerprint = "";
let dockBadgeCount = 0;

/**
 * Electrobun 1.18.1 exposes `setDockIconVisible` but no dock *badge*, so there
 * is no API to call and the count has nowhere native to go. It is logged when
 * it changes so the signal exists, and the in-app workspace roll-up is what
 * the user actually reads. Revisit if Electrobun grows a badge surface.
 */
async function recordAttentionCount(count: number): Promise<void> {
  if (count === dockBadgeCount) return;
  dockBadgeCount = count;
  await context.logger.write("info", "attention_count_changed", { count });
}

function announce(source: "desktop" | "external"): void {
  fingerprint = desktopDataFingerprint(context);
  // There is no window between closing one and reopening from the Dock, and
  // a repository finishing its clone in that gap must not throw.
  revision += 1;
  if (windowOpen) rpc.send.dataChanged({ revision, source });
  if (worldOpen) worldRpc.send.dataChanged({ revision, source });
}

/**
 * Quitting Daedalus has never stopped anything, and that is deliberate: the
 * app does not own the tmux server. `daedal agent spawn` works with the window
 * never opened, so a GUI quit that killed the server would kill sessions the
 * CLI started, and an agent mid-turn would lose the turn.
 *
 * What was wrong was the silence. The controller states it instead, and the
 * "Quit and Shut Down Sessions" menu item is the honest way to end everything.
 */
const quitController = new QuitController({
  plan: () => context.shutdown.plan(),
  runShutdown: (options) => context.shutdown.run(options),
  askWindow: (plan) => rpc.send.quitRequested({ plan }),
  // The heartbeat goes first for the same reason the signal handlers retire
  // it: one that outlived the app would absorb every alert into a window that
  // is not there.
  quit: () => void context.presence.retire().finally(() => Utils.quit()),
  log: (event, fields) => void context.logger.write("info", event, fields),
});

// "Later" is remembered per home, beside the database, so it holds across
// restarts without a migration for one value.
const dismissedUpdateFile = Bun.file(
  join(context.config.home, "update-dismissed.json"),
);
const updates = new UpdateController({
  updater: {
    local: async () => {
      const info = await Updater.getLocalInfo();
      // An unpackaged run has no version.json and so no feed to ask.
      return { version: info.version, channel: info.channel || "dev" };
    },
    check: async () => {
      const info = await Updater.checkForUpdate();
      return {
        version: info.version,
        updateAvailable: info.updateAvailable,
        ...(info.error ? { error: info.error } : {}),
      };
    },
    download: async () => {
      await Updater.downloadUpdate();
      const info = Updater.updateInfo();
      return {
        ready: Boolean(info?.updateReady),
        ...(info?.error ? { error: info.error } : {}),
      };
    },
    // Swaps the bundle in place, quits through `before-quit` and reopens the
    // new one. Sessions keep running, as with any quit.
    apply: () => Updater.applyUpdate(),
  },
  readDismissed: async () =>
    (await dismissedUpdateFile.exists())
      ? ((await dismissedUpdateFile.json()) as { version?: string }).version
      : undefined,
  writeDismissed: async (version) => {
    await Bun.write(dismissedUpdateFile, JSON.stringify({ version }));
  },
  publish: (update) => {
    if (windowOpen) rpc.send.appUpdateChanged({ update });
  },
  // The same cleanup the quit path does first, since the updater quits on
  // its own rather than through the quit controller.
  beforeRestart: () => context.presence.retire(),
  log: (event, fields) => void context.logger.write("info", event, fields),
});

const createRpc = (role: DesktopWindowRole = "main") =>
  BrowserView.defineRPC<DesktopRpcSchema>({
    // Initial repository clones and fetches can legitimately take several
    // minutes for large histories or slower remotes.
    maxRequestTime: 10 * 60_000,
    handlers: {
      requests: createDesktopRequestHandlers(
        context,
        () => announce("desktop"),
        Utils.openExternal,
        terminalEndpoint,
        {
          dialogShown: () => quitController.dialogShown(),
          decide: (choice) => quitController.decide(choice),
        },
        {
          current: () => updates.update,
          check: () => updates.check({ manual: true }),
          install: () => updates.install(),
          dismiss: (version) => updates.dismiss(version),
        },
        {
          role,
          openWorld: openWorldWindow,
          focusSession: focusMainSession,
        },
      ),
    },
  });

// Both are replaced wholesale every time a window is opened: an RPC instance
// is bound to the webview it was created for, so a reopened window needs its
// own. Everything that sends to the window reads these bindings at call time
// rather than capturing them.
let rpc!: ReturnType<typeof createRpc>;
let mainWindow!: BrowserWindow<ReturnType<typeof createRpc>>;
let windowOpen = false;
// The World in a window of its own (#44), opened from the World view. It
// loads the same page, which asks its role and draws only the World.
let worldRpc!: ReturnType<typeof createRpc>;
let worldWindow!: BrowserWindow<ReturnType<typeof createRpc>>;
let worldOpen = false;
/** A session to select once a main window reopened for it can hear. */
let pendingFocus: string | undefined;

/**
 * Filesystem changes go straight to the window rather than through
 * `announce`. They are not a snapshot change — nothing in the database moved —
 * and routing them through the revision counter would make an agent writing
 * files redraw every list in the app a few times a second.
 */
context.events.subscribe((event) => {
  if (event.type !== WORKSPACE_FILES_CHANGED || !windowOpen) return;
  const { workspaceId, changes, overflow } =
    event.payload as WorkspaceFilesChanged;
  rpc.send.workspaceFilesChanged({ workspaceId, changes, overflow });
});

ApplicationMenu.on("application-menu-clicked", (rawEvent) => {
  const event = rawEvent as { data?: { action?: unknown } };
  const command = event.data?.action;
  // Logged for every action, not just the quit ones: an accelerator that the
  // native menu never registered is indistinguishable from a key that did
  // nothing, and this is the only place that can tell them apart.
  void context.logger.write("info", "menu_action", {
    action: typeof command === "string" ? command : String(command),
  });
  if (command === QUIT_MENU_ACTION) {
    void quitController.requestQuit();
    return;
  }
  if (command === SHUTDOWN_MENU_ACTION) {
    void quitController.requestShutdownAndQuit();
    return;
  }
  if (command === OPEN_WORLD_WINDOW_MENU_ACTION) {
    openWorldWindow();
    return;
  }
  if (command === CHECK_FOR_UPDATES_MENU_ACTION) {
    void updates.check({ manual: true });
    return;
  }
  if (isDesktopCommand(command))
    rpc.send.command({ command: command satisfies DesktopCommand });
});

/**
 * Every `Utils.quit()` passes through `before-quit`, which makes it the one
 * place that can say which exit actually fired. It only records that.
 *
 * It deliberately does not *deny* a quit it did not initiate, though the event
 * allows it. Two things make that unacceptable. Electrobun routes `process.exit`
 * through `quit()`, so denying turns the SIGTERM handler below into a no-op and
 * leaves an app that survives `pkill`, a logout and a system shutdown — which
 * is strictly worse than the silence this feature set out to fix. And the
 * self-updater quits to restart, the one case where surviving is the point;
 * hijacking it into a dialog would break updates.
 *
 * Nothing is lost by only logging. Closing the window no longer quits, so
 * Cmd+Q is the quit, and it is already routed through the controller.
 */
Electrobun.events.on("before-quit", () => {
  void context.logger.write("info", "before_quit", {
    ours: quitController.state === "quitting",
    windowOpen,
  });
});

/**
 * Closing the window closes the window. The app keeps running, which is what
 * every macOS app does — `applicationShouldTerminateAfterLastWindowClosed`
 * defaults to NO — and is now also what makes the quit dialog reachable at
 * all: Cmd+Q is the only exit, and it always has a surface to ask on.
 *
 * Electrobun's default is the opposite, and it was the hole in this feature.
 * The red X called `Utils.quit()` directly, so the most ordinary way to put
 * the app away was the one path that never said a word about what it left
 * running. The window `close` event is not cancellable and arrives after the
 * surface is gone, so the fix is not to intercept it but to stop it meaning
 * "quit". `exitOnLastWindowClosed: false` in electrobun.config.ts is the
 * other half of this.
 */
function openMainWindow(): void {
  rpc = createRpc();
  mainWindow = new BrowserWindow({
    title: "Daedalus",
    url: rendererUrl,
    rpc,
    frame: { width: 1380, height: 820, x: 80, y: 80 },
    hidden: Boolean(nativeStatusProbePath),
    activate: !nativeStatusProbePath,
  });
  windowOpen = true;
  // The hidden probe window is not a place a toast could be seen, so it never
  // claims the channel.
  windowReady = !nativeStatusProbePath;
  mainWindow.on("close", () => {
    windowOpen = false;
    windowReady = false;
    // No window, no tree to keep fresh. The app outlives its window, so a
    // watcher left running here would hold a kernel resource for a view that
    // is not there — and the renderer re-asks for one when it comes back.
    context.workspaceWatch.close();
    void context.logger.write("info", "window_closed", {});
  });
  mainWindow.on("resize", (rawEvent) => {
    const event = rawEvent as {
      data?: { width?: unknown; height?: unknown };
    };
    const { width, height } = event.data ?? {};
    if (typeof width === "number" && typeof height === "number")
      rpc.send.windowResized({ width, height });
  });
}

/** Opens the World window, or brings it forward when it is open. */
function openWorldWindow(): void {
  if (worldOpen) {
    worldWindow.show();
    worldWindow.focus();
    return;
  }
  worldRpc = createRpc("world");
  worldWindow = new BrowserWindow({
    title: "Daedalus World",
    url: rendererUrl,
    rpc: worldRpc,
    frame: { width: 1180, height: 780, x: 160, y: 120 },
  });
  worldOpen = true;
  worldWindow.on("close", () => {
    worldOpen = false;
    void context.logger.write("info", "world_window_closed", {});
  });
  void context.logger.write("info", "world_window_opened", {});
}

/**
 * A click on an agent in the World window: the main window comes forward
 * and selects it, reopened first if it was closed.
 */
function focusMainSession(sessionId: string): void {
  if (!windowOpen) {
    pendingFocus = sessionId;
    openMainWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  rpc.send.focusSession({ sessionId });
}

// Clicking the Dock icon of a running app with no window is how macOS expects
// you to get it back, so it has to build a new one rather than merely focus.
Electrobun.events.on("reopen", () => {
  void context.logger.write("info", "reopen", { windowOpen });
  if (windowOpen) {
    mainWindow.show();
    return;
  }
  openMainWindow();
});

openMainWindow();

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
            // `maxRequestTime` is an RPC-instance option here, not a
            // per-request one, so the deadline comes from the transport's
            // 1s default. The retry loop around this call is what bounds
            // the wait, so the shorter per-attempt deadline costs nothing.
            result = await rpc.request.evaluateJavascriptWithResponse({
              script,
            });
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
// The window's heartbeat stops with its timers, whether it is closed,
// minimised or throttled, and the host stands in so the file keeps saying
// where the user is (not looking). Whether the app is running is carried by
// the pid in the same file, so a heartbeat this process is too busy to write
// costs a stale foreground reading, never a Script Editor alert.
//
// This runs on its own timer, not inside the change check below: that check
// skips a tick while the previous one is still running, so one slow tmux call
// there would silence the heartbeat for exactly as long as it took.
setInterval(() => {
  void context.presence.keepAlive().catch(() => undefined);
}, 1_200);

let checkingForExternalChanges = false;
setInterval(async () => {
  if (checkingForExternalChanges) return;
  checkingForExternalChanges = true;
  try {
    // Reconciliation updates stale sessions; SQLite fingerprinting also catches
    // mutations performed by another process such as the CLI.
    //
    // Every child launched here blocks this thread inside `posix_spawn` until
    // the child has started, and on a loaded machine that was observed taking
    // seconds per launch. So a tick asks tmux exactly once and shares the
    // answer; the version probe is remembered by the client after its first
    // success. Anything more is a bug, not a cost to absorb.
    if (await context.tmux.probe()) {
      const live = new Set(await context.tmux.listSessions());
      await Promise.all([
        context.agents.reconcile(live),
        context.terminals.reconcile(live),
      ]);
    }
    // Polled detection and staleness decay ride the reconcile tick. Both are
    // cheap — the rollout read is gated on file mtime and decay only touches
    // rows that are already too old to believe — and neither deserves a timer
    // of its own.
    await sweepProviderActivity({
      config: context.config,
      repositories: context.repositories,
      activity: context.activity,
      tmux: context.tmux,
    }).catch(() => undefined);
    await context.activity.decay().catch(() => undefined);
    // Automatic handoff rides the same tick. Telemetry is cached for five
    // seconds, so this is a map lookup on most ticks.
    await context.telemetry
      .read()
      .then((telemetry) =>
        context.agents.sweepAutoHandoffs(telemetry.sessionTelemetry),
      )
      .catch(() => undefined);
    // Routine agents ride the tick too: the clock lives in the app, so
    // nothing fires while it is closed.
    if (context.routineAgents.list().length) {
      const telemetry = await context.telemetry.read().catch(() => undefined);
      const contextUse = new Map(
        (telemetry?.sessionTelemetry ?? []).map((item) => [
          item.sessionId,
          item.context?.usedPercent,
        ]),
      );
      const routineTick = await context.routineAgents.tick({
        contextPercent: (sessionId) => contextUse.get(sessionId),
        activity: (sessionId) => context.activity.get(sessionId),
      });
      for (const event of routineTick.events)
        await context.logger.write("info", "routine_agent", { event });
    }
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
    // `daedal focus` parks a request and raises the app; the window learns
    // which session to select here.
    const focusRequest = await context.presence.takeFocusRequest();
    if (focusRequest?.taskId)
      rpc.send.focusTask({ taskId: focusRequest.taskId });
    else if (focusRequest?.sessionId)
      rpc.send.focusSession({ sessionId: focusRequest.sessionId });
    // A session asked for from the World window while the main one was
    // closed: sent once the reopened window has had a tick to load.
    if (pendingFocus && windowOpen) {
      rpc.send.focusSession({ sessionId: pendingFocus });
      pendingFocus = undefined;
    }
    // Alerts a CLI handed over are delivered as Daedalus, not Script Editor.
    // Only fresh ones: an alert parked while the app was down is already late,
    // and a queue that shouts a week of history is worse than a dropped ping.
    // Five minutes rather than one: a CLI hands over whenever this process is
    // alive, and this tick is what runs late when the machine is loaded.
    await context.notifications.flushDesktop(5, 300_000);
    await recordAttentionCount(
      context.repositories.listSessionAttention().length,
    );
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

// A heartbeat that outlives the app would absorb every alert into a window
// that is not there, so it is retired on the way out.
//
// These paths deliberately do not stop anything. A signal is a logout, a
// shutdown or a kill — it arrives with a deadline measured in seconds, and
// ending a board of sessions under one means being killed halfway through it.
// They fall through to what quitting does by default: everything keeps
// running, reachable with `daedal agent list`.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    windowReady = false;
    void context.logger
      .write("info", "quit", { reason: signal.toLowerCase() })
      .catch(() => undefined);
    void context.presence.retire().finally(() => process.exit(0));
  });

// Anything parked while the app was down is dropped rather than delivered:
// it is already stale, and the badge that outlived it is the durable signal.
context.notifications.discardPending("desktop");

await context.logger.write("info", "desktop_started", {
  terminalTransport: "loopback_websocket",
  reconnectableSessions: preexistingLiveIds.size,
});

// Stable builds look for a newer release shortly after launch and every few
// hours after that; see UpdateController for when the window says so.
void updates.start();

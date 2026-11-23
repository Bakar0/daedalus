/**
 * Starts, finds and drives this checkout's dev app on Chromium, with remote
 * debugging on DEV_CDP_PORT. Agents use it to see and operate the real window:
 * Playwright attaches over CDP, so no Screen Recording grant or mouse is
 * needed.
 *
 * Only one dev app can run at a time on a Mac: every checkout's dev build
 * shares the `~/.daedalus-dev` home and one Chromium profile, keyed by the dev
 * bundle identifier. So `start` refuses while a dev app from another checkout
 * runs, `connect` refuses to drive one, and `stop` only stops processes that
 * run from this checkout.
 *
 * The app runs without `--watch`: a rebuild would relaunch the window under a
 * connected script. After changing code, `restart`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  chromium,
  type Browser,
  type CDPSession,
  type Page,
} from "playwright-core";
import { DEV_CDP_PORT } from "../../electrobun.config";

export const projectRoot = resolve(import.meta.dir, "../..");
const cdpUrl = `http://127.0.0.1:${DEV_CDP_PORT}`;
const mainWindowUrl = "views://mainview";
const stateDirectory = join(projectRoot, "build", "dev-app");
export const logFile = join(stateDirectory, "dev-app.log");
const pidFile = join(stateDirectory, "dev-app.pid");
/** The bundle `electrobun dev` builds and runs from this checkout. */
const bundlePath = join(
  projectRoot,
  "build",
  "dev-macos-arm64",
  "Daedalus-dev.app",
);
/** The first build downloads and bundles Chromium, which can take minutes. */
const startTimeoutMs = 10 * 60_000;
const stopTimeoutMs = 15_000;

export interface Size {
  width: number;
  height: number;
}

/** Runs a command and returns its standard output, trimmed. */
async function output(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text.trim();
}

/** Polls until `done` holds or the time runs out; returns whether it held. */
async function waitUntil(
  done: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(intervalMs);
  }
}

/** The bundle paths of every dev app running on this Mac. */
async function runningDevApps(): Promise<string[]> {
  const lines = (
    await output(["pgrep", "-fl", "Daedalus-dev.app/Contents/MacOS/launcher"])
  )
    .split("\n")
    .filter(Boolean);
  return [
    ...new Set(
      lines.map((line) =>
        line
          .replace(/^\d+\s+/, "")
          .replace(/\/Contents\/MacOS\/launcher.*$/, ""),
      ),
    ),
  ];
}

/** The pids of every process that runs from this checkout's bundle. */
async function ownAppPids(): Promise<number[]> {
  return (await output(["pgrep", "-f", bundlePath]))
    .split("\n")
    .filter(Boolean)
    .map(Number);
}

/** The command of the process that listens on the CDP port, if any. */
async function portOwner(): Promise<string | undefined> {
  const pid = (
    await output(["lsof", "-nP", `-iTCP:${DEV_CDP_PORT}`, "-sTCP:LISTEN", "-t"])
  ).split("\n")[0];
  if (!pid) return undefined;
  return (await output(["ps", "-o", "command=", "-p", pid])) || undefined;
}

/** True when a dev app window answers on the CDP port, whoever runs it. */
async function windowAnswers(): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl}/json/list`, {
      signal: AbortSignal.timeout(2000),
    });
    const targets = (await response.json()) as Array<{
      type: string;
      url: string;
    }>;
    return targets.some(
      (target) =>
        target.type === "page" && target.url.startsWith(mainWindowUrl),
    );
  } catch {
    return false;
  }
}

/**
 * The process group `start` launched, when it still runs `electrobun dev`
 * from this checkout. A pid file can outlive its process (a reboot, a crash),
 * and macOS reuses pids, so a pid only counts when its process leads its own
 * group, is the launcher's bun, and has this checkout as its directory.
 * Anything else is stale and the file is removed.
 */
async function ownGroup(): Promise<number | undefined> {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8"));
  const stale = () => {
    rmSync(pidFile, { force: true });
    return undefined;
  };
  if (!Number.isInteger(pid) || pid <= 0) return stale();
  const [group, ...command] = (
    await output(["ps", "-o", "pgid=,command=", "-p", String(pid)])
  )
    .trim()
    .split(/\s+/);
  if (Number(group) !== pid || !command.join(" ").includes("electrobun"))
    return stale();
  const directory = (
    await output(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"])
  )
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  return directory === projectRoot ? pid : stale();
}

export interface DevAppStatus {
  /** This checkout's app runs and its window answers over CDP. */
  ready: boolean;
  /** The bundle paths of every dev app running on this Mac. */
  running: string[];
  /** One of the running apps is this checkout's. */
  ours: boolean;
  /** What holds the CDP port, when something does. */
  portOwner?: string;
}

export async function status(): Promise<DevAppStatus> {
  const running = await runningDevApps();
  const owner = await portOwner();
  const ownsPort = owner?.includes(bundlePath) ?? false;
  return {
    ready: ownsPort && (await windowAnswers()),
    running,
    ours: running.includes(bundlePath),
    ...(owner ? { portOwner: owner } : {}),
  };
}

/**
 * The dev app's environment: this process's, minus what ties it to the agent
 * session that starts it.
 */
function appEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // The session's DAEDALUS_* variables would point the app's agents at the
    // session that started it, and CLAUDECODE makes Claude inside the app's
    // terminals think it is nested in this one.
    if (name.startsWith("DAEDALUS_") || name === "CLAUDECODE") continue;
    env[name] = value;
  }
  env["DAEDALUS_CDP"] = "1";
  return env;
}

function tail(lines = 30): string {
  if (!existsSync(logFile)) return "(no log)";
  return readFileSync(logFile, "utf8").split("\n").slice(-lines).join("\n");
}

/**
 * Builds and starts this checkout's dev app on Chromium, detached, and waits
 * until its window answers over CDP. Returns at once when it already does.
 */
export async function start(log: (line: string) => void): Promise<void> {
  const current = await status();
  if (current.ready) return;
  const others = current.running.filter((path) => path !== bundlePath);
  if (others.length)
    throw new Error(
      `another dev app is running from ${others.join(", ")}. Only one dev app can run at a time, since they share ~/.daedalus-dev. Quit it first.`,
    );
  if (current.portOwner && !current.portOwner.includes(bundlePath))
    throw new Error(`port ${DEV_CDP_PORT} is held by: ${current.portOwner}`);
  // This checkout's app or launcher without a window that answers: quit with
  // Cmd+Q, still starting from an earlier `start`, or started by plain
  // `bun run dev` without the debugging port. Start clean.
  if (current.ours || (await ownGroup())) {
    log("stopping this checkout's dev app, which does not answer over CDP");
    await stop();
  }

  mkdirSync(stateDirectory, { recursive: true });
  const out = openSync(logFile, "w");
  log(`building the renderer; log: ${logFile}`);
  const build = Bun.spawn(
    [process.execPath, "run", "--cwd", "apps/desktop", "build"],
    { cwd: projectRoot, env: appEnvironment(), stdout: out, stderr: out },
  );
  if ((await build.exited) !== 0)
    throw new Error(
      `the renderer build failed. The end of ${logFile}:\n${tail()}`,
    );

  // node:child_process rather than Bun.spawn for `detached`: the app gets a
  // process group of its own, so it outlives this command and `stop` can end
  // it with its launcher in one signal.
  const child = spawn(
    process.execPath,
    ["node_modules/.bin/electrobun", "dev"],
    {
      cwd: projectRoot,
      env: appEnvironment(),
      detached: true,
      stdio: ["ignore", out, out],
    },
  );
  if (!child.pid) throw new Error("could not start `electrobun dev`");
  await Bun.write(pidFile, String(child.pid));
  child.unref();
  log("starting the dev app");

  let exited = false;
  const ready = await waitUntil(
    async () => {
      if ((await status()).ready) return true;
      exited = !(await ownGroup());
      return exited;
    },
    startTimeoutMs,
    1000,
  );
  if (ready && !exited) return;
  throw new Error(
    exited
      ? `the dev app exited while starting. The end of ${logFile}:\n${tail()}`
      : `the window did not answer on ${cdpUrl} within ${startTimeoutMs / 60_000} minutes. The end of ${logFile}:\n${tail()}`,
  );
}

/**
 * Stops this checkout's dev app: the process group `start` launched, then any
 * process still running from this checkout's bundle. Touches nothing else.
 * Returns false when nothing was running; throws when something survives.
 */
export async function stop(): Promise<boolean> {
  const group = await ownGroup();
  const signalGroup = (signal: NodeJS.Signals) => {
    if (group === undefined) return;
    try {
      process.kill(-group, signal);
    } catch {
      // Already gone.
    }
  };
  const signalApp = async (signal: NodeJS.Signals) => {
    for (const pid of await ownAppPids()) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  };
  const wasRunning = group !== undefined || (await ownAppPids()).length > 0;
  if (!wasRunning) return false;

  const gone = async () =>
    (await ownGroup()) === undefined && (await ownAppPids()).length === 0;
  signalGroup("SIGTERM");
  await signalApp("SIGTERM");
  if (!(await waitUntil(gone, stopTimeoutMs))) {
    signalGroup("SIGKILL");
    await signalApp("SIGKILL");
    if (!(await waitUntil(gone, stopTimeoutMs)))
      throw new Error(
        `this checkout's dev app is still running after SIGKILL: ${(await ownAppPids()).join(", ")}`,
      );
  }
  rmSync(pidFile, { force: true });
  return true;
}

export interface DevApp {
  browser: Browser;
  /** The app's main window. */
  page: Page;
  /** A raw CDP session on the window, for what Playwright does not cover. */
  cdp: CDPSession;
  /**
   * Screenshots the window into `file` at device scale. With `size`, lays the
   * page out at that CSS size for the shot only, then gives the window its
   * own size back.
   */
  shot(file: string, size?: Size): Promise<string>;
  /** Disconnects Playwright; the app keeps running. */
  close(): Promise<void>;
}

/** Attaches Playwright to this checkout's running dev app. */
export async function connect(): Promise<DevApp> {
  const current = await status();
  if (!current.ready)
    throw new Error(
      current.portOwner
        ? `port ${DEV_CDP_PORT} belongs to another app, not this checkout's: ${current.portOwner}`
        : `this checkout's dev app is not running; run \`bun scripts/dev-app.ts start\``,
    );
  const browser = await chromium.connectOverCDP(cdpUrl);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith(mainWindowUrl));
  if (!page) {
    await browser.close();
    throw new Error("the Daedalus main window is not open");
  }
  const cdp = await page.context().newCDPSession(page);
  return {
    browser,
    page,
    cdp,
    async shot(file, size) {
      if (size) {
        // Playwright's setViewportSize would drop the window to 1x; this
        // keeps its own pixel ratio.
        const scale = await page.evaluate(() => devicePixelRatio);
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          ...size,
          deviceScaleFactor: scale,
          mobile: false,
        });
        await page.waitForTimeout(400);
      }
      try {
        await page.screenshot({ path: file });
      } finally {
        // An override outlives this connection, so leave the window as found.
        if (size) await cdp.send("Emulation.clearDeviceMetricsOverride");
      }
      return file;
    },
    // On a CDP connection, close() only disconnects: the app keeps running.
    close: () => browser.close(),
  };
}

/**
 * Starts, finds and drives this checkout's dev app on Chromium, with remote
 * debugging on DEV_CDP_PORT. Agents use it to see and operate the real window:
 * Playwright attaches over CDP, so no Screen Recording grant or mouse is
 * needed.
 *
 * `start` builds the bundle and hands it to Launch Services with `open`. An
 * app started straight from an agent's shell runs in the agent's `Background`
 * launchd session: Chromium still renders for CDP, but the window on the
 * user's screen stays blank. `open` starts it in the user's GUI session, with
 * the user's own environment, so it also never inherits the agent session's
 * `DAEDALUS_*` variables and uses `~/.daedalus-dev`.
 *
 * Only one dev app can run at a time on a Mac: every checkout's dev build
 * shares the `~/.daedalus-dev` home and one Chromium profile, keyed by the dev
 * bundle identifier. So `start` refuses while a dev app from another checkout
 * runs, `connect` refuses to drive one, and `stop` only stops processes that
 * run from this checkout's bundle.
 */
import { mkdirSync, openSync, readFileSync, existsSync } from "node:fs";
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
/** The build's output, then the app's own, which `open` sends here. */
export const logFile = join(stateDirectory, "dev-app.log");
/** The bundle `electrobun build` makes from this checkout. */
const bundlePath = join(
  projectRoot,
  "build",
  "dev-macos-arm64",
  "Daedalus-dev.app",
);
/** The window usually answers within seconds of `open`. */
const launchTimeoutMs = 2 * 60_000;
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
  return (await output(["pgrep", "-f", `${bundlePath}/`]))
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

function tail(lines = 30): string {
  if (!existsSync(logFile)) return "(no log)";
  return readFileSync(logFile, "utf8").split("\n").slice(-lines).join("\n");
}

/** Runs one build step with its output in the log, and fails on its exit. */
async function buildStep(what: string, command: string[], log: number) {
  const step = Bun.spawn(command, {
    cwd: projectRoot,
    env: { ...process.env, DAEDALUS_CDP: "1" },
    stdout: log,
    stderr: log,
  });
  if ((await step.exited) !== 0)
    throw new Error(`${what} failed. The end of ${logFile}:\n${tail()}`);
}

/**
 * Builds this checkout's dev app on Chromium, opens it in the user's GUI
 * session, and waits until its window answers over CDP. Returns at once when
 * it already does.
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
  // This checkout's app without a window that answers: still starting, or
  // built without the debugging port. Start clean.
  if (current.ours) {
    log("stopping this checkout's dev app, which does not answer over CDP");
    await stop();
  }

  mkdirSync(stateDirectory, { recursive: true });
  const out = openSync(logFile, "w");
  log(`building; the first build downloads Chromium. Log: ${logFile}`);
  await buildStep(
    "the renderer build",
    [process.execPath, "run", "--cwd", "apps/desktop", "build"],
    out,
  );
  await buildStep(
    "the app build",
    [process.execPath, "node_modules/.bin/electrobun", "build"],
    out,
  );

  log("opening the dev app");
  const opened = Bun.spawn(
    ["open", "-n", bundlePath, "--stdout", logFile, "--stderr", logFile],
    { stdout: "ignore", stderr: "pipe" },
  );
  if ((await opened.exited) !== 0)
    throw new Error(
      `open failed: ${(await new Response(opened.stderr).text()).trim()}`,
    );

  if (await waitUntil(async () => (await status()).ready, launchTimeoutMs, 500))
    return;
  throw new Error(
    (await ownAppPids()).length
      ? `the window did not answer on ${cdpUrl} within ${launchTimeoutMs / 60_000} minutes. The end of ${logFile}:\n${tail()}`
      : `the dev app exited while starting. The end of ${logFile}:\n${tail()}`,
  );
}

/**
 * Stops every process that runs from this checkout's bundle, and nothing
 * else. Returns false when nothing was running; throws when something
 * survives SIGKILL.
 */
export async function stop(): Promise<boolean> {
  if (!(await ownAppPids()).length) return false;
  const signal = async (name: NodeJS.Signals) => {
    for (const pid of await ownAppPids()) {
      try {
        process.kill(pid, name);
      } catch {
        // Already gone.
      }
    }
  };
  const gone = async () => (await ownAppPids()).length === 0;
  await signal("SIGTERM");
  if (await waitUntil(gone, stopTimeoutMs)) return true;
  await signal("SIGKILL");
  if (await waitUntil(gone, stopTimeoutMs)) return true;
  throw new Error(
    `this checkout's dev app is still running after SIGKILL: ${(await ownAppPids()).join(", ")}`,
  );
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

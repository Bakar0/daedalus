/**
 * Starts, finds and drives the dev app built with `bun run dev:cdp`, which
 * renders on Chromium with remote debugging on DEV_CDP_PORT. Agents use it to
 * see and operate the real window: Playwright attaches over CDP, so no Screen
 * Recording grant or mouse is needed.
 *
 * Only one dev app can run at a time on a Mac: every worktree's dev build
 * shares the `~/.daedalus-dev` home and the Chromium profile keyed by the dev
 * bundle identifier. So `start` refuses while a dev app from another checkout
 * runs, and `stop` only ever stops the app this checkout started.
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
export const cdpUrl = `http://127.0.0.1:${DEV_CDP_PORT}`;
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

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out.trim();
}

/** Every running dev app, by the path of the bundle it runs from. */
async function runningDevApps(): Promise<string[]> {
  const lines = (
    await run(["pgrep", "-fl", "Daedalus-dev.app/Contents/MacOS/launcher"])
  )
    .split("\n")
    .filter(Boolean);
  return lines.map((line) =>
    line.replace(/^\d+\s+/, "").replace(/\/Contents\/MacOS\/launcher.*$/, ""),
  );
}

/** The command of the process that listens on the CDP port, if any. */
async function portOwner(): Promise<string | undefined> {
  const pid = (
    await run(["lsof", "-nP", `-iTCP:${DEV_CDP_PORT}`, "-sTCP:LISTEN", "-t"])
  ).split("\n")[0];
  if (!pid) return undefined;
  return run(["ps", "-o", "command=", "-p", pid]);
}

/** The app window's DevTools target once its page has loaded, else undefined. */
async function mainWindowReady(): Promise<boolean> {
  try {
    const targets = (await (
      await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(2000) })
    ).json()) as Array<{
      type: string;
      url: string;
    }>;
    return targets.some(
      (target) =>
        target.type === "page" && target.url.startsWith("views://mainview"),
    );
  } catch {
    return false;
  }
}

function ownPid(): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

export interface DevAppStatus {
  /** The window answers on the CDP port. */
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
  return {
    ready: await mainWindowReady(),
    running,
    ours: running.includes(bundlePath),
    ...(owner ? { portOwner: owner } : {}),
  };
}

/** The dev app's environment: this checkout's, minus whatever ties it to the agent session that starts it. */
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

/**
 * Builds and starts this checkout's dev app on Chromium, detached, and waits
 * until its window answers over CDP. Returns at once when it already runs.
 */
export async function start(
  log: (line: string) => void = () => {},
): Promise<void> {
  const now = await status();
  if (now.ours && now.ready) return;
  const others = now.running.filter((path) => path !== bundlePath);
  if (others.length)
    throw new Error(
      `another dev app is running from ${others.join(", ")}. Only one dev app can run at a time, since they share ~/.daedalus-dev. Quit it, or run \`bun scripts/dev-app.ts stop\` in that checkout.`,
    );
  if (now.portOwner && !now.ours)
    throw new Error(`port ${DEV_CDP_PORT} is held by: ${now.portOwner}`);

  if (!now.ours) {
    mkdirSync(stateDirectory, { recursive: true });
    const out = openSync(logFile, "w");
    // A process group of its own, so `stop` ends the watcher and the app
    // together, and the app outlives the command that started it.
    const child = spawn(process.execPath, ["run", "dev"], {
      cwd: projectRoot,
      env: appEnvironment(),
      detached: true,
      stdio: ["ignore", out, out],
    });
    if (!child.pid) throw new Error("could not start `bun run dev`");
    await Bun.write(pidFile, String(child.pid));
    child.unref();
    log(`building and starting the dev app; log: ${logFile}`);
  }

  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (await mainWindowReady()) return;
    if (!ownPid())
      throw new Error(
        `the dev app exited while starting. The end of ${logFile}:\n${tail()}`,
      );
    await Bun.sleep(1000);
  }
  throw new Error(
    `the window did not answer on ${cdpUrl} within ${startTimeoutMs / 60_000} minutes. The end of ${logFile}:\n${tail()}`,
  );
}

function tail(lines = 30): string {
  if (!existsSync(logFile)) return "(no log)";
  return readFileSync(logFile, "utf8").split("\n").slice(-lines).join("\n");
}

/** Stops the dev app this checkout started, and nothing else. */
export async function stop(): Promise<boolean> {
  const pid = ownPid();
  if (!pid) {
    rmSync(pidFile, { force: true });
    return false;
  }
  const group = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  group("SIGTERM");
  for (let waited = 0; waited < 15_000 && ownPid(); waited += 250)
    await Bun.sleep(250);
  if (ownPid()) group("SIGKILL");
  // The app can outlive the watcher's group by a moment; wait for its window
  // to go so the next start does not find it.
  for (
    let waited = 0;
    waited < 15_000 && (await runningDevApps()).includes(bundlePath);
    waited += 250
  )
    await Bun.sleep(250);
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
  shot(file: string, size?: { width: number; height: number }): Promise<string>;
  /** Disconnects Playwright; the app keeps running. */
  close(): Promise<void>;
}

/** Attaches Playwright to the running dev app's window. */
export async function connect(): Promise<DevApp> {
  if (!(await mainWindowReady()))
    throw new Error(
      `no dev app window answers on ${cdpUrl}; run \`bun scripts/dev-app.ts start\``,
    );
  const browser = await chromium.connectOverCDP(cdpUrl);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("views://mainview"));
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

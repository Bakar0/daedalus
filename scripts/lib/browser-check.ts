/**
 * Shared driver for the cloud UI checks: serves a test page with Vite, opens
 * it in headless Chrome and gives the check a small CDP surface (evaluate,
 * click by test id, screenshot, resize).
 *
 * The older checks inline this. The five cloud checks share one fixture page
 * and one driver, so it lives here.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const artifactsDirectory = join(projectRoot, "artifacts");

export interface Browser {
  evaluate<T>(expression: string): Promise<T>;
  /** Fails with the page's own text and renderer errors if the wait times out. */
  waitFor(expression: string, what: string, timeoutMs?: number): Promise<void>;
  /** Clicks the first element with this data-testid. */
  click(testId: string): Promise<void>;
  /** True when an element with this data-testid exists. */
  has(testId: string): Promise<boolean>;
  text(testId: string): Promise<string>;
  attribute(testId: string, name: string): Promise<string | null>;
  /** Types into an input the way a user does, so React sees the change. */
  type(testId: string, value: string): Promise<void>;
  resize(height: number): Promise<void>;
  screenshot(name: string): Promise<string>;
  /** Calls the page recorded through `window.requests`, oldest first. */
  requests(): Promise<Array<Record<string, unknown>>>;
  rendererErrors: string[];
  /** A CSS selector that test ids are looked up inside, or empty for the page. */
  scope: string;
}

export interface RunOptions {
  /** A free port pair derived from the check, so checks can run side by side. */
  port: number;
  page: string;
  /** Query string for the fixture page, such as `scenario=signed-out`. */
  query?: string;
  width?: number;
  height?: number;
}

export async function withBrowser(
  options: RunOptions,
  body: (browser: Browser) => Promise<void>,
): Promise<void> {
  const debuggingPort = options.port + 1;
  const query = options.query ? `?${options.query}` : "";
  const pageUrl = `http://127.0.0.1:${options.port}/${options.page}${query}`;
  await mkdir(artifactsDirectory, { recursive: true });
  const profile = await mkdtemp(join(artifactsDirectory, ".cloud-check-"));
  const vite = Bun.spawn(
    [
      process.execPath,
      "node_modules/vite/bin/vite.js",
      "--config",
      "apps/desktop/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(options.port),
      "--strictPort",
    ],
    { cwd: projectRoot, stdout: "ignore", stderr: "ignore" },
  );
  let chrome: Bun.Subprocess | undefined;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        if ((await fetch(pageUrl)).ok) break;
      } catch {
        if (attempt >= 100) throw new Error("Test server did not start");
      }
      await Bun.sleep(50);
    }
    chrome = Bun.spawn(
      [
        chromePath,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        `--remote-debugging-port=${debuggingPort}`,
        `--user-data-dir=${profile}`,
        `--window-size=${options.width ?? 1380},${options.height ?? 820}`,
        pageUrl,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    let websocketUrl: string | undefined;
    for (let attempt = 0; attempt < 600 && !websocketUrl; attempt += 1) {
      try {
        const pages = (await (
          await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
        ).json()) as Array<{ url: string; webSocketDebuggerUrl: string }>;
        websocketUrl = pages.find(
          (one) => one.url === pageUrl,
        )?.webSocketDebuggerUrl;
      } catch {
        // Chrome is still starting.
      }
      if (!websocketUrl) await Bun.sleep(50);
    }
    if (!websocketUrl)
      throw new Error("Chrome DevTools endpoint did not start");

    const socket = new WebSocket(websocketUrl);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener(
        "error",
        () => rejectOpen(new Error("CDP socket failed")),
        { once: true },
      );
    });
    let sequence = 0;
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void }
    >();
    const rendererErrors: string[] = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") {
        rendererErrors.push(
          message.params?.exceptionDetails?.exception?.description ??
            message.params?.exceptionDetails?.text ??
            "Unknown renderer exception",
        );
        return;
      }
      if (!message.id) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const send = <T = any>(
      method: string,
      params: Record<string, unknown> = {},
    ) =>
      new Promise<T>((resolveRequest, rejectRequest) => {
        const id = ++sequence;
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async <T>(expression: string) => {
      const response = await send<{
        result: { value: T };
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      }>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails)
        throw new Error(
          response.exceptionDetails.exception?.description ??
            response.exceptionDetails.text ??
            "Browser evaluation failed",
        );
      return response.result.value;
    };
    await send("Page.enable");
    await send("Runtime.enable");

    const selector = (testId: string) =>
      JSON.stringify(
        `${browser.scope ? `${browser.scope} ` : ""}[data-testid="${testId}"]`,
      );
    const browser: Browser = {
      evaluate,
      rendererErrors,
      scope: "",
      async waitFor(expression, what, timeoutMs = 10_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (await evaluate<boolean>(`Boolean(${expression})`)) return;
          await Bun.sleep(50);
        }
        throw new Error(
          `Timed out waiting for ${what}; body: ${await evaluate<string>(
            "document.body.innerText.slice(0, 300)",
          )}; renderer errors: ${rendererErrors.slice(0, 3).join(" | ") || "none"}`,
        );
      },
      async click(testId) {
        await browser.waitFor(
          `document.querySelector(${selector(testId)})`,
          `${testId} to click`,
        );
        await evaluate(`document.querySelector(${selector(testId)}).click()`);
        await Bun.sleep(80);
      },
      has: (testId) =>
        evaluate<boolean>(
          `Boolean(document.querySelector(${selector(testId)}))`,
        ),
      text: (testId) =>
        evaluate<string>(
          `document.querySelector(${selector(testId)})?.textContent?.trim() ?? ''`,
        ),
      attribute: (testId, name) =>
        evaluate<string | null>(
          `document.querySelector(${selector(testId)})?.getAttribute(${JSON.stringify(name)}) ?? null`,
        ),
      async type(testId, value) {
        await browser.waitFor(
          `document.querySelector(${selector(testId)})`,
          `${testId} to type into`,
        );
        await evaluate(`(() => {
          const input = document.querySelector(${selector(testId)});
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(value)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await Bun.sleep(50);
      },
      async resize(height) {
        await send("Emulation.setDeviceMetricsOverride", {
          width: options.width ?? 1380,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await Bun.sleep(150);
      },
      async screenshot(name) {
        const shot = await send<{ data: string }>("Page.captureScreenshot", {
          format: "png",
        });
        const path = join(artifactsDirectory, `${name}.png`);
        await Bun.write(path, Buffer.from(shot.data, "base64"));
        return path;
      },
      requests: () =>
        evaluate<Array<Record<string, unknown>>>(
          "JSON.parse(JSON.stringify(window.requests ?? []))",
        ),
    };
    await body(browser);
    if (rendererErrors.length)
      throw new Error(
        `Renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}`,
      );
    socket.close();
  } finally {
    chrome?.kill();
    vite.kill();
    await chrome?.exited;
    await vite.exited;
    await rm(profile, { recursive: true, force: true });
  }
}

/** Fails the check with `message` unless `condition` holds. */
export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Asserts the element with `selector` sits inside the viewport and that the
 * page itself does not scroll, the same two things the settings check holds.
 */
export const fitsViewport = (selector: string) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return { found: false };
  const rect = element.getBoundingClientRect();
  return {
    found: true,
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    viewport: window.innerHeight,
    pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
  };
})()`;

/** What the cloud fixture page hands back that the real host never sends. */
export const FIXTURE_SECRETS = ["dtok-SECRET-5f3a9c", "rkey-SECRET-77b1e0"];

/** Settings > a category, by its nav label. */
export const openSettingsCategory = (label: string) => `(() => {
  const button = [...document.querySelectorAll('.settings-nav button')]
    .find((one) => one.textContent.trim() === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()`;

/** Opens the `<details>` menu whose trigger has this aria-label, if closed. */
export const openMenu = (label: string) => `(() => {
  const summary = document.querySelector('summary[aria-label=${JSON.stringify(label)}]');
  if (!summary) return false;
  if (!summary.parentElement.open) summary.click();
  return true;
})()`;

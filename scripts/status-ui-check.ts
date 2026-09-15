import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const port = 41741;
const debuggingPort = 41742;
const pageUrl = `http://127.0.0.1:${port}/panel-test.html`;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactsDirectory = join(projectRoot, "artifacts");
const screenshotPath = join(artifactsDirectory, "status-ui-check.png");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(
  join(artifactsDirectory, ".status-check-profile-"),
);

const vite = Bun.spawn(
  [
    process.execPath,
    "node_modules/vite/bin/vite.js",
    "--config",
    "apps/desktop/vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  { cwd: projectRoot, stdout: "ignore", stderr: "ignore" },
);

let chrome: Bun.Subprocess | undefined;
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(pageUrl)).ok) break;
    } catch {
      if (attempt === 99) throw new Error("Status test server did not start");
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
      "--window-size=1380,820",
      pageUrl,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  let websocketUrl: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = (await (
        await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
      ).json()) as Array<{ url: string; webSocketDebuggerUrl: string }>;
      websocketUrl = pages.find(
        (page) => page.url === pageUrl,
      )?.webSocketDebuggerUrl;
      if (websocketUrl) break;
    } catch {
      // Chrome is still starting.
    }
    await Bun.sleep(50);
  }
  if (!websocketUrl) throw new Error("Chrome DevTools endpoint did not start");

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
    if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params?.type === "error"
    ) {
      rendererErrors.push(
        message.params.args
          .map((argument: { value?: unknown; description?: string }) =>
            String(argument.value ?? argument.description ?? ""),
          )
          .join(" "),
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
  let rendererReady = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await evaluate(
        "Boolean(document.querySelector('.app-mode-switcher button:nth-child(2)'))",
      )
    ) {
      rendererReady = true;
      break;
    }
    await Bun.sleep(50);
  }
  if (!rendererReady) {
    const body = await evaluate<string>(
      "document.body.innerText.slice(0, 1000)",
    );
    throw new Error(
      `Daedalus renderer did not become ready: ${body || "empty document"}${rendererErrors.length ? `\n${rendererErrors.join("\n")}` : ""}`,
    );
  }
  await evaluate(
    "document.querySelector('.app-mode-switcher button:nth-child(2)').click()",
  );

  let telemetry:
    | { heading: string; status: string; context: string; usage: string }
    | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    telemetry = await evaluate(`(() => {
      const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
      return {
        heading: text('.terminal-heading h1'),
        status: text('.agent-session-status-primary'),
        context: text('.agent-session-context'),
        usage: text('.provider-usage'),
      };
    })()`);
    if (telemetry.context && telemetry.usage) break;
    await Bun.sleep(50);
  }
  if (!telemetry) throw new Error("Status telemetry did not render");

  const expectedValues = [
    ["session heading model", telemetry.heading, "claude-fable-5-1[1m]"],
    ["status-line model", telemetry.status, "claude-fable-5-1[1m]"],
    ["Claude context", telemetry.context, "Context 61k/1000k"],
    ["Codex usage", telemetry.usage, "Codex5h 28%·7d 61%"],
    ["Claude usage", telemetry.usage, "Claude5h 34%·7d 47%"],
  ] as const;
  for (const [label, actual, expected] of expectedValues)
    if (!actual.includes(expected))
      throw new Error(`${label} is missing ${expected}: ${actual}`);

  const screenshot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(
    `Status UI check passed: ${telemetry.status}; ${telemetry.context}; ${telemetry.usage}`,
  );
  console.log(`Screenshot: ${screenshotPath}`);
  socket.close();
} finally {
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

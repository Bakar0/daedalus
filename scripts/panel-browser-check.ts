import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const port = 41739;
const debuggingPort = 41740;
const pageUrl = `http://127.0.0.1:${port}/panel-test.html`;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const screenshotPath = join(projectRoot, "artifacts/panel-browser-check.png");
const artifactsDirectory = join(projectRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(join(artifactsDirectory, ".panel-check-profile-"));

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
      if (attempt === 99) throw new Error("Panel test server did not start");
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
      {
        once: true,
      },
    );
  });
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await evaluate(
        "Boolean(document.querySelector('.workspace-panel-resize-handle'))",
      )
    )
      break;
    await Bun.sleep(50);
  }

  const before = await evaluate<{
    width: number;
    x: number;
    y: number;
    otherColor: string;
  }>(`(() => {
    const panel = document.querySelector('.workspace-column');
    const handle = document.querySelector('.workspace-panel-resize-handle');
    const other = document.querySelector('.secondary-panel-resize-handle');
    const rect = handle.getBoundingClientRect();
    return {
      width: panel.getBoundingClientRect().width,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      otherColor: getComputedStyle(other, '::after').backgroundColor,
    };
  })()`);

  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: before.x,
    y: before.y,
  });
  await Bun.sleep(180);
  const hover = await evaluate<{ active: string; other: string }>(`(() => ({
    active: getComputedStyle(document.querySelector('.workspace-panel-resize-handle'), '::after').backgroundColor,
    other: getComputedStyle(document.querySelector('.secondary-panel-resize-handle'), '::after').backgroundColor,
  }))()`);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    x: before.x,
    y: before.y,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "left",
    buttons: 1,
    x: before.x + 96,
    y: before.y,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    x: before.x + 96,
    y: before.y,
  });
  await Bun.sleep(100);
  const draggedWidth = await evaluate<number>(
    "document.querySelector('.workspace-column').getBoundingClientRect().width",
  );

  const collapseButton = await evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('[aria-label="Collapse workspace panel"]').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"] as const)
    await send("Input.dispatchMouseEvent", {
      type,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
      x: collapseButton.x,
      y: collapseButton.y,
    });
  await Bun.sleep(100);
  const collapsed = await evaluate<{
    width: number;
    compact: boolean;
  }>(`(() => {
    const panel = document.querySelector('.workspace-column');
    return { width: panel.getBoundingClientRect().width, compact: panel.classList.contains('panel-compact') };
  })()`);

  const expandButton = await evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('[aria-label="Expand workspace panel"]').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"] as const)
    await send("Input.dispatchMouseEvent", {
      type,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
      x: expandButton.x,
      y: expandButton.y,
    });
  await Bun.sleep(100);
  const expandedWidth = await evaluate<number>(
    "document.querySelector('.workspace-column').getBoundingClientRect().width",
  );

  if (Math.abs(draggedWidth - (before.width + 96)) > 2)
    throw new Error(`Drag failed: ${before.width}px -> ${draggedWidth}px`);
  if (hover.active === hover.other || hover.other !== before.otherColor)
    throw new Error("Hover styling affected more than the active divider");
  if (collapsed.width !== 68 || !collapsed.compact)
    throw new Error(
      `Collapse failed: ${collapsed.width}px, compact=${collapsed.compact}`,
    );
  if (Math.abs(expandedWidth - draggedWidth) > 2)
    throw new Error(
      `Expand failed: ${collapsed.width}px -> ${expandedWidth}px`,
    );

  await evaluate(
    "document.querySelector('.app-mode-switcher button:nth-child(2)').click()",
  );
  await Bun.sleep(250);
  const statusTelemetry = await evaluate<{
    heading: string;
    status: string;
    context: string;
    usage: string;
  }>(`(() => ({
    heading: document.querySelector('.terminal-heading h1')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
    status: document.querySelector('.agent-session-status-primary')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
    context: document.querySelector('.agent-session-context')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
    usage: document.querySelector('.provider-usage')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
  }))()`);
  if (!statusTelemetry.heading.includes("claude-fable-5-1[1m]"))
    throw new Error(
      `Session heading is missing the model: ${statusTelemetry.heading}`,
    );
  if (!statusTelemetry.status.includes("claude-fable-5-1[1m]"))
    throw new Error(
      `Status line is missing the model: ${statusTelemetry.status}`,
    );
  if (!statusTelemetry.context.includes("Context 61k/1000k"))
    throw new Error(
      `Claude context is missing or malformed: ${statusTelemetry.context}`,
    );
  for (const expected of [
    "Codex 5h 28% · 7d 61%",
    "Claude 5h 34% · 7d 47%",
  ])
    if (!statusTelemetry.usage.includes(expected))
      throw new Error(
        `Provider usage is missing ${expected}: ${statusTelemetry.usage}`,
      );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await evaluate(
        "Boolean(document.querySelector('.xterm-helper-textarea') && document.querySelector('.xterm-rows'))",
      )
    )
      break;
    await Bun.sleep(50);
  }
  const terminalFont = await evaluate<{
    family: string;
    size: string;
  }>(`(() => {
    const style = getComputedStyle(document.querySelector('.xterm-rows'));
    return { size: style.fontSize, family: style.fontFamily };
  })()`);
  if (terminalFont.size !== "13px")
    throw new Error(`Terminal font mismatch: ${terminalFont.size}`);
  if (!terminalFont.family.includes("MesloLGS NF"))
    throw new Error(`Terminal font family mismatch: ${terminalFont.family}`);

  const collapseAndMeasureTerminal = async (label: string) => {
    const beforeCols = await evaluate<number>(
      "Number(document.querySelector('.terminal').dataset.terminalCols)",
    );
    const button = await evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('[aria-label="Collapse ${label} panel"]').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"] as const)
      await send("Input.dispatchMouseEvent", {
        type,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
        x: button.x,
        y: button.y,
      });
    await Bun.sleep(300);
    const afterCols = await evaluate<number>(
      "Number(document.querySelector('.terminal').dataset.terminalCols)",
    );
    if (afterCols <= beforeCols)
      throw new Error(
        `${label} collapse did not refit terminal: ${beforeCols} -> ${afterCols} cols`,
      );
    return { beforeCols, afterCols };
  };
  const sessionsCollapse = await collapseAndMeasureTerminal("sessions");
  const workspaceCollapse = await collapseAndMeasureTerminal("workspace");

  const terminalBeforeResize = await evaluate<{ cols: number; width: number }>(
    `(() => {
      const terminal = document.querySelector('.terminal');
      return {
        cols: Number(terminal.dataset.terminalCols),
        width: terminal.getBoundingClientRect().width,
      };
    })()`,
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await Bun.sleep(450);
  const terminalAfterResize = await evaluate<{ cols: number; width: number }>(
    `(() => {
      const terminal = document.querySelector('.terminal');
      return {
        cols: Number(terminal.dataset.terminalCols),
        width: terminal.getBoundingClientRect().width,
      };
    })()`,
  );
  if (terminalAfterResize.width >= terminalBeforeResize.width)
    throw new Error(
      `Viewport resize did not shrink terminal: ${terminalBeforeResize.width}px -> ${terminalAfterResize.width}px`,
    );
  if (
    !terminalAfterResize.cols ||
    terminalAfterResize.cols >= terminalBeforeResize.cols
  )
    throw new Error(
      `Terminal grid did not refit: ${terminalBeforeResize.cols} cols -> ${terminalAfterResize.cols} cols`,
    );

  const screenshot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(
    `Panel browser check passed: drag ${before.width}px -> ${draggedWidth}px; collapse -> ${collapsed.width}px; expand -> ${expandedWidth}px`,
  );
  console.log(
    `Terminal font check passed: ${terminalFont.family} at ${terminalFont.size}`,
  );
  console.log(
    `Terminal resize check passed: ${terminalBeforeResize.width}px/${terminalBeforeResize.cols} cols -> ${terminalAfterResize.width}px/${terminalAfterResize.cols} cols`,
  );
  console.log(
    `Terminal panel-collapse checks passed: sessions ${sessionsCollapse.beforeCols} -> ${sessionsCollapse.afterCols} cols; workspace ${workspaceCollapse.beforeCols} -> ${workspaceCollapse.afterCols} cols`,
  );
  console.log(
    `Status telemetry check passed: ${statusTelemetry.status}; ${statusTelemetry.context}; ${statusTelemetry.usage}`,
  );
  console.log(`Screenshot: ${screenshotPath}`);
  socket.close();
} finally {
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

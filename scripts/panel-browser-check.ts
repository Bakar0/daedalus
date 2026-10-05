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
const profile = await mkdtemp(
  join(artifactsDirectory, ".panel-check-profile-"),
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await evaluate(
        "Boolean(document.querySelector('.workspace-panel-resize-handle'))",
      )
    )
      break;
    await Bun.sleep(50);
  }

  // The secondary panel only exists beside the board. The
  // view under test is chosen rather than inherited from whichever tab happens
  // to be first, so a change to the default (#27 made it the board) does not
  // silently change what this checks.
  // Waiting for the tab itself rather than for something rendered near it:
  // the loop above breaks on success but simply falls through on timeout, so a
  // page that never rendered used to surface as a confusing failure later.
  let openedBoard = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    openedBoard = await evaluate<string>(`(() => {
      const tabs = [...document.querySelectorAll('.app-mode-switcher button')];
      const board = tabs.find((tab) => tab.textContent.trim() === 'Board');
      if (!board) return 'tabs: ' + JSON.stringify(tabs.map((t) => t.textContent));
      board.click();
      return 'ok';
    })()`);
    if (openedBoard === "ok") break;
    await Bun.sleep(50);
  }
  if (openedBoard !== "ok")
    throw new Error(
      `The board tab never appeared (${openedBoard}); body: ${await evaluate<string>(
        "document.body.innerText.slice(0, 200)",
      )}; renderer errors: ${rendererErrors.slice(0, 3).join(" | ") || "none"}`,
    );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await evaluate(
        "Boolean(document.querySelector('.secondary-panel-resize-handle'))",
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

  // The column no longer folds to a rail (#55): it has no collapse button,
  // and a drag far to the left stops at its minimum width.
  const dragWorkspaceHandle = async (distance: number) => {
    const handle = await evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('.workspace-panel-resize-handle').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
      ...handle,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      x: handle.x + distance,
      y: handle.y,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      x: handle.x + distance,
      y: handle.y,
    });
    await Bun.sleep(150);
    return evaluate<number>(
      "document.querySelector('.workspace-column').getBoundingClientRect().width",
    );
  };
  const narrowest = await dragWorkspaceHandle(-400);
  const collapseControl = await evaluate<boolean>(
    `Boolean(document.querySelector('.workspace-column .panel-collapse-button'))`,
  );

  if (Math.abs(draggedWidth - (before.width + 96)) > 2)
    throw new Error(`Drag failed: ${before.width}px -> ${draggedWidth}px`);
  if (hover.active === hover.other || hover.other !== before.otherColor)
    throw new Error("Hover styling affected more than the active divider");
  if (narrowest !== 200)
    throw new Error(
      `The column narrowed to ${narrowest}px, not its 200px minimum`,
    );
  if (collapseControl)
    throw new Error("The workspace column still has a collapse button");

  // The session is opened from its card under the workspace (#55).
  await evaluate(
    "document.querySelector('.session-card-main[data-session-id=\"panel-test-agent\"]').click()",
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
  for (const expected of ["Codex 5h 28% · 7d 61%", "Claude 5h 34% · 7d 47%"])
    // Compared without spaces: the usage meters are separate elements, so
    // textContent runs their labels together.
    if (
      !statusTelemetry.usage
        .replace(/\s+/g, "")
        .includes(expected.replace(/\s+/g, ""))
    )
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

  // Folding a workspace's session list, one at a time and all at once, and
  // the fold surviving a reload (#55). The terminal stays: folding a list is
  // not leaving the session.
  const fold = () =>
    evaluate<{
      expanded: string | null;
      cards: number;
      icons: number;
      all: string | null;
      terminal: boolean;
    }>(`(() => ({
      expanded: document.querySelector('.workspace-disclosure')?.getAttribute('aria-expanded') ?? null,
      cards: document.querySelectorAll('.workspace-sessions .session-card').length,
      icons: document.querySelectorAll('.workspace-session-icons').length,
      all: document.querySelector('.workspace-fold-all')?.getAttribute('aria-label') ?? null,
      terminal: Boolean(document.querySelector('.workspace-shell.mode-session .terminal-column')),
    }))()`);
  const unfolded = await fold();
  if (
    unfolded.expanded !== "true" ||
    unfolded.cards < 3 ||
    unfolded.icons !== 0
  )
    throw new Error(
      `The session list did not start open: ${JSON.stringify(unfolded)}`,
    );
  await evaluate("document.querySelector('.workspace-disclosure').click()");
  await Bun.sleep(100);
  const folded = await fold();
  if (
    folded.expanded !== "false" ||
    folded.cards !== 0 ||
    folded.icons !== 1 ||
    folded.all !== "Expand all session lists" ||
    !folded.terminal
  )
    throw new Error(`Folding the list failed: ${JSON.stringify(folded)}`);
  await send("Page.reload");
  // The old document answers until the new one replaces it.
  await Bun.sleep(400);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await evaluate("Boolean(document.querySelector('.workspace-disclosure'))")
    )
      break;
    await Bun.sleep(50);
  }
  const reloaded = await fold();
  if (reloaded.expanded !== "false" || reloaded.cards !== 0)
    throw new Error(
      `The fold did not survive a reload: ${JSON.stringify(reloaded)}`,
    );
  await evaluate("document.querySelector('.workspace-fold-all').click()");
  await Bun.sleep(100);
  const expandedAll = await fold();
  if (expandedAll.expanded !== "true" || expandedAll.cards < 3)
    throw new Error(`Expand all failed: ${JSON.stringify(expandedAll)}`);
  await evaluate(
    "document.querySelector('.session-card-main[data-session-id=\"panel-test-agent\"]').click()",
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await evaluate(
        "Boolean(document.querySelector('.xterm-rows') && document.querySelector('.terminal')?.dataset.terminalCols)",
      )
    )
      break;
    await Bun.sleep(50);
  }

  // Widening the column narrows the terminal, and its grid refits.
  const colsBeforeWiden = await evaluate<number>(
    "Number(document.querySelector('.terminal').dataset.terminalCols)",
  );
  await dragWorkspaceHandle(120);
  await Bun.sleep(300);
  const colsAfterWiden = await evaluate<number>(
    "Number(document.querySelector('.terminal').dataset.terminalCols)",
  );
  if (!colsAfterWiden || colsAfterWiden >= colsBeforeWiden)
    throw new Error(
      `Widening the column did not refit the terminal: ${colsBeforeWiden} -> ${colsAfterWiden} cols`,
    );

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
    `Panel browser check passed: drag ${before.width}px -> ${draggedWidth}px; narrowest ${narrowest}px, no collapse button`,
  );
  console.log(
    `Terminal font check passed: ${terminalFont.family} at ${terminalFont.size}`,
  );
  console.log(
    `Terminal resize check passed: ${terminalBeforeResize.width}px/${terminalBeforeResize.cols} cols -> ${terminalAfterResize.width}px/${terminalAfterResize.cols} cols`,
  );
  console.log(
    `Terminal refit check passed: widening the column ${colsBeforeWiden} -> ${colsAfterWiden} cols; session lists fold, unfold and stay folded across a reload`,
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

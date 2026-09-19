/**
 * Watches where the caret goes when a session is opened from the list.
 *
 * Opening a session is supposed to leave you able to type at it, and the bug
 * that broke it is invisible to a renderer test, which only ever sees one
 * frame: a session going `starting` → `running` rebuilds the terminal, and the
 * rebuild disposes the textarea the caret was sitting in. Every frame either
 * side of it looks right. What the user gets is a second click before they can
 * type — and since a new session is always `starting` first, that is every new
 * session.
 *
 * So this drives a real browser with real mouse input and reads
 * `document.activeElement` across the moment it used to be lost. The first
 * assertion, on a session that is already running, never failed; it is here
 * because it is the case everything else is measured against, and a check that
 * only watched the rebuild could pass while ordinary opening broke.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const port = 41745;
const debuggingPort = 41746;
const pageUrl = `http://127.0.0.1:${port}/panel-test.html`;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactsDirectory = join(projectRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(
  join(artifactsDirectory, ".focus-check-profile-"),
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
      if (attempt === 99) throw new Error("Focus test server did not start");
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

  // The tab is found by its name rather than its position: the app opens on
  // the workspace and the switcher has gained tabs, so an index picks a
  // different view than it used to and the failure surfaces much later as
  // "no session cards".
  let inSessionsMode = false;
  let tabs = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      (await evaluate<number>(
        "document.querySelectorAll('.session-grid .session-card').length",
      )) >= 4
    ) {
      inSessionsMode = true;
      break;
    }
    tabs = await evaluate<string>(`(() => {
      const all = [...document.querySelectorAll('.app-mode-switcher button')];
      const sessions = all.find((tab) => tab.textContent.trim() === 'Sessions');
      if (!sessions) return JSON.stringify(all.map((tab) => tab.textContent.trim()));
      sessions.click();
      return 'ok';
    })()`);
    await Bun.sleep(50);
  }
  if (!inSessionsMode)
    throw new Error(
      `Session cards did not render (tabs: ${tabs})${rendererErrors.length ? `: ${rendererErrors.slice(0, 2).join("; ")}` : ""}`,
    );

  /**
   * The first terminal has to finish mounting before anything is clicked. The
   * grid is still being laid out until it does, so a click dispatched at a
   * measured point can land on a card that has since moved.
   */
  let settled = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await evaluate<boolean>(
        "Boolean(document.querySelector('.agent-terminal-shell .xterm-helper-textarea'))",
      )
    ) {
      settled = true;
      break;
    }
    await Bun.sleep(50);
  }
  if (!settled) throw new Error("The first session terminal never mounted");

  /**
   * Where the caret is, named rather than asserted on directly, so a failure
   * says what did have focus instead of only that the terminal did not.
   */
  const caret = () =>
    evaluate<string>(`(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return 'the page body';
      if (active.closest('.agent-terminal-shell')) return 'the session terminal';
      const name = active.tagName.toLowerCase();
      const label = (active.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      return label ? name + ' "' + label + '"' : name;
    })()`);

  /**
   * A real click, dispatched through the browser rather than synthesised in
   * the page: a synthetic `click` never runs the default focus behaviour that
   * a press on a button has, so it cannot show whether the terminal wins the
   * caret back from the card the user actually pressed.
   */
  const clickCard = async (sessionId: string) => {
    const point = await evaluate<{ x: number; y: number }>(`(() => {
      const card = [...document.querySelectorAll('.session-card-main')]
        .find((node) => node.dataset.sessionId === ${JSON.stringify(sessionId)});
      if (!card) throw new Error('no card for ${sessionId}');
      const box = card.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    // Confirmed rather than assumed: a click that selected nothing would
    // otherwise be reported as a focus failure, which is a different bug.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (
        (await evaluate<string | null>(
          "document.querySelector('.session-card.selected [data-session-id]')?.dataset.sessionId ?? null",
        )) === sessionId
      )
        return;
      await Bun.sleep(50);
    }
    throw new Error(`Clicking the ${sessionId} card did not select it`);
  };

  /** Polled, because focus lands a frame or two after the click. */
  const caretSettlesOnTerminal = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if ((await caret()) === "the session terminal") return true;
      await Bun.sleep(50);
    }
    return false;
  };

  const failures: string[] = [];

  // 1. Opening a running session from the list.
  await clickCard("panel-test-third");
  if (!(await caretSettlesOnTerminal()))
    failures.push(
      `opening a running session left the caret on ${await caret()}, so typing would have needed another click`,
    );

  // 2. Opening a session that is still starting, then letting it start. The
  //    caret has to survive the rebuild that the status change forces.
  await clickCard("panel-test-starting");
  if (!(await caretSettlesOnTerminal()))
    failures.push(
      `opening a starting session left the caret on ${await caret()}`,
    );
  else {
    await evaluate(
      "window.panelTest.setAgentStatus('panel-test-starting', 'running')",
    );
    // Long enough for the teardown, the rebuild and the frame that follows.
    await Bun.sleep(500);
    const after = await caret();
    if (after !== "the session terminal")
      failures.push(
        `the session finishing startup rebuilt its terminal and dropped the caret onto ${after}`,
      );
  }

  await Bun.write(
    join(artifactsDirectory, "session-focus-check.png"),
    Buffer.from(
      (
        await send<{ data: string }>("Page.captureScreenshot", {
          format: "png",
        })
      ).data,
      "base64",
    ),
  );

  if (rendererErrors.length)
    failures.push(`renderer errors: ${rendererErrors.slice(0, 3).join("; ")}`);
  if (failures.length) {
    console.error(`Session focus check failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(
      "Session focus check passed: opening a session from the list puts the caret in its terminal, and startup finishing does not take it away.",
    );
  }
  socket.close();
} finally {
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

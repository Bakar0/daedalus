// Drives the Map bar and panel (map-test.html) in headless Chrome: the
// canvas, the legend, relation lines, the heartbeat, hover, collapse, dropped items,
// history and a live update, in both themes. Screenshots go to artifacts/.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const port = 41771;
const debuggingPort = 41772;
const pageUrl = `http://127.0.0.1:${port}/map-test.html`;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactsDirectory = join(projectRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(join(artifactsDirectory, ".map-check-profile-"));

const watchdog = setTimeout(() => {
  console.error("Map UI check timed out");
  process.exit(1);
}, 120_000);

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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(pageUrl)).ok) break;
    } catch {
      if (attempt === 199) throw new Error("Map test server did not start");
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
      "--window-size=1500,980",
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
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
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
        (message.params.args ?? [])
          .map((arg: { value?: unknown; description?: string }) =>
            String(arg.value ?? arg.description ?? ""),
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
  const send = <T>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolveRequest, rejectRequest) => {
      const id = ++sequence;
      pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
      });
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
  const waitFor = async (what: string, expression: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await evaluate<boolean>(expression)) return;
      await Bun.sleep(25);
    }
    throw new Error(
      `Timed out waiting for ${what}; renderer errors: ${rendererErrors.join(" | ") || "none"}`,
    );
  };
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
  };
  const screenshot = async (name: string) => {
    const shot = await send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const path = join(artifactsDirectory, `map-ui-check-${name}.png`);
    await Bun.write(path, Buffer.from(shot.data, "base64"));
    return path;
  };
  const hover = async (selector: string) => {
    const point = await evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: rect.left + 12, y: rect.top + 8 };
    })()`);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await waitFor(
    "the canvas and its relation lines",
    "document.querySelectorAll('.flow-edge[data-relation]').length > 0",
  );

  // The legend opens from the toolbar, over the canvas.
  check(
    !(await evaluate<boolean>(
      "Boolean(document.querySelector('.flow-legend'))",
    )),
    "The legend is open before it was asked for",
  );
  await evaluate(
    "[...document.querySelectorAll('.flow-tool')].find((n) => n.textContent === 'Legend').click()",
  );
  await waitFor(
    "the legend",
    "Boolean(document.querySelector('.flow-legend'))",
  );

  // The canvas: the root frame, its columns, the boxes inside, every flow.
  const layout = await evaluate<{
    columns: string[];
    boxes: number;
    legend: string[];
    edges: string[];
    labels: string[];
  }>(`(() => ({
    columns: [...document.querySelectorAll('.flow-column > .flow-head .flow-name')].map((n) => n.textContent),
    boxes: document.querySelectorAll('.flow-box').length,
    legend: [...document.querySelectorAll('.flow-legend b')].map((n) => n.textContent),
    edges: [...document.querySelectorAll('.flow-edge[data-relation]')].map((n) => n.getAttribute('data-relation')),
    labels: [...document.querySelectorAll('.flow-edge-label')].map((n) => n.textContent),
  }))()`);
  check(
    JSON.stringify(layout.columns) ===
      JSON.stringify(["Web client", "API server", "Data"]),
    `Columns: ${JSON.stringify(layout.columns)}`,
  );
  check(layout.boxes === 6, `Expected 6 boxes, saw ${layout.boxes}`);
  check(
    JSON.stringify(layout.legend) ===
      JSON.stringify([
        "calls",
        "publishes to",
        "reads from",
        "writes to",
        "depends on",
      ]),
    `Legend: ${JSON.stringify(layout.legend)}`,
  );
  check(
    layout.edges.length === 6,
    `Expected 6 live relation lines (the dropped one hidden), saw ${layout.edges.length}`,
  );
  check(
    layout.labels.includes("calls · REST /orders") &&
      layout.labels.includes("publishes to · order.paid"),
    `Labels: ${JSON.stringify(layout.labels)}`,
  );

  const legendShot = await screenshot("legend");
  await evaluate(
    "[...document.querySelectorAll('.flow-tool')].find((n) => n.textContent === 'Legend').click()",
  );

  // No two relation labels cover each other.
  const overlaps = await evaluate<string[]>(`(() => {
    const boxes = [...document.querySelectorAll('.flow-edge-label')].map((n) => ({ text: n.textContent, r: n.getBoundingClientRect() }));
    const out = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r, b = boxes[j].r;
        if (a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2)
          out.push(boxes[i].text + ' / ' + boxes[j].text);
      }
    return out;
  })()`);
  check(!overlaps.length, `Overlapping labels: ${JSON.stringify(overlaps)}`);

  // Every relation type is drawn in its own pattern and colour.
  const styles = await evaluate<
    Record<string, { stroke: string; dash: string }>
  >(`(() => {
    const out = {};
    for (const path of document.querySelectorAll('.flow-edge[data-relation]')) {
      const type = path.getAttribute('data-relation').split('>')[2];
      const style = getComputedStyle(path);
      out[type] = { stroke: style.stroke, dash: style.strokeDasharray };
    }
    return out;
  })()`);
  const strokes = new Set(Object.values(styles).map((style) => style.stroke));
  check(strokes.size === 5, `Relation colours: ${JSON.stringify(styles)}`);
  check(
    styles.calls?.dash === "none" && styles["publishes to"]?.dash !== "none",
    `Relation patterns: ${JSON.stringify(styles)}`,
  );

  // Ends meeting one side of a box spread out instead of meeting at a point.
  const starts = await evaluate<string[]>(`(() =>
    [...document.querySelectorAll('.flow-edge[data-relation^="page>"]')].map((path) =>
      path.getAttribute('d').split(' ')[0]))()`);
  check(
    new Set(starts).size === starts.length,
    `Lines leaving the checkout page share a point: ${JSON.stringify(starts)}`,
  );

  // The flow line: green up to the stage at work, which beats; amber for an
  // agent waiting on the user; stalled when the session is gone.
  const stations = await evaluate<{
    done: number;
    working: number;
    attention: number;
    stalled: string[];
    waiting: number;
    animation: string;
    lit: number;
  }>(`(() => ({
    done: document.querySelectorAll('.flow-station-done').length,
    working: document.querySelectorAll('.flow-beat-working').length,
    attention: document.querySelectorAll('.flow-beat-attention').length,
    stalled: [...document.querySelectorAll('.flow-beat-stalled')].map((n) => n.closest('[data-component]').querySelector('.flow-name').textContent),
    waiting: document.querySelectorAll('.flow-station-waiting').length,
    animation: getComputedStyle(document.querySelector('.flow-beat-working')).animationName,
    lit: document.querySelectorAll('.flow-segment-lit').length,
  }))()`);
  check(stations.done >= 8, `Done stations: ${stations.done}`);
  check(
    stations.working >= 3 && stations.animation === "flow-heartbeat",
    `Heartbeat: ${JSON.stringify(stations)}`,
  );
  check(stations.attention === 1, `Attention beats: ${stations.attention}`);
  check(
    JSON.stringify(stations.stalled) === JSON.stringify(["Payments service"]),
    `Stalled: ${JSON.stringify(stations.stalled)}`,
  );
  check(stations.waiting === 3, `Waiting stations: ${stations.waiting}`);
  check(stations.lit > 0, "No green line segments");
  const dark = await screenshot("dark");

  // Hovering a running stage shows who holds it; clicking opens the session.
  await hover('[data-component="form"] .flow-beat-attention');
  await waitFor(
    "the stage card",
    "Boolean(document.querySelector('.flow-stage-card'))",
  );
  const card = await evaluate<string>(
    "document.querySelector('.flow-stage-card').innerText",
  );
  check(
    card.includes("Designer") &&
      card.includes("needs you") &&
      card.includes("Card form on one line or two?"),
    `Stage card: ${card}`,
  );
  const cardShot = await screenshot("stage-card");
  await evaluate(
    "document.querySelector('[data-component=\"form\"] .flow-beat-attention').click()",
  );
  check(
    (await evaluate<string[]>("window.mapTest.opened")).includes(
      "session:s-designer",
    ),
    "Clicking a running stage did not open its session",
  );

  // Hovering a box lights its relations and fades the rest.
  await hover('[data-component="orders"] .flow-name');
  await waitFor(
    "hover highlight",
    "Boolean(document.querySelector('.flow-edges-faded')) && document.querySelector('[data-component=\"orders\"]').classList.contains('flow-hover')",
  );
  const lit = await evaluate<string[]>(
    "[...document.querySelectorAll('.flow-edge.flow-edge-on')].map((n) => n.getAttribute('data-relation'))",
  );
  check(
    lit.length === 2 && lit.every((key) => key.includes("orders")),
    `Lit relations on hover: ${JSON.stringify(lit)}`,
  );
  const hoverShot = await screenshot("hover");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });

  // Collapsing a column lifts its relations onto it and merges duplicates.
  await evaluate(
    "document.querySelector('[data-component=\"api\"] > .flow-head .flow-caret').click()",
  );
  await waitFor(
    "the collapsed column",
    "document.querySelector('[data-component=\"api\"]').classList.contains('flow-collapsed') && !document.querySelector('[data-component=\"orders\"]')",
  );
  const lifted = await evaluate<string[]>(
    "[...document.querySelectorAll('.flow-edge[data-relation]')].map((n) => n.getAttribute('data-relation'))",
  );
  check(
    lifted.includes("page>api>calls") &&
      lifted.includes("form>api>calls") &&
      lifted.includes("api>worker>publishes to") &&
      lifted.includes("api>db>writes to"),
    `Relations after collapsing the API server: ${JSON.stringify(lifted)}`,
  );
  const collapsedShot = await screenshot("collapsed");
  await evaluate(
    "document.querySelector('[data-component=\"api\"] > .flow-head .flow-caret').click()",
  );

  // Dropped items stay hidden until asked for, then show faint with the reason.
  check(
    !(await evaluate<boolean>(
      "Boolean(document.querySelector('[data-component=\"fraud\"]'))",
    )),
    "A dropped component showed without Dropped on",
  );
  await evaluate(
    "[...document.querySelectorAll('.flow-toggle')].find((n) => n.textContent.startsWith('Dropped')).querySelector('input').click()",
  );
  await waitFor(
    "the dropped column",
    "Boolean(document.querySelector('[data-component=\"fraud\"].flow-dropped'))",
  );
  check(
    (
      await evaluate<string>(
        "document.querySelector('[data-component=\"fraud\"]').innerText",
      )
    ).includes("Dropped: Stripe Radar scores orders already"),
    "The dropped component does not show its reason",
  );
  check(
    await evaluate<boolean>(
      "Boolean(document.querySelector('.flow-edge.flow-edge-dropped[data-relation=\"orders>fraud>calls\"]'))",
    ),
    "The dropped relation is not drawn faint",
  );
  const droppedShot = await screenshot("dropped");

  // A task chip opens the task.
  await evaluate("document.querySelector('.flow-task-chip').click()");
  check(
    (await evaluate<string[]>("window.mapTest.opened")).includes(
      "task:task-12",
    ),
    "The task chip did not open the task",
  );

  // History, and a live change: the agent finishes a stage, the host bumps
  // the revision, and the tab reads the map again.
  await evaluate(
    "[...document.querySelectorAll('.flow-tool')].find((n) => n.textContent === 'History').click()",
  );
  await waitFor(
    "the history",
    "Boolean(document.querySelector('.flow-history li'))",
  );
  const before = await evaluate<number>("window.mapTest.calls.length");
  await evaluate("window.mapTest.advance()");
  await waitFor(
    "the live update",
    "document.querySelector('[data-component=\"page\"] [data-stage=\"implement\"]').dataset.shown === 'done' && document.querySelector('[data-component=\"page\"] [data-stage=\"validate\"]').classList.contains('flow-beat-working')",
  );
  check(
    (
      await evaluate<string>(
        "document.querySelector('.flow-history li').innerText",
      )
    ).includes("Finished implement on 'Checkout page'"),
    "History did not show the new line",
  );
  check(
    (await evaluate<number>("window.mapTest.calls.length")) > before,
    "The map was not read again after the data changed",
  );

  // The light theme keeps the canvas readable.
  await evaluate("window.mapTest.theme('light')");
  await Bun.sleep(100);
  const lightLabel = await evaluate<string>(
    "getComputedStyle(document.querySelector('.flow-edge-label')).stroke",
  );
  check(
    lightLabel === "rgb(238, 242, 249)",
    `Label halo in the light theme: ${lightLabel}`,
  );
  const light = await screenshot("light");

  // The panel stays inside its stage, and Escape closes it; the bar opens
  // it again.
  const inside = await evaluate<boolean>(`(() => {
    const panel = document.querySelector('.flow-map-panel').getBoundingClientRect();
    const stage = document.querySelector('.terminal-stage').getBoundingClientRect();
    return panel.left >= stage.left && panel.right <= stage.right + 1;
  })()`);
  check(inside, "The map panel is wider than the stage it sits on");
  await evaluate(
    "document.querySelector('.flow-map-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
  );
  await waitFor(
    "the panel to close",
    "!document.querySelector('.flow-map-panel')",
  );
  await evaluate("document.querySelector('.flow-map-bar button').click()");
  await waitFor(
    "the panel to open",
    "Boolean(document.querySelector('.flow-map-panel'))",
  );

  // Nothing overflows the page sideways outside the canvas's own scroller.
  const sideways = await evaluate<boolean>(
    "document.documentElement.scrollWidth > window.innerWidth + 1",
  );
  check(!sideways, "The page scrolls sideways");
  check(
    rendererErrors.length === 0,
    `Renderer errors: ${rendererErrors.join(" | ")}`,
  );

  console.log(
    `Map UI check passed: ${layout.boxes} boxes in ${layout.columns.length} columns, ${layout.edges.length} relation lines in 5 styles, heartbeat working/attention/stalled, hover, collapse, dropped, history and a live update`,
  );
  for (const path of [
    dark,
    legendShot,
    cardShot,
    hoverShot,
    collapsedShot,
    droppedShot,
    light,
  ])
    console.log(`Screenshot: ${path}`);
  socket.close();
} finally {
  clearTimeout(watchdog);
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

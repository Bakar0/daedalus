/**
 * Drives a real drag in a real browser and watches what the list does at the
 * moment the card is dropped.
 *
 * This exists because the bug it checks for is invisible to every other test
 * we have: the order was always *eventually* right, and the renderer tests
 * only ever see one frame. Dropping a card put the pre-drag order back on
 * screen for the length of one round trip, so the card sprang home and then
 * re-landed — correct, and wrong to look at. The only way to catch that is to
 * sample the DOM across the drop, which is what this does.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const port = 41743;
const debuggingPort = 41744;
const pageUrl = `http://127.0.0.1:${port}/panel-test.html`;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactsDirectory = join(projectRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(
  join(artifactsDirectory, ".reorder-check-profile-"),
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
const failures: string[] = [];
try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(pageUrl)).ok) break;
    } catch {
      if (attempt === 99) throw new Error("Reorder test server did not start");
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
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await evaluate(
        "Boolean(document.querySelector('.app-mode-switcher button:nth-child(2)'))",
      )
    ) {
      ready = true;
      break;
    }
    await Bun.sleep(50);
  }
  if (!ready) {
    const body = await evaluate<string>(
      "document.body.innerText.slice(0, 1000)",
    );
    throw new Error(
      `Daedalus renderer did not become ready: ${body || "empty document"}${rendererErrors.length ? `\n${rendererErrors.join("\n")}` : ""}`,
    );
  }
  // Clicked in a retry loop rather than once: the switcher exists a frame
  // before the app settles, and a single shot races the next render.
  let inSessionsMode = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      (await evaluate<number>(
        "document.querySelectorAll('.session-grid .session-card').length",
      )) >= 3
    ) {
      inSessionsMode = true;
      break;
    }
    await evaluate(
      "document.querySelector('.app-mode-switcher button:nth-child(2)')?.click() ?? null",
    );
    await Bun.sleep(50);
  }
  if (!inSessionsMode) {
    const diagnostics = await evaluate<string>(`JSON.stringify({
      shell: document.querySelector('.workspace-shell')?.className ?? null,
      grids: document.querySelectorAll('.session-grid').length,
      cards: document.querySelectorAll('.session-card').length,
      buttons: [...document.querySelectorAll('.app-mode-switcher button')].map((b) => b.textContent),
    })`);
    throw new Error(
      `Session cards did not render. DOM: ${diagnostics}${rendererErrors.length ? `\nRenderer: ${rendererErrors.slice(0, 2).join("; ")}` : ""}`,
    );
  }

  /**
   * The gesture is driven with real mouse input rather than PointerEvents
   * synthesised in the page. Chrome derives pointer events from it, so the
   * drag sees exactly what a hand produces — and, unlike synthetic events, it
   * moves the actual cursor, which is the only way `:hover` means anything.
   * An earlier version of this check dispatched events in-page and its hover
   * assertion passed whether or not the fix was present.
   */
  const geometry = await evaluate<{
    before: string[];
    x: number;
    startY: number;
    dropY: number;
  }>(`(() => {
    const order = [...document.querySelectorAll('.session-grid .session-card [data-session-id]')]
      .map((node) => node.dataset.sessionId);
    const cards = [...document.querySelectorAll('.session-grid .session-card')];
    const box = cards[2].getBoundingClientRect();
    const topBox = cards[0].getBoundingClientRect();
    return {
      before: order,
      x: Math.round(box.left + box.width / 2),
      startY: Math.round(box.top + box.height / 2),
      // Above the first card's midpoint, so the held card belongs at index 0.
      dropY: Math.round(topBox.top + topBox.height / 2) - 6,
    };
  })()`);

  const mouse = (
    type: string,
    y: number,
    extra: Record<string, unknown> = {},
  ) =>
    send("Input.dispatchMouseEvent", {
      type,
      x: geometry.x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
      ...extra,
    });

  await mouse("mousePressed", geometry.startY);
  // Past the 5px threshold, then up and over the first card.
  for (const y of [
    geometry.startY - 12,
    geometry.startY - 40,
    geometry.dropY,
  ]) {
    await mouse("mouseMoved", y);
    await Bun.sleep(40);
  }

  // Mid-drag, with the card in hand and the cursor physically over a card it
  // is only passing across. Exactly one card may look active.
  const midDrag = await evaluate<{
    held: number;
    otherHovered: number;
    reorderingFlag: number;
    opacity: string | null;
  }>(`(() => {
    const held = document.querySelectorAll('[data-dragging="true"]');
    const hovered = [...document.querySelectorAll('.session-grid .session-card:hover')];
    return {
      held: held.length,
      // Pointer capture makes :hover follow the card in hand, which is right.
      // What must never happen is a card the pointer is merely crossing
      // lighting up as well — that is the second highlight that made it
      // unclear which card was being moved.
      otherHovered: hovered.filter((node) => node !== held[0]).length,
      reorderingFlag: document.querySelectorAll('.session-grid[data-reordering="true"]').length,
      opacity: held.length ? getComputedStyle(held[0]).opacity : null,
    };
  })()`);

  // Sampling starts before the release and runs across it, which is the only
  // window in which the flicker was ever visible.
  await evaluate(`(() => {
    window.__samples = [];
    window.__dragging = [];
    window.__sampling = true;
    const order = () => [...document.querySelectorAll('.session-grid .session-card [data-session-id]')]
      .map((node) => node.dataset.sessionId).join(',');
    const collect = () => {
      if (!window.__sampling) return;
      window.__samples.push(order());
      window.__dragging.push(document.querySelectorAll('[data-dragging="true"]').length);
      requestAnimationFrame(collect);
    };
    collect();
    return null;
  })()`);

  await mouse("mouseReleased", geometry.dropY);

  const result = await evaluate<{
    samples: string[];
    after: string[];
    draggingCount: number[];
  }>(`(async () => {
    // Well past the page's simulated 120ms write plus its refresh.
    await new Promise((settle) => setTimeout(settle, 600));
    window.__sampling = false;
    return {
      samples: window.__samples,
      draggingCount: window.__dragging,
      after: [...document.querySelectorAll('.session-grid .session-card [data-session-id]')]
        .map((node) => node.dataset.sessionId),
    };
  })()`);

  const before = geometry.before.join(",");
  const after = result.after.join(",");
  const expected = [
    geometry.before[2],
    geometry.before[0],
    geometry.before[1],
  ].join(",");

  if (geometry.before.length !== 3)
    failures.push(`expected 3 session cards, saw ${geometry.before.length}`);
  if (after !== expected)
    failures.push(
      `drag did not land: expected "${expected}" but the list settled on "${after}"`,
    );

  // The regression itself. Once the card is dropped, the pre-drag order must
  // never reappear — not for one frame — or the card is visibly springing back
  // before it re-lands.
  const revertedAt = result.samples.indexOf(before);
  if (revertedAt !== -1)
    failures.push(
      `list flickered back to the pre-drag order at sample ${revertedAt} of ${result.samples.length} ("${before}")`,
    );

  const distinct = [...new Set(result.samples)];
  if (distinct.length > 1)
    failures.push(
      `list changed order ${distinct.length - 1} time(s) after the drop: ${distinct.map((entry) => `"${entry}"`).join(" -> ")}`,
    );

  // And the card must be released: a stuck data-dragging would leave the whole
  // list with pointer-events: none and nothing clickable.
  if (result.draggingCount.at(-1) !== 0)
    failures.push(
      `a card was still marked as dragging after the drop (${result.draggingCount.at(-1)})`,
    );

  // Exactly one card may look active mid-drag. Before this was fixed, every
  // card the pointer crossed also lit its own :hover background, so a second
  // highlight slid down the column independently of the card in hand.
  if (midDrag.held !== 1)
    failures.push(
      `expected exactly one card marked as held mid-drag, saw ${midDrag.held}`,
    );
  if (midDrag.reorderingFlag !== 1)
    failures.push("the session list was not marked as reordering mid-drag");
  // An invariant guard rather than a regression test: pointer capture already
  // keeps :hover on the held card, so this does not fail today even with the
  // stylesheet's safety net removed. It is here to catch the day capture stops
  // being established and a second highlight starts trailing the pointer.
  if (midDrag.otherHovered !== 0)
    failures.push(
      `${midDrag.otherHovered} card(s) other than the held one matched :hover mid-drag, so a second highlight follows the pointer across cards it is only passing over`,
    );
  // And the held card must not be faded, which reads as disabled.
  if (midDrag.opacity !== null && Number(midDrag.opacity) < 1)
    failures.push(
      `the held card was faded to opacity ${midDrag.opacity}, which reads as disabled rather than picked up`,
    );

  if (rendererErrors.length)
    failures.push(`renderer errors: ${rendererErrors.join("; ")}`);

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Reorder check passed: "${before}" -> "${after}" with no intermediate order across ${result.samples.length} sampled frames.`,
    );
  }
} finally {
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

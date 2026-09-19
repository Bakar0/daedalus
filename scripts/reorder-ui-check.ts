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
        "Boolean([...document.querySelectorAll('.app-mode-switcher button')].find((b) => b.textContent === 'Sessions'))",
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
      "[...document.querySelectorAll('.app-mode-switcher button')].find((b) => b.textContent === 'Sessions')?.click() ?? null",
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
   * assertion passed whether or not the code under test was present.
   */
  interface DragOutcome {
    before: string[];
    after: string[];
    samples: string[];
    draggingCount: number[];
    /** The held card's appearance at each step of the gesture. */
    trace: Array<{
      heldId: string | null;
      otherHovered: number;
      background: string | null;
      opacity: string | null;
      reordering: number;
    }>;
  }

  /**
   * Drags one card to a target slot and records what the list does throughout.
   *
   * Both directions are exercised because they are not symmetric under the
   * hood: React moves the minimum number of DOM nodes, which is the dragged
   * node when it travels down the list and its neighbours when it travels up.
   * A card that keeps its appearance dragging up can still lose it dragging
   * down, which is exactly the bug this grew to cover.
   */
  const runDrag = async (
    fromIndex: number,
    toIndex: number,
  ): Promise<DragOutcome> => {
    const geometry = await evaluate<{
      before: string[];
      x: number;
      startY: number;
      dropY: number;
    }>(`(() => {
      const before = [...document.querySelectorAll('.session-grid .session-card [data-session-id]')]
        .map((node) => node.dataset.sessionId);
      const cards = [...document.querySelectorAll('.session-grid .session-card')];
      const box = cards[${fromIndex}].getBoundingClientRect();
      const destination = cards[${toIndex}].getBoundingClientRect();
      const past = ${toIndex} > ${fromIndex} ? 6 : -6;
      return {
        before,
        x: Math.round(box.left + box.width / 2),
        startY: Math.round(box.top + box.height / 2),
        // Just past the destination card's midpoint, so the held card belongs
        // in that slot.
        dropY: Math.round(destination.top + destination.height / 2) + past,
      };
    })()`);

    const mouse = (type: string, y: number) =>
      send("Input.dispatchMouseEvent", {
        type,
        x: geometry.x,
        y,
        button: "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: 1,
      });
    const probe = () =>
      evaluate<DragOutcome["trace"][number]>(`(() => {
        const held = document.querySelector('[data-dragging="true"]');
        const hovered = [...document.querySelectorAll('.session-grid .session-card:hover')];
        return {
          heldId: held?.querySelector('[data-session-id]')?.dataset.sessionId ?? null,
          otherHovered: hovered.filter((node) => node !== held).length,
          background: held ? getComputedStyle(held).backgroundColor : null,
          opacity: held ? getComputedStyle(held).opacity : null,
          reordering: document.querySelectorAll('.session-grid[data-reordering="true"]').length,
        };
      })()`);

    const downward = toIndex > fromIndex;
    await mouse("mousePressed", geometry.startY);
    const trace: DragOutcome["trace"] = [];
    // Past the 5px threshold, then across the list to the destination.
    for (const y of [
      geometry.startY + (downward ? 12 : -12),
      geometry.startY + (downward ? 48 : -48),
      geometry.dropY,
    ]) {
      await mouse("mouseMoved", y);
      // Past the 140ms background transition, so each probe reads a settled
      // value rather than a frame of the pick-up animation.
      await Bun.sleep(220);
      trace.push(await probe());
    }

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

    const settled = await evaluate<{
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

    return { ...settled, before: geometry.before, trace };
  };

  const check = (label: string, outcome: DragOutcome, expected: string[]) => {
    const before = outcome.before.join(",");
    const after = outcome.after.join(",");
    if (after !== expected.join(","))
      failures.push(
        `${label}: did not land — expected "${expected.join(",")}" but the list settled on "${after}"`,
      );

    // Once the card is dropped the pre-drag order must never reappear, not for
    // one frame, or the card visibly springs back before it re-lands.
    const revertedAt = outcome.samples.indexOf(before);
    if (revertedAt !== -1)
      failures.push(
        `${label}: flickered back to the pre-drag order at sample ${revertedAt} of ${outcome.samples.length} ("${before}")`,
      );
    const distinct = [...new Set(outcome.samples)];
    if (distinct.length > 1)
      failures.push(
        `${label}: order changed ${distinct.length - 1} time(s) after the drop: ${distinct.map((entry) => `"${entry}"`).join(" -> ")}`,
      );

    // A stuck data-dragging would leave the list with pointer-events: none and
    // nothing clickable.
    if (outcome.draggingCount.at(-1) !== 0)
      failures.push(`${label}: a card was still marked as dragging after drop`);

    const held = outcome.trace.map((step) => step.heldId);
    if (held.some((id) => id === null))
      failures.push(
        `${label}: the held card lost its dragging state mid-gesture (${JSON.stringify(held)})`,
      );
    if (new Set(held).size > 1)
      failures.push(
        `${label}: the held card changed identity mid-gesture (${JSON.stringify(held)})`,
      );

    // The reported bug: the highlight went away partway through, but only when
    // dragging down. The held card's appearance must not change at all.
    const backgrounds = [...new Set(outcome.trace.map((s) => s.background))];
    if (backgrounds.length > 1)
      failures.push(
        `${label}: the held card's background changed mid-drag (${backgrounds.join(" -> ")}), so its highlight visibly comes and goes`,
      );

    for (const step of outcome.trace) {
      if (step.otherHovered !== 0)
        failures.push(
          `${label}: ${step.otherHovered} card(s) other than the held one matched :hover, so a second highlight trails the pointer`,
        );
      if (step.reordering !== 1)
        failures.push(`${label}: the list was not marked as reordering`);
      if (step.opacity !== null && Number(step.opacity) < 1)
        failures.push(
          `${label}: the held card was faded to opacity ${step.opacity}, which reads as disabled rather than picked up`,
        );
    }
  };

  // Deliberately never the selected card. A selected card takes its background
  // from `.selected`, which does not depend on hit-testing, so dragging it
  // cannot reveal a highlight that is wrongly derived from `:hover` — an
  // earlier version of this check dragged the selected card and passed against
  // the very bug it was written for.
  const selectedIsFirst = await evaluate<boolean>(
    `document.querySelectorAll('.session-grid .session-card')[0]?.classList.contains('selected') ?? false`,
  );
  if (!selectedIsFirst)
    failures.push(
      "expected the first session card to be the selected one; the drags below pick their cards on that assumption",
    );

  // Downward first — the direction that was broken.
  const downward = await runDrag(1, 2);
  check("dragging down", downward, [
    downward.before[0]!,
    downward.before[2]!,
    downward.before[1]!,
  ]);

  const upward = await runDrag(2, 0);
  check("dragging up", upward, [
    upward.before[2]!,
    upward.before[0]!,
    upward.before[1]!,
  ]);

  if (rendererErrors.length)
    failures.push(`renderer errors: ${rendererErrors.join("; ")}`);

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Reorder check passed in both directions: down "${downward.before.join(",")}" -> "${downward.after.join(",")}", up "${upward.before.join(",")}" -> "${upward.after.join(",")}", with no intermediate order and a steady held card across ${downward.samples.length + upward.samples.length} sampled frames.`,
    );
  }
} finally {
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

/**
 * Drives the board in headless Chrome against `board-test.tsx`, a stateful
 * stand-in for the host, and saves screenshots to look at.
 *
 * Static markup cannot see what this checks: lane order after a real click,
 * a card moving lanes when the snapshot changes under it, the confirmation a
 * waiting Start raises, the detail line disappearing at compact width, and
 * geometry. Geometry and colour bugs do not fail assertions, so the
 * screenshots are part of the check, not decoration.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const port = 41761;
const debuggingPort = 41762;
const pageUrl = `http://127.0.0.1:${port}/board-test.html`;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactsDirectory = join(projectRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(
  join(artifactsDirectory, ".board-check-profile-"),
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
// A hung renderer must fail the check, not stall it for ever.
const watchdog = setTimeout(() => {
  console.error("Board UI check timed out");
  chrome?.kill();
  vite.kill();
  process.exit(1);
}, 120_000);

let step = "starting";
try {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(pageUrl)).ok) break;
    } catch {
      if (attempt === 199) throw new Error("Board test server did not start");
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
      "--window-size=1380,860",
      pageUrl,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  let websocketUrl: string | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
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
  const dialogs: string[] = [];
  let acceptDialogs = false;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Page.javascriptDialogOpening") {
      dialogs.push(message.params.message);
      // Answered here, from the socket handler: the page is blocked until it
      // is, so waiting for the next evaluate to do it would deadlock.
      socket.send(
        JSON.stringify({
          id: ++sequence,
          method: "Page.handleJavaScriptDialog",
          params: { accept: acceptDialogs },
        }),
      );
      return;
    }
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
      const deadline = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`${method} timed out during: ${step}`));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(deadline);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(deadline);
          rejectRequest(error);
        },
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
        `${step}: ${
          response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "Browser evaluation failed"
        }`,
      );
    return response.result.value;
  };
  const waitFor = async (expression: string, what: string, tries = 100) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return;
      await Bun.sleep(50);
    }
    throw new Error(`${step}: timed out waiting for ${what}`);
  };
  const failures: string[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(`${step}: ${message}`);
  };
  const calls = (name: string) =>
    evaluate<Array<Record<string, unknown>>>(
      `window.__boardCalls.filter((call) => call.name === ${JSON.stringify(name)}).map((call) => call.params)`,
    );
  const lanes = () =>
    evaluate<Array<{ lane: string; label: string; cards: string[] }>>(`
      [...document.querySelectorAll('.board-lane')].map((section) => ({
        lane: section.dataset.lane,
        label: section.getAttribute('aria-label'),
        cards: [...section.querySelectorAll('.board-card')].map((card) => card.dataset.taskNumber),
      }))`);
  const card = (number: number) =>
    `document.querySelector('.board-card[data-task-number="${number}"]')`;
  /** Clicks a button inside a card by its visible text. */
  const clickInCard = async (number: number, text: string) => {
    const found = await evaluate<boolean>(`(() => {
      const button = [...(${card(number)}?.querySelectorAll('button') ?? [])]
        .find((item) => item.textContent.trim() === ${JSON.stringify(text)});
      if (!button) return false;
      button.scrollIntoView({ block: 'center' });
      button.click();
      return true;
    })()`);
    if (!found) throw new Error(`${step}: no "${text}" button on #${number}`);
  };
  const typeInto = async (selector: string, text: string) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).focus()`,
    );
    await send("Input.insertText", { text });
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
  };
  const screenshot = async (name: string) => {
    const shot = await send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const path = join(artifactsDirectory, `board-ui-check-${name}.png`);
    await Bun.write(path, Buffer.from(shot.data, "base64"));
    return path;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  step = "renderer ready";
  await waitFor(
    "document.querySelectorAll('.board-lane').length === 6",
    "six lanes",
    200,
  ).catch(async (error) => {
    const body = await evaluate<string>(
      "document.body.innerText.slice(0, 800)",
    );
    throw new Error(`${error.message}\n${body}\n${rendererErrors.join("\n")}`);
  });

  step = "lanes";
  const initial = await lanes();
  const expected = [
    ["needs_me", "Needs me, 1 task", ["24"]],
    ["review", "Ready for review, 1 task", ["20"]],
    ["running", "Running, 1 task", ["25"]],
    // #26 is high and its dependency is done; #29 is ready; #27 waits on #25.
    ["queued", "Queued, 3 tasks", ["26", "29", "27"]],
    ["parked", "Parked, 1 task", ["28"]],
    // Collapsed by default: counted, not drawn.
    ["done", "Done, 7 tasks", []],
  ] as const;
  expected.forEach(([lane, label, cards], index) => {
    const actual = initial[index];
    check(
      actual?.lane === lane,
      `lane ${index} is ${actual?.lane}, not ${lane}`,
    );
    check(actual?.label === label, `${lane} says "${actual?.label}"`);
    check(
      JSON.stringify(actual?.cards) === JSON.stringify(cards),
      `${lane} holds ${JSON.stringify(actual?.cards)}, expected ${JSON.stringify(cards)}`,
    );
  });

  step = "card content";
  const needsMe = await evaluate<string>(`${card(24)}.innerText`);
  check(/needs permission 14m/.test(needsMe), `#24 shows no wait: ${needsMe}`);
  check(needsMe.includes("gpt-5 · 12% ctx"), "#24 lacks model and context");
  check(
    needsMe.includes("worktree s-24 · +6 commits, 12 files"),
    `#24 output line: ${needsMe}`,
  );
  check(needsMe.includes("PR #23"), "#24 lacks its PR link");
  const detailVisible = await evaluate<boolean>(
    `getComputedStyle(${card(24)}.querySelector('.board-session-detail')).display !== 'none'`,
  );
  check(detailVisible, "the detail line is hidden at full width");
  const waitingChip = await evaluate<string>(
    `${card(27)}.querySelector('.board-chip')?.getAttribute('aria-label') ?? ''`,
  );
  check(
    waitingChip === "waiting on #25 Board rework, running",
    `#27's chip reads "${waitingChip}"`,
  );
  const doneChip = await evaluate<string>(
    `${card(26)}.querySelector('.board-chip')?.getAttribute('aria-label') ?? ''`,
  );
  check(
    doneChip === "after #23 What actually interrupts a continuous run, done",
    `#26's chip reads "${doneChip}"`,
  );
  check(
    (await evaluate<string>(`${card(27)}.innerText`)).includes("Start ⚠"),
    "#27's Start does not warn",
  );
  check(
    (await evaluate<string>(`${card(29)}.innerText`)).includes("Draft brief"),
    "#29 has an empty brief and no Draft brief",
  );

  step = "geometry";
  const overflow = await evaluate<string[]>(`
    [...document.querySelectorAll('.board-card')].flatMap((element) =>
      element.scrollWidth > element.clientWidth + 1
        ? ['#' + element.dataset.taskNumber + ' overflows by ' + (element.scrollWidth - element.clientWidth) + 'px']
        : [])`);
  check(overflow.length === 0, overflow.join("; "));
  const lanesOverflow = await evaluate<number>(
    "(() => { const el = document.querySelector('.board-lanes'); return el.scrollWidth - el.clientWidth; })()",
  );
  check(lanesOverflow <= 1, `the lanes scroll sideways by ${lanesOverflow}px`);
  await evaluate("document.querySelector('.board-settings').open = true");
  await Bun.sleep(100);
  const popover = await evaluate<{
    right: number;
    bottom: number;
    width: number;
  }>(
    `(() => { const box = document.querySelector('.board-settings-popover').getBoundingClientRect(); return { right: box.right, bottom: box.bottom, width: innerWidth }; })()`,
  );
  check(
    popover.right <= popover.width,
    `the settings popover runs off the right edge (${popover.right} > ${popover.width})`,
  );
  const settingsShot = await screenshot("settings");
  await evaluate("document.querySelector('.board-settings').open = false");
  const wide = await screenshot("wide");

  step = "board settings";
  await evaluate("document.querySelector('.board-settings').open = true");
  await waitFor(
    "document.querySelectorAll('select[aria-label=\"Default model for Start\"] option').length > 1",
    "the model catalog to load",
  );
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="Default model for Start"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'sonnet');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.board-settings').open = false;
  })()`);
  await waitFor(
    "document.querySelector('.board-settings summary').textContent.includes('sonnet')",
    "the summary to name the new default model",
  );
  const settingsCalls = await calls("workspaceUpdate");
  check(
    settingsCalls.at(-1)?.defaultModel === "sonnet",
    `workspaceUpdate got ${JSON.stringify(settingsCalls.at(-1))}`,
  );

  step = "quick capture";
  await typeInto(".board-capture", "Write the release notes");
  await waitFor(
    `[...document.querySelectorAll('.board-lane[data-lane="queued"] .board-card')].some((element) => element.innerText.includes('Write the release notes'))`,
    "the captured task in Queued",
  );
  check(
    (await calls("taskCreate"))[0]?.title === "Write the release notes",
    "taskCreate was not called with the title",
  );
  check(
    (await evaluate<string>(
      "document.querySelector('.board-capture').value",
    )) === "",
    "the capture line did not clear",
  );

  step = "waiting start, declined";
  acceptDialogs = false;
  await clickInCard(27, "Start ⚠");
  await Bun.sleep(200);
  check(
    dialogs.at(-1)?.includes("#25 Board rework is not done yet") ?? false,
    `the confirmation said "${dialogs.at(-1)}"`,
  );
  check((await calls("agentSpawn")).length === 0, "a declined Start spawned");

  step = "waiting start, accepted";
  acceptDialogs = true;
  await clickInCard(27, "Start ⚠");
  await waitFor(
    `document.querySelector('.board-lane[data-lane="running"] .board-card[data-task-number="27"]')`,
    "#27 to move to Running",
  );
  const firstSpawn = (await calls("agentSpawn"))[0];
  check(
    firstSpawn?.taskId === "task-27" &&
      firstSpawn?.provider === "claude" &&
      firstSpawn?.model === "sonnet",
    `Start spawned ${JSON.stringify(firstSpawn)}`,
  );

  step = "start next";
  const beforeNext = (await calls("agentSpawn")).length;
  await evaluate("document.querySelector('.board-start-next').click()");
  await waitFor(
    `document.querySelector('.board-lane[data-lane="running"] .board-card[data-task-number="26"]')`,
    "#26 to start as the top of Queued",
  );
  check(
    (await calls("agentSpawn"))[beforeNext]?.taskId === "task-26",
    "Start next did not take the top of Queued",
  );

  step = "answer";
  await typeInto('input[aria-label="Answer Session for #24"]', "1");
  await waitFor(
    "window.__boardCalls.some((call) => call.name === 'agentSend')",
    "agentSend",
  );
  const answer = (await calls("agentSend"))[0];
  check(
    answer?.id === "s-24" && answer?.text === "1",
    `agentSend got ${JSON.stringify(answer)}`,
  );

  step = "review actions";
  await clickInCard(20, "Open worktree");
  await clickInCard(20, "Open PR");
  await Bun.sleep(150);
  check(
    (await calls("sessionWorktreeOpen"))[0]?.session === "s-20",
    "Open worktree did not ask for #20's worktree",
  );
  check(
    (await calls("openExternal"))[0]?.url ===
      "https://github.com/Bakar0/daedalus/pull/20",
    "Open PR did not open #20's pull request",
  );
  await clickInCard(20, "Mark done");
  await waitFor(
    `!${card(20)}`,
    "#20 to leave the board's open lanes for collapsed Done",
  );
  check(
    (await lanes()).find((group) => group.lane === "done")?.label ===
      "Done, 8 tasks",
    "Done did not count #20",
  );

  step = "second opinion";
  const beforeSecond = (await calls("agentSpawn")).length;
  await clickInCard(25, "Second opinion");
  await waitFor(
    `${card(25)}.querySelectorAll('.board-session-row').length === 2`,
    "a second session row on #25",
  );
  check(
    (await calls("agentSpawn"))[beforeSecond]?.provider === "codex",
    "Second opinion did not pick the other provider",
  );

  step = "chip selects";
  await evaluate(`${card(27)}.querySelector('.board-chip').click()`);
  await waitFor(
    "document.querySelector('.board-detail-column h2')?.textContent.includes('#25')",
    "the inspector to show #25",
  );

  step = "timeline";
  await evaluate(`${card(24)}.click()`);
  await waitFor(
    "document.querySelectorAll('.task-timeline li').length === 7",
    "seven timeline events for #24",
  );
  const cost = await evaluate<string>(
    "document.querySelector('.task-cost p')?.textContent ?? ''",
  );
  check(
    /^1 session · 1h 3\dm so far · peak 64% ctx · gpt-5$/.test(cost),
    `the cost line reads "${cost}"`,
  );
  const inspector = await screenshot("inspector");

  step = "journal link";
  await evaluate("document.querySelector('.task-timeline-journal').click()");
  await waitFor(
    "document.querySelector('.workspace-viewer-content .journal-target')",
    "the journal to open at the #24 heading",
  );
  const target = await evaluate<{
    top: number;
    bottom: number;
    viewerTop: number;
    viewerBottom: number;
    text: string;
  }>(`(() => {
    const heading = document.querySelector('.workspace-viewer-content .journal-target');
    const viewer = document.querySelector('.workspace-viewer-content');
    const box = heading.getBoundingClientRect();
    const frame = viewer.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      viewerTop: frame.top,
      viewerBottom: frame.bottom,
      text: heading.textContent,
    };
  })()`);
  check(
    target.text.startsWith("#24 — A tree that follows"),
    `the journal opened at "${target.text}"`,
  );
  check(
    target.top >= target.viewerTop && target.bottom <= target.viewerBottom,
    "the #24 heading is outside the visible part of the viewer",
  );
  check(
    target.top - target.viewerTop < 120,
    `the #24 heading is ${Math.round(target.top - target.viewerTop)}px down the viewer, not scrolled to`,
  );
  const journal = await screenshot("journal");

  step = "compact width";
  await evaluate(
    "[...document.querySelectorAll('.app-mode-switcher button')].find((b) => b.textContent === 'Board').click()",
  );
  await waitFor("document.querySelector('.board-lanes')", "the board again");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 920,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await Bun.sleep(300);
  const compact = await evaluate<{ width: number; detail: string }>(`({
    width: document.querySelector('.board-column').getBoundingClientRect().width,
    detail: getComputedStyle(${card(24)}.querySelector('.board-session-detail')).display,
  })`);
  check(
    compact.width < 430,
    `the board column is ${compact.width}px, too wide to test compact`,
  );
  check(
    compact.detail === "none",
    "the detail line still shows at compact width",
  );
  const compactOverflow = await evaluate<number>(
    "(() => { const el = document.querySelector('.board-lanes'); return el.scrollWidth - el.clientWidth; })()",
  );
  check(
    compactOverflow <= 1,
    `the lanes scroll sideways by ${compactOverflow}px at compact width`,
  );
  const compactShot = await screenshot("compact");
  await send("Emulation.clearDeviceMetricsOverride");

  step = "reduced motion";
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await Bun.sleep(100);
  const animation = await evaluate<string>(
    "getComputedStyle(document.querySelector('.board-lane-glyph.lane-running'), '::after').animationName",
  );
  check(animation === "none", `the running glyph still animates: ${animation}`);
  await send("Emulation.setEmulatedMedia", { features: [] });

  step = "light theme";
  await evaluate("document.querySelector('.app').dataset.theme = 'light'");
  await Bun.sleep(150);
  const light = await screenshot("light");

  if (rendererErrors.length)
    failures.push(`renderer errors:\n${rendererErrors.join("\n")}`);
  socket.close();
  console.log(
    [wide, settingsShot, inspector, journal, compactShot, light]
      .map((path) => `Screenshot: ${path}`)
      .join("\n"),
  );
  if (failures.length) {
    console.error(`Board UI check failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else console.log("Board UI check passed");
} finally {
  clearTimeout(watchdog);
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

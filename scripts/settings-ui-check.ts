/**
 * Measures the Settings dialog in a real browser at two window heights.
 *
 * The bug this exists for: the dialog had no height cap, so once the Skills
 * panel went in it grew past the top and the bottom of the window at once,
 * with nothing to scroll and no way to reach the controls. A static-markup
 * test cannot see that, because nothing there has a height.
 *
 * So this asserts the three things that were wrong. The dialog stays inside
 * the viewport. Its scrolling region is the pane, not the page. And every
 * category is reachable, since a category the user cannot open is the same
 * failure by a different route.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const port = 41743;
const debuggingPort = 41744;
const pageUrl = `http://127.0.0.1:${port}/settings-test.html`;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const screenshotPath = join(projectRoot, "artifacts/settings-ui-check.png");
const groupsScreenshotPath = join(
  projectRoot,
  "artifacts/settings-ui-groups.png",
);
const artifactsDirectory = join(projectRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(
  join(artifactsDirectory, ".settings-check-profile-"),
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
      if (attempt === 99) throw new Error("Settings test server did not start");
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await evaluate("Boolean(document.querySelector('.settings-nav'))"))
      break;
    if (attempt === 199)
      throw new Error(
        `Settings never rendered; body: ${await evaluate<string>(
          "document.body.innerText.slice(0, 200)",
        )}; renderer errors: ${rendererErrors.slice(0, 3).join(" | ") || "none"}`,
      );
    await Bun.sleep(50);
  }

  const measure = `(() => {
    const modal = document.querySelector('.modal');
    const pane = document.querySelector('.settings-pane');
    const rect = modal.getBoundingClientRect();
    return {
      viewport: window.innerHeight,
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      height: Math.round(rect.height),
      paneScrollable: pane.scrollHeight > pane.clientHeight + 1,
      paneOverflow: getComputedStyle(pane).overflowY,
      modalScrolls: modal.scrollHeight > modal.clientHeight + 1,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
    };
  })()`;

  type Measurement = {
    viewport: number;
    top: number;
    bottom: number;
    height: number;
    paneScrollable: boolean;
    paneOverflow: string;
    modalScrolls: boolean;
    pageScrolls: boolean;
  };

  const assertFits = (label: string, seen: Measurement) => {
    if (seen.top < 0 || seen.bottom > seen.viewport)
      throw new Error(
        `Settings runs off the screen at ${label}: top ${seen.top}, bottom ${seen.bottom}, viewport ${seen.viewport}`,
      );
    if (seen.pageScrolls)
      throw new Error(`The page itself scrolls at ${label}, not the pane`);
  };

  // The Skills category is the tall one, and the reason the dialog outgrew the
  // window in the first place.
  await evaluate(`(() => {
    const skills = [...document.querySelectorAll('.settings-nav button')]
      .find((button) => button.textContent.trim() === 'Skills');
    skills.click();
  })()`);
  await Bun.sleep(150);

  const tall = await evaluate<Measurement>(measure);
  assertFits("820px", tall);

  // A short window, because that is where a dialog sized to its content fails.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1380,
    height: 560,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await Bun.sleep(150);
  const short = await evaluate<Measurement>(measure);
  assertFits("560px", short);
  if (short.height >= tall.height)
    throw new Error(
      `The dialog did not shrink with the window: ${tall.height}px at 820, ${short.height}px at 560`,
    );

  await send("Emulation.clearDeviceMetricsOverride");
  await Bun.sleep(150);

  // Which element scrolls is the whole point. If the dialog scrolls instead of
  // the pane, the title and the category list scroll away with the content and
  // the user loses the way back, which is how the original failure felt even
  // where the geometry happened to fit.
  const scrolling = await evaluate<Measurement>(measure);
  if (!scrolling.paneScrollable)
    throw new Error("The Skills pane does not scroll, so its content is stuck");
  if (scrolling.paneOverflow !== "auto" && scrolling.paneOverflow !== "scroll")
    throw new Error(
      `The pane is not the scrolling region: ${scrolling.paneOverflow}`,
    );
  if (scrolling.modalScrolls)
    throw new Error(
      "The dialog scrolls as a whole, so the categories and the title scroll away with the content",
    );

  // Every category opens, and opening one does not resize the dialog, which is
  // what makes the sidebar feel like one surface rather than five dialogs.
  const heights: Record<string, number> = {};
  for (const label of [
    "General",
    "Skills",
    "Sessions",
    "Notifications",
    "About",
  ]) {
    const opened = await evaluate<string>(`(() => {
      const button = [...document.querySelectorAll('.settings-nav button')]
        .find((one) => one.textContent.trim() === ${JSON.stringify(label)});
      if (!button) return 'missing';
      button.click();
      return 'ok';
    })()`);
    if (opened !== "ok") throw new Error(`Settings has no ${label} category`);
    await Bun.sleep(120);
    const seen = await evaluate<Measurement>(measure);
    assertFits(label, seen);
    const current = await evaluate<string>(
      "document.querySelector('.settings-nav button[aria-current=\"page\"]').textContent.trim()",
    );
    if (current !== label)
      throw new Error(`Clicking ${label} left ${current} marked as current`);
    heights[label] = seen.height;
  }
  const distinct = new Set(Object.values(heights));
  if (distinct.size !== 1)
    throw new Error(
      `The dialog changes height between categories: ${JSON.stringify(heights)}`,
    );

  if (rendererErrors.length)
    throw new Error(
      `Renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}`,
    );

  // The found list: grouped, collapsible, fuzzy-filtered, and openable. Driven
  // rather than asserted in markup, because collapsing and fetching only mean
  // anything once something has clicked them.
  await evaluate(`(() => {
    [...document.querySelectorAll('.settings-nav button')]
      .find((one) => one.textContent.trim() === 'Skills').click();
  })()`);
  await Bun.sleep(150);

  const readGroups = `(() => [...document.querySelectorAll('.skills-group')].map((group) => ({
    label: group.querySelector('strong').textContent.trim(),
    open: group.querySelector('.skills-group-head').getAttribute('aria-expanded') === 'true',
    rows: group.querySelectorAll('.skills-found-row').length,
  })))()`;
  type Group = { label: string; open: boolean; rows: number };

  const grouped = await evaluate<Group[]>(readGroups);
  const labels = grouped.map((group) => group.label);
  // Each plugin is its own group under its own name. One shared "Claude
  // plugin" heading over several different plugins is what this replaced.
  for (const expected of ["Claude", "Codex and Cursor", "pstack", "toolkit"])
    if (!labels.includes(expected))
      throw new Error(
        `Expected a group called ${expected}, saw ${JSON.stringify(labels)}`,
      );
  if (new Set(labels).size !== labels.length)
    throw new Error(`Two groups share a heading: ${JSON.stringify(labels)}`);
  const totalRows = grouped.reduce((sum, group) => sum + group.rows, 0);
  if (totalRows !== 18)
    throw new Error(`Expected 18 rows across the groups, saw ${totalRows}`);

  // The control is a switch, not a four-way picker: the other two states are
  // the skill author's to set, not the user's.
  const controls = await evaluate<{
    switches: number;
    selects: number;
  }>(`(() => ({
    switches: document.querySelectorAll('.skills-found-row .skills-switch input').length,
    selects: document.querySelectorAll('.skills-found-row select').length,
  }))()`);
  if (controls.selects !== 0)
    throw new Error(`A found row still has a dropdown: ${controls.selects}`);
  if (controls.switches !== totalRows)
    throw new Error(
      `Expected one switch per visible row, saw ${controls.switches} for ${totalRows}`,
    );

  // Collapsing hides a group's rows and keeps its header.
  await evaluate(
    "document.querySelector('.skills-group .skills-group-head').click()",
  );
  await Bun.sleep(120);
  const collapsed = await evaluate<Group[]>(readGroups);
  if (collapsed[0]?.open !== false || collapsed[0]?.rows !== 0)
    throw new Error(
      `Collapsing the first group did not hide its rows: ${JSON.stringify(collapsed[0])}`,
    );
  if (collapsed.length !== grouped.length)
    throw new Error("Collapsing a group removed its header");

  // A fuzzy query matches on subsequence, the way the repository picker does,
  // and reopens whatever it matched so the result is not hidden by a collapse.
  await evaluate(`(() => {
    const input = document.querySelector('.skills-filter');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'clskl2');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await Bun.sleep(150);
  const filtered = await evaluate<Group[]>(readGroups);
  const filteredRows = filtered.reduce((sum, group) => sum + group.rows, 0);
  if (filteredRows === 0)
    throw new Error(
      "The fuzzy filter matched nothing; 'clskl2' should reach claude-skill-2",
    );
  if (filteredRows >= totalRows)
    throw new Error(
      `The filter narrowed nothing: ${filteredRows} of ${totalRows}`,
    );
  if (filtered.some((group) => !group.open))
    throw new Error("A filtered group stayed collapsed, hiding its match");

  await evaluate(`(() => {
    const input = document.querySelector('.skills-filter');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await Bun.sleep(150);

  // Clicking a row opens its text.
  await evaluate(
    "document.querySelector('.skills-found-row .skills-row-head').click()",
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate("Boolean(document.querySelector('.skills-detail pre'))"))
      break;
    if (attempt === 59)
      throw new Error("Opening a skill never showed its text");
    await Bun.sleep(50);
  }
  const viewer = await evaluate<{ text: string; stillFits: boolean }>(`(() => {
    const rect = document.querySelector('.modal').getBoundingClientRect();
    return {
      text: document.querySelector('.skills-detail pre').textContent.slice(0, 40),
      stillFits: rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  })()`);
  if (!viewer.text.includes("name: example"))
    throw new Error(`The viewer showed something unexpected: ${viewer.text}`);
  if (!viewer.stillFits)
    throw new Error("Opening a skill pushed the dialog off the screen");

  // Skills last, scrolled to the found list, because that is the part of the
  // image worth looking at and it sits below the fold.
  await evaluate(`(() => {
    [...document.querySelectorAll('.settings-nav button')]
      .find((one) => one.textContent.trim() === 'Skills').click();
  })()`);
  await Bun.sleep(150);
  await evaluate(`(() => {
    const pane = document.querySelector('.settings-pane');
    const heading = [...pane.querySelectorAll('h3')]
      .find((one) => one.textContent.trim() === 'Found on this machine');
    pane.scrollTop = heading.offsetTop - pane.offsetTop - 8;
  })()`);
  await Bun.sleep(150);
  const screenshot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(
    `Settings fits the window: ${tall.height}px inside ${tall.viewport}px, ${short.height}px inside ${short.viewport}px`,
  );
  console.log(
    "The pane scrolls and the dialog does not, so the categories and the title stay put",
  );
  console.log(
    `All five categories open at a steady ${[...distinct][0]}px: ${Object.keys(heights).join(", ")}`,
  );
  console.log(
    `Found skills: ${grouped.length} groups (${labels.join(", ")}), ${totalRows} rows with one switch each, collapse works, fuzzy filter narrows to ${filteredRows}, viewer opens`,
  );
  // A second image with every group shut, which is where the headings are
  // all visible at once and the per-plugin naming can be read.
  await evaluate(`(() => {
    for (const head of document.querySelectorAll('.skills-group-head'))
      if (head.getAttribute('aria-expanded') === 'true') head.click();
  })()`);
  await Bun.sleep(150);
  const groupsShot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(groupsScreenshotPath, Buffer.from(groupsShot.data, "base64"));
  console.log(`Screenshots: ${screenshotPath}, ${groupsScreenshotPath}`);
  socket.close();
} finally {
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

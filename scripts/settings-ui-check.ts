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
const aboutScreenshotPath = join(
  projectRoot,
  "artifacts/settings-ui-about.png",
);
const cornerScreenshotPath = join(
  projectRoot,
  "artifacts/settings-ui-update-dot.png",
);
const agentsScreenshotPath = join(
  projectRoot,
  "artifacts/settings-ui-agents.png",
);
const remoteScreenshotPath = join(
  projectRoot,
  "artifacts/settings-ui-remote.png",
);
const generalScreenshotPath = join(
  projectRoot,
  "artifacts/settings-ui-general.png",
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
    "Agents",
    "Skills",
    "Sessions",
    "Notifications",
    "Remote",
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
  for (const expected of [
    "Claude",
    "Codex and Cursor",
    "Cursor",
    "pstack",
    "toolkit",
  ])
    if (!labels.includes(expected))
      throw new Error(
        `Expected a group called ${expected}, saw ${JSON.stringify(labels)}`,
      );
  if (new Set(labels).size !== labels.length)
    throw new Error(`Two groups share a heading: ${JSON.stringify(labels)}`);
  const totalRows = grouped.reduce((sum, group) => sum + group.rows, 0);
  if (totalRows !== 20)
    throw new Error(`Expected 20 rows across the groups, saw ${totalRows}`);

  // A switch that cannot reach any provider is disabled rather than lying. No
  // provider offers a way to turn off a skill only Cursor loads.
  const unreachable = await evaluate<{
    disabled: number;
    reason: string;
  }>(`(() => {
    const rows = [...document.querySelectorAll('.skills-found-row')]
      .filter((row) => row.querySelector('.switch').disabled);
    return {
      disabled: rows.length,
      reason: rows[0]?.querySelector('.skills-switch').title ?? '',
    };
  })()`);
  if (unreachable.disabled !== 2)
    throw new Error(
      `Expected the two Cursor-only rows to have a disabled switch, saw ${unreachable.disabled}`,
    );
  if (!unreachable.reason.includes("Cursor has no switch"))
    throw new Error(
      `A disabled switch does not say why: ${unreachable.reason || "no title"}`,
    );

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

  // That the switch is styled, not merely classed. A native checkbox is about
  // 13px square, so measuring the track is what tells the two apart, and the
  // knob has to actually move when the state changes.
  const shape = await evaluate<{
    width: number;
    height: number;
    appearance: string;
    onKnob: string;
    offKnob: string;
    onTrack: string;
    offTrack: string;
  }>(`(() => {
    const rows = [...document.querySelectorAll('.skills-found-row')];
    const on = rows.find((row) => row.querySelector('.switch').checked);
    const off = rows.find((row) => !row.querySelector('.switch').checked);
    const onSwitch = on.querySelector('.switch');
    const offSwitch = off.querySelector('.switch');
    const rect = onSwitch.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      appearance: getComputedStyle(onSwitch).appearance,
      onKnob: getComputedStyle(onSwitch, '::after').transform,
      offKnob: getComputedStyle(offSwitch, '::after').transform,
      onTrack: getComputedStyle(onSwitch).backgroundColor,
      offTrack: getComputedStyle(offSwitch).backgroundColor,
    };
  })()`);
  if (shape.appearance !== "none")
    throw new Error(
      `The switch is still drawing as a native control: appearance ${shape.appearance}`,
    );
  if (shape.width !== 28 || shape.height !== 16)
    throw new Error(
      `The switch is not the size the style sets: ${shape.width}x${shape.height}`,
    );
  if (shape.onKnob === shape.offKnob)
    throw new Error(
      `The knob does not move between states: ${shape.onKnob} both ways`,
    );
  if (shape.onTrack === shape.offTrack)
    throw new Error(
      `The track colour is the same on and off: ${shape.onTrack}`,
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
    `All ${Object.keys(heights).length} categories open at a steady ${[...distinct][0]}px: ${Object.keys(heights).join(", ")}`,
  );
  console.log(
    `Found skills: ${grouped.length} groups (${labels.join(", ")}), ${totalRows} rows each with a ${shape.width}x${shape.height} switch that moves, collapse works, fuzzy filter narrows to ${filteredRows}, viewer opens`,
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
  // Agents: each provider with its accounts, the state the provider reported,
  // the action that fits it, and install commands for one that is missing.
  await evaluate(`(() => {
    [...document.querySelectorAll('.settings-nav button')]
      .find((one) => one.textContent.trim() === 'Agents').click();
  })()`);
  // The panel asks the providers once it opens; wait for its answer.
  for (let attempt = 0; ; attempt += 1) {
    const ready = await evaluate<boolean>(
      "document.querySelectorAll('.accounts-install-row').length > 0",
    );
    if (ready) break;
    if (attempt > 60) throw new Error("Agents: account status never arrived");
    await Bun.sleep(50);
  }
  const agents = await evaluate<{
    rows: Array<{
      account: string;
      line: string;
      actions: string[];
    }>;
    install: string[];
    overflow: boolean;
  }>(`(() => {
    const pane = document.querySelector('.settings-pane').getBoundingClientRect();
    const rows = [...document.querySelectorAll('.accounts-list li')];
    return {
      rows: rows.map((row) => ({
        account: row.dataset.account,
        line: row.querySelector('.accounts-who small')?.textContent ?? '',
        actions: [...row.querySelectorAll('.accounts-actions button')].map((b) => b.textContent.trim()),

      })),
      install: [...document.querySelectorAll('.accounts-install-row code')].map((c) => c.textContent),
      overflow: rows.some((row) => row.getBoundingClientRect().right > pane.right + 1),
    };
  })()`);
  const byAccount = (account: string, index = 0) =>
    agents.rows.filter((row) => row.account === account)[index];
  const signedIn = byAccount("default");
  const signedOut = byAccount("personal-1a2b");
  const apiKey = byAccount("work-api-9c1d");
  const missing = byAccount("default", 1);
  if (
    apiKey?.line !== "No key set" ||
    !apiKey.actions.includes("Set key") ||
    apiKey.actions.includes("Sign in")
  )
    throw new Error(
      `Agents: the API-key row is wrong: ${JSON.stringify(apiKey)}`,
    );
  if (
    !signedIn?.line.includes("someone@example.com") ||
    !signedIn.actions.includes("Sign out") ||
    signedIn.actions.includes("Remove")
  )
    throw new Error(
      `Agents: the signed-in default row is wrong: ${JSON.stringify(signedIn)}`,
    );
  if (
    signedOut?.line !== "Signed out" ||
    !signedOut.actions.includes("Sign in") ||
    !signedOut.actions.includes("Remove")
  )
    throw new Error(
      `Agents: the signed-out profile row is wrong: ${JSON.stringify(signedOut)}`,
    );
  if (missing?.line !== "Not installed" || missing.actions.length !== 0)
    throw new Error(
      `Agents: the missing provider's row is wrong: ${JSON.stringify(missing)}`,
    );
  if (!agents.install.includes("brew install --cask codex"))
    throw new Error(
      `Agents: no install command for Codex: ${JSON.stringify(agents.install)}`,
    );
  if (agents.overflow)
    throw new Error("Agents: an account row runs past the pane");
  const agentsShot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(agentsScreenshotPath, Buffer.from(agentsShot.data, "base64"));
  // Adding an account is one form and one click: a name, how it signs in,
  // and Add and sign in, which adds it and opens the sign-in. Driven with
  // real mouse events, the way the dialog is used.
  const clickAt = async (expression: string) => {
    const point = await evaluate<{ x: number; y: number } | null>(`(() => {
      const element = ${expression};
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!point) throw new Error(`Agents: nothing to click for ${expression}`);
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
    await Bun.sleep(150);
  };
  await clickAt(
    "[...document.querySelectorAll('.accounts-add')].find((button) => button.textContent.includes('Claude'))",
  );
  await evaluate(`(() => {
    const input = document.querySelector('.accounts-add-form input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Work SSO');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await clickAt(
    "[...document.querySelectorAll('.accounts-add-form .accounts-methods button')].find((button) => button.textContent.trim() === 'SSO')",
  );
  const addShot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(
    agentsScreenshotPath.replace(".png", "-add.png"),
    Buffer.from(addShot.data, "base64"),
  );
  await clickAt(
    "[...document.querySelectorAll('.accounts-add-form button')].find((button) => button.textContent.trim() === 'Add and sign in')",
  );
  await Bun.sleep(300);
  const requests = await evaluate<string>(
    "JSON.stringify(window.requests ?? [])",
  );
  if (
    !requests.includes(
      '"accountAdd":{"provider":"claude","name":"Work SSO","kind":"login","login":"sso"}',
    ) ||
    !requests.includes(
      '"accountSignIn":{"provider":"claude","account":"added-0001"}',
    )
  )
    throw new Error(`Agents: Add and sign in sent ${requests}`);
  // Signing in happens inside Settings, under the account's row: the
  // terminal, then the account signed in, then the terminal gone.
  const settingsOpen = () =>
    evaluate<boolean>("Boolean(document.querySelector('.settings-nav'))");
  if (!(await settingsOpen()))
    throw new Error("Agents: signing in closed Settings");
  await clickAt(
    "[...document.querySelectorAll('li[data-account=\"personal-1a2b\"] .accounts-actions button')].find((button) => button.textContent.trim() === 'Sign in')",
  );
  const panel = await evaluate<{
    after: string;
    terminal: boolean;
  } | null>(`(() => {
    const panel = document.querySelector('.accounts-signin-panel');
    if (!panel) return null;
    return {
      after: panel.previousElementSibling?.dataset.account ?? '',
      terminal: Boolean(panel.querySelector('.accounts-signin-terminal > *')),
    };
  })()`);
  if (panel?.after !== "personal-1a2b" || !panel.terminal)
    throw new Error(
      `Agents: no sign-in under Personal: ${JSON.stringify(panel)}`,
    );
  const signingShot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(
    agentsScreenshotPath.replace(".png", "-signing.png"),
    Buffer.from(signingShot.data, "base64"),
  );
  let done = "";
  for (let attempt = 0; attempt < 60 && !done; attempt += 1) {
    await Bun.sleep(100);
    done = await evaluate<string>(
      "document.querySelector('.accounts-signin-done')?.textContent ?? ''",
    );
  }
  if (!done.startsWith("Signed in · me@example.com"))
    throw new Error(`Agents: the sign-in never showed as done: ${done}`);
  const row = await evaluate<string>(
    "document.querySelector('li[data-account=\"personal-1a2b\"] .accounts-who small')?.textContent ?? ''",
  );
  if (!row.startsWith("Signed in · me@example.com"))
    throw new Error(`Agents: Personal's row still says ${row}`);
  const doneShot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(
    agentsScreenshotPath.replace(".png", "-signed-in.png"),
    Buffer.from(doneShot.data, "base64"),
  );
  for (
    let attempt = 0;
    attempt < 60 &&
    (await evaluate<boolean>(
      "Boolean(document.querySelector('.accounts-signin-panel'))",
    ));
    attempt += 1
  )
    await Bun.sleep(100);
  if (
    await evaluate<boolean>(
      "Boolean(document.querySelector('.accounts-signin-panel'))",
    )
  )
    throw new Error("Agents: the finished sign-in's terminal never closed");
  if (!(await settingsOpen()))
    throw new Error("Agents: Settings closed during the sign-in");
  console.log(
    `Agents: ${agents.rows.length} accounts (signed in with email, signed out with a one-click Sign in, Add and sign in with SSO sending both requests, a sign-in running under its row and turning it signed in, an API-key account with Set key, Codex not installed with ${agents.install.length} install commands), none past the pane`,
  );
  // Remote: off, then on and waiting; a pairing code as a QR code; a phone
  // finishing pairing hides the code and lists the phone; Remove (two
  // clicks, in place) forgets it.
  await evaluate(`(() => {
    [...document.querySelectorAll('.settings-nav button')]
      .find((one) => one.textContent.trim() === 'Remote').click();
  })()`);
  await Bun.sleep(150);
  const remoteSwitch =
    "document.querySelector('.remote-panel .settings-row input')";
  if (await evaluate<boolean>(`${remoteSwitch}.checked`))
    throw new Error("Remote: phone access starts on");
  await clickAt(remoteSwitch);
  await Bun.sleep(300);
  const waiting = await evaluate<string>(
    "document.querySelector('.remote-status')?.dataset.status ?? ''",
  );
  if (waiting !== "waiting_for_phone")
    throw new Error(`Remote: turned on, the status is ${waiting}`);
  await clickAt(
    "[...document.querySelectorAll('.remote-panel button')].find((one) => one.textContent.trim() === 'Show pairing code')",
  );
  await Bun.sleep(200);
  const qr = await evaluate<{
    modules: number;
    text: string;
    width: number;
  }>(`(() => {
    const svg = document.querySelector('.remote-qr');
    return {
      modules: svg?.querySelector('path')?.getAttribute('d')?.split('M').length ?? 0,
      text: document.querySelector('.remote-pairing p')?.textContent ?? '',
      width: svg?.getBoundingClientRect().width ?? 0,
    };
  })()`);
  if (qr.modules < 200 || qr.width < 190 || !/expires in \d:\d\d/.test(qr.text))
    throw new Error(`Remote: the pairing code is wrong: ${JSON.stringify(qr)}`);
  const remoteShot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(remoteScreenshotPath, Buffer.from(remoteShot.data, "base64"));
  await evaluate("window.remotePair()");
  for (
    let attempt = 0;
    attempt < 40 &&
    (await evaluate<boolean>("Boolean(document.querySelector('.remote-qr'))"));
    attempt += 1
  )
    await Bun.sleep(100);
  const paired = await evaluate<{
    qr: boolean;
    phones: string[];
    status: string;
  }>(`(() => ({
    qr: Boolean(document.querySelector('.remote-qr')),
    phones: [...document.querySelectorAll('.remote-phones li strong')].map((one) => one.textContent),
    status: document.querySelector('.remote-status')?.dataset.status ?? '',
  }))()`);
  if (
    paired.qr ||
    paired.phones.join() !== "Pixel 9" ||
    paired.status !== "online"
  )
    throw new Error(`Remote: pairing did not show: ${JSON.stringify(paired)}`);
  const pairedShot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(
    remoteScreenshotPath.replace(".png", "-paired.png"),
    Buffer.from(pairedShot.data, "base64"),
  );
  const removeButton =
    "document.querySelector('.remote-phones li .accounts-actions button')";
  await clickAt(removeButton);
  await Bun.sleep(400);
  await clickAt(removeButton);
  await Bun.sleep(300);
  const left = await evaluate<number>(
    "document.querySelectorAll('.remote-phones li').length",
  );
  if (left !== 0) throw new Error("Remote: Remove did not forget the phone");
  console.log(
    "Remote: off by default; on, it waits for a phone; the pairing code is a QR code with a countdown; a paired phone hides the code and is listed; Remove forgets it",
  );
  // And General, where a switch sits beside a two-line description and the
  // alignment either reads or does not.
  await evaluate(`(() => {
    [...document.querySelectorAll('.settings-nav button')]
      .find((one) => one.textContent.trim() === 'General').click();
  })()`);
  await Bun.sleep(150);
  const generalShot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(
    generalScreenshotPath,
    Buffer.from(generalShot.data, "base64"),
  );
  // About, where an update is answered. The fake host offers 0.8.3, so the
  // row, the dot on the About tab and the dot on the Settings button must all
  // be there; the banner under the top bar must not, since this dialog would
  // cover it.
  await evaluate(`(() => {
    [...document.querySelectorAll('.settings-nav button')]
      .find((one) => one.textContent.trim() === 'About').click();
  })()`);
  await Bun.sleep(150);
  const about = await evaluate<{
    status: string;
    button: string;
    tabDot: boolean;
    cornerDot: boolean;
    banner: boolean;
  }>(`(() => ({
    status: document.querySelector('.settings-update-status')?.textContent ?? '',
    button: document.querySelector('.settings-update button')?.textContent ?? '',
    tabDot: Boolean([...document.querySelectorAll('.settings-nav button')]
      .find((one) => one.textContent.trim() === 'About')?.querySelector('.update-dot')),
    cornerDot: Boolean(document.querySelector('.settings-corner-button .update-dot')),
    banner: Boolean(document.querySelector('.update-banner')),
  }))()`);
  if (!about.status.includes("Daedalus 0.8.3 is available"))
    throw new Error(`About does not show the offer: ${about.status}`);
  if (about.button !== "Update and restart")
    throw new Error(`About offers the wrong button: ${about.button}`);
  if (!about.tabDot || !about.cornerDot)
    throw new Error(
      `Update dot missing: About tab ${about.tabDot}, Settings button ${about.cornerDot}`,
    );
  if (about.banner)
    throw new Error("The update banner shows behind the Settings dialog");
  const aboutShot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  await Bun.write(aboutScreenshotPath, Buffer.from(aboutShot.data, "base64"));
  console.log(
    "About answers the update itself: the offer, Update and restart, and a dot on the About tab and the Settings button",
  );
  // Closed, the offer goes back to the banner, and the dot stays on the
  // Settings button in the bottom corner.
  await evaluate(`(() => {
    [...document.querySelectorAll('button')]
      .find((one) => one.textContent.trim() === 'Close')?.click();
  })()`);
  await Bun.sleep(150);
  const closed = await evaluate<{
    banner: string;
    corner: { x: number; y: number; width: number; height: number } | null;
  }>(`(() => {
    const corner = document.querySelector('.settings-corner-button');
    const box = corner?.getBoundingClientRect();
    return {
      banner: document.querySelector('.update-banner')?.textContent ?? '',
      corner: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
    };
  })()`);
  if (!closed.banner.includes("Daedalus 0.8.3 is available"))
    throw new Error(`The banner did not return: ${closed.banner}`);
  if (!closed.corner) throw new Error("No Settings button to show the dot on");
  const cornerShot = await send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    clip: {
      x: Math.max(0, closed.corner.x - 8),
      y: Math.max(0, closed.corner.y - 8),
      width: 220,
      height: closed.corner.height + 16,
      scale: 2,
    },
  });
  await Bun.write(cornerScreenshotPath, Buffer.from(cornerShot.data, "base64"));
  console.log(
    "Closed, the offer returns to the banner and the dot stays on Settings",
  );
  console.log(
    `Screenshots: ${screenshotPath}, ${groupsScreenshotPath}, ${agentsScreenshotPath}, ${remoteScreenshotPath}, ${generalScreenshotPath}, ${aboutScreenshotPath}, ${cornerScreenshotPath}`,
  );
  socket.close();
} finally {
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

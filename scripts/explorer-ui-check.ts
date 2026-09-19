/**
 * Drives the workspace explorer in a real browser: folders that stay open, and
 * the two borders that now drag.
 *
 * None of this can be asserted against markup. "The folder is still open" is a
 * statement about a second mount reading what the first one wrote, and "the
 * border moved" is geometry — the same reason the repository tree has its own
 * browser check. So this one loads the page, clicks, drags, reloads, and
 * measures what came back.
 *
 * Gated like the other browser checks: `bun run test:explorer-ui`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const freePort = () => {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  const chosen = probe.port;
  probe.stop(true);
  return chosen;
};
const port = freePort();
const debuggingPort = freePort();
const pageUrl = `http://127.0.0.1:${port}/explorer-test.html`;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactsDirectory = join(projectRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(
  join(artifactsDirectory, ".explorer-check-profile-"),
);

// Mirrors the renderer's own floors. A drag that pushed past either of these
// would be reported here rather than silently accepted.
const EXPLORER_TREE_MIN_HEIGHT = 140;
const EXPLORER_VIEWER_MIN_WIDTH = 300;

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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(pageUrl)).ok) break;
    } catch {
      if (attempt === 199)
        throw new Error("Explorer test server did not start");
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
      "--window-size=1300,900",
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
      websocketUrl = pages.find((page) =>
        page.url.startsWith(`http://127.0.0.1:${port}/`),
      )?.webSocketDebuggerUrl;
      if (websocketUrl) break;
    } catch {
      // Chrome is still starting.
    }
    await Bun.sleep(50);
  }
  if (!websocketUrl) throw new Error("Chrome DevTools endpoint did not start");

  const socket = new WebSocket(websocketUrl);
  await new Promise<void>((settle, fail) => {
    socket.addEventListener("open", () => settle(), { once: true });
    socket.addEventListener(
      "error",
      () => fail(new Error("CDP socket failed")),
      { once: true },
    );
  });
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
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
  const send = (method: string, params: Record<string, unknown> = {}) => {
    sequence += 1;
    const id = sequence;
    return new Promise<Record<string, never>>((settle, fail) => {
      pending.set(id, {
        resolve: settle as (value: unknown) => void,
        reject: fail,
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = (await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as unknown as { result: { value: T } };
    return result.result.value;
  };

  const waitFor = async (expression: string, what: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return;
      await Bun.sleep(50);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  /** Every tree row's path, in the order the explorer draws them. */
  const visiblePaths = () =>
    evaluate<string[]>(
      `[...document.querySelectorAll('.workspace-tree-entry > button')].map((button) => button.getAttribute('title'))`,
    );

  const clickPath = async (path: string) => {
    await evaluate(
      `document.querySelector('.workspace-tree-entry > button[title="${path}"]').click()`,
    );
    await Bun.sleep(120);
  };

  const drag = async (
    selector: string,
    deltaX: number,
    deltaY: number,
  ): Promise<void> => {
    const at = await evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('${selector}').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
      x: at.x,
      y: at.y,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      x: at.x + deltaX,
      y: at.y + deltaY,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      x: at.x + deltaX,
      y: at.y + deltaY,
    });
    await Bun.sleep(120);
  };

  const geometry = () =>
    evaluate<{
      explorerWidth: number;
      viewerWidth: number;
      treeHeight: number;
      secondaryHeight: number;
      secondaryBottom: number;
      explorerBottom: number;
      explorerRight: number;
      widestRowRight: number;
    }>(`(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const explorer = box('.workspace-explorer');
      const secondary = box('.workspace-explorer-secondary');
      const rows = [...document.querySelectorAll('.workspace-resource-row, .workspace-worktree-row:not(.empty)')];
      return {
        explorerWidth: explorer.width,
        viewerWidth: box('.workspace-viewer').width,
        treeHeight: box('.workspace-tree').height,
        secondaryHeight: secondary.height,
        secondaryBottom: secondary.bottom,
        explorerBottom: explorer.bottom,
        explorerRight: explorer.right,
        widestRowRight: rows.reduce((widest, row) => Math.max(widest, row.getBoundingClientRect().right), 0),
      };
    })()`);

  const reload = async () => {
    await send("Page.enable");
    await send("Page.reload", { ignoreCache: false });
    await waitFor(
      "document.querySelector('.workspace-explorer-secondary')",
      "the explorer after a reload",
    );
    // The restore fires directory listings of its own after the content lands.
    await Bun.sleep(400);
  };

  await waitFor(
    "document.querySelector('.explorer-section-resize-handle')",
    "the explorer to mount",
  );
  await waitFor(
    `document.querySelector('.workspace-tree-entry > button[title="repos"]')`,
    "the file tree",
  );

  // 1. Opening folders reveals what is inside them.
  await clickPath("repos");
  await clickPath("repos/daedalus");
  await clickPath("repos/daedalus/packages");
  const opened = await visiblePaths();
  for (const path of [
    "repos/daedalus",
    "repos/daedalus/packages",
    "repos/daedalus/packages/core.ts",
  ])
    if (!opened.includes(path))
      failures.push(
        `Opening folders did not reveal ${path}; the tree shows ${JSON.stringify(opened)}`,
      );

  // 2. And they are still open after a reload — the whole point of the task.
  await reload();
  const remembered = await visiblePaths();
  for (const path of [
    "repos/daedalus",
    "repos/daedalus/packages",
    "repos/daedalus/packages/core.ts",
  ])
    if (!remembered.includes(path))
      failures.push(
        `${path} did not survive a reload; the tree shows ${JSON.stringify(remembered)}`,
      );

  // 3. Closing a folder closes it for good, descendants included. Reopening it
  //    must not spring the whole subtree back.
  await clickPath("repos/daedalus");
  await reload();
  const afterClose = await visiblePaths();
  if (afterClose.includes("repos/daedalus/packages"))
    failures.push(
      "A closed folder came back open after a reload; closing is not remembered",
    );
  if (!afterClose.includes("repos/daedalus"))
    failures.push(
      "Closing a child folder also forgot its parent; only the clicked folder should close",
    );
  await clickPath("repos/daedalus");
  const reopened = await visiblePaths();
  if (reopened.includes("repos/daedalus/packages/core.ts"))
    failures.push(
      "Reopening a folder restored a subfolder the user had closed inside it",
    );

  // 4. The repositories section drags taller, and stops before the file tree
  //    loses its floor.
  const before = await geometry();
  await drag(".explorer-section-resize-handle", 0, -120);
  const taller = await geometry();
  if (taller.secondaryHeight - before.secondaryHeight < 100)
    failures.push(
      `Dragging the repositories border up 120px grew it by only ${(taller.secondaryHeight - before.secondaryHeight).toFixed(0)}px (${before.secondaryHeight.toFixed(0)} -> ${taller.secondaryHeight.toFixed(0)})`,
    );
  await drag(".explorer-section-resize-handle", 0, -2000);
  const pinned = await geometry();
  if (pinned.treeHeight < EXPLORER_TREE_MIN_HEIGHT - 1)
    failures.push(
      `Dragging the repositories border to the top crushed the file tree to ${pinned.treeHeight.toFixed(0)}px, under its ${EXPLORER_TREE_MIN_HEIGHT}px floor`,
    );
  if (pinned.secondaryBottom > pinned.explorerBottom + 0.5)
    failures.push(
      `The repositories section overflows the explorer by ${(pinned.secondaryBottom - pinned.explorerBottom).toFixed(0)}px`,
    );
  await drag(".explorer-section-resize-handle", 0, 2000);
  // Shrunk to its floor, the separator must say how far it could still travel.
  // A focusable separator reporting only `aria-valuenow` is read against the
  // implicit 0–100, which would describe an 84px section as "over maximum".
  const reported = await evaluate<{ now: number; max: number }>(`(() => {
    const handle = document.querySelector('.explorer-section-resize-handle');
    return {
      now: Number(handle.getAttribute('aria-valuenow')),
      max: Number(handle.getAttribute('aria-valuemax')),
    };
  })()`);
  if (!(reported.max > reported.now + 100))
    failures.push(
      `With the repositories section at its floor the separator reports max ${reported.max} against now ${reported.now}; the room the tree is holding is not being reported`,
    );
  const shortest = await geometry();
  if (shortest.secondaryHeight < 40)
    failures.push(
      `Dragging the repositories border to the bottom collapsed it to ${shortest.secondaryHeight.toFixed(0)}px instead of stopping at its minimum`,
    );
  await drag(".explorer-section-resize-handle", 0, -120);
  const restoredHeight = (await geometry()).secondaryHeight;
  await reload();
  const afterReloadHeight = (await geometry()).secondaryHeight;
  if (Math.abs(afterReloadHeight - restoredHeight) > 2)
    failures.push(
      `The repositories height did not survive a reload: ${restoredHeight.toFixed(0)}px -> ${afterReloadHeight.toFixed(0)}px`,
    );

  // 5. The explorer itself drags wider, and never at the viewer's expense.
  const beforeWidth = await geometry();
  await drag(".explorer-resize-handle", 140, 0);
  const wider = await geometry();
  if (wider.explorerWidth - beforeWidth.explorerWidth < 120)
    failures.push(
      `Dragging the explorer border right 140px widened it by only ${(wider.explorerWidth - beforeWidth.explorerWidth).toFixed(0)}px (${beforeWidth.explorerWidth.toFixed(0)} -> ${wider.explorerWidth.toFixed(0)})`,
    );
  if (wider.widestRowRight > wider.explorerRight + 0.5)
    failures.push(
      `A repository row spills ${(wider.widestRowRight - wider.explorerRight).toFixed(0)}px past the widened explorer`,
    );
  await drag(".explorer-resize-handle", 2000, 0);
  const widest = await geometry();
  if (widest.viewerWidth < EXPLORER_VIEWER_MIN_WIDTH - 1)
    failures.push(
      `Dragging the explorer to the right edge left the file viewer ${widest.viewerWidth.toFixed(0)}px wide, under its ${EXPLORER_VIEWER_MIN_WIDTH}px floor`,
    );
  await drag(".explorer-resize-handle", -2000, 0);
  const narrowest = await geometry();
  if (narrowest.explorerWidth < 120)
    failures.push(
      `Dragging the explorer to the left edge collapsed it to ${narrowest.explorerWidth.toFixed(0)}px instead of stopping at its minimum`,
    );
  await drag(".explorer-resize-handle", 140, 0);
  const settledWidth = (await geometry()).explorerWidth;
  await reload();
  const afterReloadWidth = (await geometry()).explorerWidth;
  if (Math.abs(afterReloadWidth - settledWidth) > 2)
    failures.push(
      `The explorer width did not survive a reload: ${settledWidth.toFixed(0)}px -> ${afterReloadWidth.toFixed(0)}px`,
    );

  await send("Page.captureScreenshot", {}).then(async (result) => {
    const data = (result as unknown as { data?: string }).data;
    if (data)
      await Bun.write(
        join(artifactsDirectory, "explorer-ui-check.png"),
        Buffer.from(data, "base64"),
      );
  });
} finally {
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(
  "Explorer check passed: open folders survive a reload, closing forgets the subtree, and both borders drag within their limits.",
);

/**
 * Drives the workspace explorer in a real browser: folders that stay open, two
 * borders that drag, a tree that notices the filesystem underneath it, and
 * rename, move and delete.
 *
 * None of this can be asserted against markup. "The folder is still open" is a
 * statement about a second mount reading what the first one wrote, "the border
 * moved" is geometry, and "the tree refreshed itself" is a real watcher
 * reaching a real React tree without anybody clicking. So this one loads the
 * page, clicks, drags, reloads, writes files on disk, and measures what came
 * back.
 *
 * Gated like the other browser checks: `bun run test:explorer-ui`.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createApplicationContext,
  WORKSPACE_FILES_CHANGED,
  type WorkspaceFilesChanged,
} from "@daedalus/core";

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
const bridgePort = freePort();

/**
 * A real `ApplicationContext`, a real workspace directory and a real watcher,
 * bridged to the fixture page over HTTP and a WebSocket.
 *
 * Stubbing the filesystem here would have made the whole live-refresh half of
 * this check worthless: the coalescing, the debounce and the reconciliation
 * would all have been proven against a fixture written to agree with them.
 * What is *not* real is Electrobun's RPC transport, which this replaces, and
 * the repositories list, which the page fabricates so the geometry assertions
 * have more rows than fit.
 */
const home = await mkdtemp(join(tmpdir(), "daedalus-explorer-check-"));
const context = await createApplicationContext({
  env: { DAEDALUS_HOME: home },
  reconcile: false,
});
const workspace = await context.workspaces.create({ name: "Explorer test" });
const workspacePath = workspace.path;

// Deep enough that restoring it proves parents come back before children.
await mkdir(join(workspacePath, "repos", "daedalus", "packages"), {
  recursive: true,
});
await mkdir(join(workspacePath, "worktrees", "alpha"), { recursive: true });
for (const [path, body] of [
  ["repos/daedalus/README.md", "# daedalus\n"],
  ["repos/daedalus/packages/core.ts", "export const core = true;\n"],
  ["repos/daedalus/packages/protocol.ts", "export const protocol = true;\n"],
  ["worktrees/alpha/notes.md", "# Notes\n"],
] as const)
  await writeFile(join(workspacePath, path), body);

const sockets = new Set<Bun.ServerWebSocket<unknown>>();
/**
 * Mutating routes, which the bridge announces afterwards the way the host's
 * `mutate` does. This is not decoration: `dataChanged` is what makes the
 * renderer refetch workspace content, and refetching content is what recreates
 * the generated files. Stubbing the subscription away — which this fixture
 * used to do — hid a delete that succeeded and was undone before the tree
 * redrew.
 */
const MUTATING_ROUTES = ["/write", "/create", "/rename", "/move", "/remove"];
/** Per-route counts, printed when the check fails, so a request storm names itself. */
const traffic = new Map<string, number>();
let watchEvents = 0;
context.events.subscribe((event) => {
  if (event.type !== WORKSPACE_FILES_CHANGED) return;
  const payload = event.payload as WorkspaceFilesChanged;
  watchEvents += 1;
  for (const socket of sockets) socket.send(JSON.stringify(payload));
});

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "content-type": "application/json",
};
const answer = async (operation: () => unknown, after?: () => void) => {
  try {
    const data = await operation();
    after?.();
    return new Response(JSON.stringify({ ok: true, data }), {
      headers: cors,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: (error as { code?: string }).code ?? "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
      { headers: cors },
    );
  }
};

const bridge = Bun.serve({
  port: bridgePort,
  hostname: "127.0.0.1",
  async fetch(request, server) {
    const { pathname } = new URL(request.url);
    if (pathname === "/events")
      return server.upgrade(request)
        ? undefined
        : new Response("expected a websocket", { status: 400 });
    if (request.method === "OPTIONS")
      return new Response(null, { headers: cors });
    traffic.set(pathname, (traffic.get(pathname) ?? 0) + 1);
    const announce = () => {
      if (!MUTATING_ROUTES.includes(pathname)) return;
      for (const socket of sockets)
        socket.send(JSON.stringify({ kind: "dataChanged" }));
    };
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      never
    > & { path?: string };
    const files = context.workspaceContent;
    const workspaceRef = workspace.id;
    switch (pathname) {
      case "/content":
        return answer(() => files.get(workspaceRef));
      case "/list":
        return answer(() => files.listDirectory(workspaceRef, body.path ?? ""));
      case "/read":
        return answer(() => files.readFile(workspaceRef, body.path ?? ""));
      case "/write":
        return answer(
          () => files.writeFile({ ...body, workspace: workspaceRef }),
          announce,
        );
      case "/create":
        return answer(
          () => files.createEntry({ ...body, workspace: workspaceRef }),
          announce,
        );
      case "/rename":
        return answer(
          () => files.renameEntry({ ...body, workspace: workspaceRef }),
          announce,
        );
      case "/move":
        return answer(
          () => files.moveEntry({ ...body, workspace: workspaceRef }),
          announce,
        );
      case "/remove":
        return answer(
          () => files.removeEntry({ ...body, workspace: workspaceRef }),
          announce,
        );
      case "/watch":
        return answer(async () => ({
          watching: await context.workspaceWatch.watchOnly(
            (
              (body as unknown as { workspaces?: string[] }).workspaces ?? []
            ).map(() => workspaceRef),
          ),
        }));
      default:
        return new Response("not found", { status: 404, headers: cors });
    }
  },
  websocket: {
    open: (socket) => void sockets.add(socket),
    close: (socket) => void sockets.delete(socket),
    message: () => undefined,
  },
});

const pageUrl = `http://127.0.0.1:${port}/explorer-test.html?api=${bridgePort}&workspace=${workspace.id}`;
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
let watchdog: ReturnType<typeof setTimeout> | undefined;
/** Names the step in progress, so a hang says where it stopped. */
let step = "startup";
const consoleErrors: string[] = [];
// Typed, because a `prompt` for a move destination and a `confirm` before a
// delete both land here, and only the confirms are what the delete step is
// counting.
const dialogs: Array<{ type: string; message: string }> = [];
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
  // Every command carries a deadline. A page blocked by a dialog, or wedged in
  // a render loop, answers nothing — and without this that is a silent hang
  // instead of a report naming the command that never came back.
  const send = (method: string, params: Record<string, unknown> = {}) => {
    sequence += 1;
    const id = sequence;
    return new Promise<Record<string, never>>((settle, fail) => {
      const deadline = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`${method} did not answer within 20s (step: ${step})`));
      }, 20_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(deadline);
          (settle as (value: unknown) => void)(value);
        },
        reject: (error) => {
          clearTimeout(deadline);
          fail(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  await send("Page.enable");
  /**
   * `window.confirm` blocks the page, and a blocked page answers no
   * `Runtime.evaluate` — so a dialog nobody dismisses hangs every assertion
   * after it rather than failing one. The handler is therefore registered
   * once, up front, and the answer is a variable the steps set.
   *
   * The first attempt registered a one-shot listener just before the click
   * that opens the dialog, and hung: the delete handler calls `confirm`
   * synchronously inside the click, so the `evaluate` driving the click was
   * already blocked by the time anything could have listened.
   */
  await send("Runtime.enable");
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown")
      consoleErrors.push(
        String(
          message.params?.exceptionDetails?.exception?.description ??
            message.params?.exceptionDetails?.text ??
            "unknown exception",
        ).split("\n")[0],
      );
    if (message.method === "Runtime.consoleAPICalled")
      consoleErrors.push(
        (message.params.args ?? [])
          .map((arg: { value?: unknown; description?: unknown }) =>
            String(arg.description ?? arg.value ?? ""),
          )
          .join(" "),
      );
  });

  let acceptDialogs = true;
  /** Supplied to a `prompt`; ignored by a `confirm`. */
  let dialogReply: string | undefined;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method !== "Page.javascriptDialogOpening") return;
    dialogs.push({
      type: String(message.params?.type ?? "unknown"),
      message: String(message.params?.message ?? ""),
    });
    void send("Page.handleJavaScriptDialog", {
      accept: acceptDialogs,
      ...(dialogReply === undefined ? {} : { promptText: dialogReply }),
    });
  });

  const at = (what: string) => {
    step = what;
  };
  // Nothing in here should take minutes. Without this a single wedged step
  // hangs the whole run with no output at all, which is how the dialog bug
  // above presented.
  watchdog = setTimeout(() => {
    console.error(`✗ Explorer check wedged during: ${step}`);
    console.error(`  dialogs seen: ${JSON.stringify(dialogs)}`);
    console.error(
      `  page console (last 8): ${JSON.stringify(consoleErrors.slice(-8))}`,
    );
    chrome?.kill();
    vite.kill();
    process.exit(1);
  }, 240_000);
  watchdog.unref?.();

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

  /**
   * Waits for something the *watcher* is supposed to cause, and answers
   * whether it happened rather than throwing.
   *
   * Separate from `waitFor` on purpose: a missing refresh is a finding to
   * report next to the others, not a crash that hides every assertion after
   * it. The budget covers the 150ms debounce, the classification round trip
   * and the re-list that follows.
   */
  const settles = async (expression: string) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return true;
      await Bun.sleep(50);
    }
    return false;
  };

  /**
   * Replaces whatever is in the focused control. Select-all then insert,
   * rather than key-by-key: the editor is CodeMirror and the rename field is
   * prefilled, so both need what is already there gone first.
   */
  const replaceText = async (text: string) => {
    // `commands: ["selectAll"]` rather than a bare Cmd+A: on macOS the
    // select-all is a native editing command, and dispatching the chord alone
    // left the field's existing text in place, so the insert appended to it.
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      commands: ["selectAll"],
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    });
    await send("Input.insertText", { text });
    await Bun.sleep(150);
  };

  const pressEnter = async () => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    await Bun.sleep(150);
  };

  /**
   * A real right-click on a tree row, through the input pipeline like the
   * drags are. A synthetic `MouseEvent` was tried first and never opened the
   * menu, and driving the real one is closer to what a user does anyway.
   */
  const rightClickPath = async (path: string) => {
    // Scrolled into view first: the file tree clips, and a row below the fold
    // still reports a box — one whose coordinates belong to whatever is
    // actually painted there. The click then lands on something else and the
    // menu never opens, which is how this first failed on JOURNAL.md while
    // working on BRIEF.md three rows above it.
    const at = await evaluate<{ x: number; y: number } | null>(`(() => {
      const row = document.querySelector('.workspace-tree-entry > button[title="${path}"]');
      if (!row) return null;
      row.scrollIntoView({ block: 'center' });
      const rect = row.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      // Only worth dispatching if that point actually belongs to this row.
      const hit = document.elementFromPoint(x, y);
      if (!hit || !row.contains(hit)) return null;
      return { x, y };
    })()`);
    await Bun.sleep(80);
    // A missing row is a finding in its own right. Reaching into a null
    // element instead threw, which lost every failure collected before it —
    // exactly what happened the first time the watcher was ablated.
    // Never dispatched blind. A right-click that misses the row is not merely
    // a lost click: nothing calls `preventDefault`, so Chrome opens its own
    // native context menu, and that blocks the renderer — every later
    // assertion then times out instead of failing.
    if (!at) {
      failures.push(`No reachable tree row to act on at ${path}`);
      return false;
    }
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        button: "right",
        buttons: type === "mousePressed" ? 2 : 0,
        clickCount: 1,
        x: at.x,
        y: at.y,
      });
    await Bun.sleep(150);
    return true;
  };

  /** The state a refresh is not allowed to cost the user. */
  const explorerState = () =>
    evaluate<{ expanded: string[]; selectedFile: string | null }>(`(() => ({
      expanded: [...document.querySelectorAll('.workspace-tree-entry > button[aria-expanded="true"]')].map((button) => button.getAttribute('title')),
      selectedFile: document.querySelector('.workspace-viewer-tab strong')?.textContent ?? null,
    }))()`);

  const pathExists = async (path: string) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Closes an open menu with a real Escape key.
   *
   * Dispatching a synthetic `PointerEvent` at the backdrop was tried first and
   * silently did nothing — React never received it, the same way it never
   * received a synthetic `contextmenu` — so the full-window backdrop stayed up
   * and swallowed the next right-click. Escape is a real key, and it is a path
   * worth exercising anyway.
   */
  const dismissMenu = async () => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (
        !(await evaluate<boolean>(
          `Boolean(document.querySelector('.workspace-tree-menu'))`,
        ))
      )
        return true;
      await Bun.sleep(50);
    }
    failures.push("Escape did not close the context menu");
    return false;
  };

  const openMenuOn = async (path: string) => {
    if (!(await rightClickPath(path))) return false;
    await waitFor(
      `document.querySelector('.workspace-tree-menu')`,
      `the context menu for ${path}`,
    );
    return true;
  };

  /** Every tree row's path, in the order the explorer draws them. */
  const visiblePaths = () =>
    evaluate<string[]>(
      `[...document.querySelectorAll('.workspace-tree-entry > button')].map((button) => button.getAttribute('title'))`,
    );

  const visible = (path: string) =>
    evaluate<boolean>(
      `Boolean(document.querySelector('.workspace-tree-entry > button[title="${path}"]'))`,
    );

  /**
   * Opens a folder only if it is not open already. Clicking unconditionally
   * toggles, and by this point in the run some folders are open from earlier
   * steps — which is how this first failed, by closing `repos` and then
   * waiting for something inside it.
   */
  const ensureOpen = async (path: string, child: string) => {
    if (await visible(child)) return;
    await clickPath(path);
  };

  /**
   * Clicks a tree row, once it is there, and waits for the tree to settle
   * rather than for a fixed 120ms.
   *
   * The flat sleep was a silent failure twice over: a row that had not arrived
   * yet made `querySelector(...).click()` throw inside the page, which
   * `evaluate` discards, so the click simply never happened and the *next*
   * assertion reported the consequence. Both halves are now waited for.
   */
  const clickPath = async (path: string) => {
    const selector = `.workspace-tree-entry > button[title="${path}"]`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        await evaluate<boolean>(
          `Boolean(document.querySelector('${selector}'))`,
        )
      )
        break;
      if (attempt === 99) {
        failures.push(`No tree row to click at ${path}`);
        return false;
      }
      await Bun.sleep(50);
    }
    await evaluate(
      `(() => { const row = document.querySelector('${selector}'); row.scrollIntoView({ block: 'center' }); row.click(); })()`,
    );
    let previous = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await Bun.sleep(50);
      const current = JSON.stringify(await visiblePaths());
      if (current === previous && attempt > 0) break;
      previous = current;
    }
    return true;
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
    await send("Page.reload", { ignoreCache: false });
    await waitFor(
      "document.querySelector('.workspace-explorer-secondary')",
      "the explorer after a reload",
    );
    // The restore fires a directory listing per remembered folder after the
    // content lands, so the tree arrives in pieces. This used to be a flat
    // 400ms, which was enough against an in-memory stub and intermittently
    // was not once the listings became real HTTP round trips — it failed as a
    // folder that "did not survive a reload" when it simply had not arrived
    // yet. Waiting for the shape to stop changing has no such tuning.
    let previous = "";
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await Bun.sleep(100);
      const current = JSON.stringify(await visiblePaths());
      if (current === previous && attempt > 1) return;
      previous = current;
    }
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

  at("the watcher reporting a created file");
  // 6. The tree notices the filesystem underneath it, with nobody clicking.
  //    Written through `node:fs` rather than through a service verb, so the
  //    only thing that can put the row on screen is the watcher.
  await ensureOpen("worktrees", "worktrees/alpha");
  await waitFor(
    `document.querySelector('.workspace-tree-entry > button[title="worktrees/alpha"]')`,
    "the worktrees folder to open",
  );
  await writeFile(join(workspacePath, "worktrees", "appeared.md"), "# New\n");
  const sawCreation = await settles(
    `[...document.querySelectorAll('.workspace-tree-entry > button')].some((button) => button.getAttribute('title') === 'worktrees/appeared.md')`,
  );
  if (!sawCreation)
    failures.push(
      "A file created on disk never appeared in the tree; the explorer is not watching",
    );

  at("the watcher reporting a deleted file");
  // 7. And a deletion, which is the half that cannot be faked by re-listing on
  //    a click, because nothing was clicked.
  await rm(join(workspacePath, "worktrees", "appeared.md"));
  const sawDeletion = await settles(
    `![...document.querySelectorAll('.workspace-tree-entry > button')].some((button) => button.getAttribute('title') === 'worktrees/appeared.md')`,
  );
  if (!sawDeletion)
    failures.push(
      "A file deleted on disk stayed in the tree; the explorer is showing something that is gone",
    );

  at("a refresh preserving expansion and selection");
  // 8. The refresh must cost the user nothing. Expansion, selection and the
  //    scroll position are all state a naive "re-fetch the tree" would lose.
  await clickPath("worktrees/alpha");
  await clickPath("worktrees/alpha/notes.md");
  await waitFor(
    `document.querySelector('.workspace-viewer .cm-content')`,
    "the file editor",
  );
  const before6 = await explorerState();
  await writeFile(join(workspacePath, "worktrees", "second.md"), "# Second\n");
  if (
    !(await settles(
      `[...document.querySelectorAll('.workspace-tree-entry > button')].some((button) => button.getAttribute('title') === 'worktrees/second.md')`,
    ))
  )
    failures.push("The second created file never reached the tree");
  const after6 = await explorerState();
  if (!after6.expanded.includes("worktrees/alpha"))
    failures.push(
      `A folder closed itself when an unrelated file was created; open folders are ${JSON.stringify(after6.expanded)}`,
    );
  if (after6.selectedFile !== before6.selectedFile)
    failures.push(
      `The open file changed from ${before6.selectedFile} to ${after6.selectedFile} when an unrelated file was created`,
    );

  at("an unsaved draft surviving a change on disk");
  // 9. An unsaved draft is the one thing that cannot be recovered, so a change
  //    on disk must never touch it — not even to the file being edited.
  await evaluate(
    `document.querySelector('.workspace-viewer .cm-content').focus()`,
  );
  await replaceText("work in progress that must survive");
  await writeFile(
    join(workspacePath, "worktrees", "alpha", "notes.md"),
    "# Rewritten on disk\n",
  );
  await Bun.sleep(900);
  const draft = await evaluate<string>(
    `document.querySelector('.workspace-viewer .cm-content').textContent`,
  );
  if (draft !== "work in progress that must survive")
    failures.push(
      `A file rewritten on disk overwrote an unsaved draft; the editor now holds ${JSON.stringify(draft)}`,
    );

  at("inline rename");
  // 10. Renaming happens in the row, and the tree follows the entry rather
  //     than collapsing back to wherever it was.
  at("inline rename: right-click");
  const renameMenu = await rightClickPath("worktrees/second.md");
  // Everything from here needs that row. Without it these steps would each
  // time out in turn and bury the finding that actually explains them.
  if (!renameMenu)
    failures.push(
      "Skipped rename and delete: the file they act on was never in the tree",
    );
  if (renameMenu) {
    await waitFor(
      `document.querySelector('.workspace-tree-menu')`,
      "the context menu",
    );
    at("inline rename: choosing Rename");
    await evaluate(
      `[...document.querySelectorAll('.workspace-tree-menu button')].find((button) => button.textContent === 'Rename').click()`,
    );
    await waitFor(
      `document.querySelector('.workspace-tree-rename input')`,
      "the inline rename field",
    );
    at("inline rename: typing");
    await replaceText("renamed.md");
    at("inline rename: submitting");
    await pressEnter();
    at("inline rename: waiting for the new name");
    if (
      !(await settles(
        `[...document.querySelectorAll('.workspace-tree-entry > button')].some((button) => button.getAttribute('title') === 'worktrees/renamed.md')`,
      ))
    )
      failures.push("Renaming a file did not produce the new name in the tree");
    if (
      await evaluate<boolean>(
        `[...document.querySelectorAll('.workspace-tree-entry > button')].some((button) => button.getAttribute('title') === 'worktrees/second.md')`,
      )
    )
      failures.push("The old name is still in the tree after a rename");
    if (!(await pathExists(join(workspacePath, "worktrees", "renamed.md"))))
      failures.push("The rename never reached the filesystem");

    // 10b. Renaming a folder that is open, and that holds the file being
    //      edited. The watcher alone cannot get this right: it reports two
    //      unrelated paths and nothing on disk says they are the same entry,
    //      so the folder would come back closed and the editor would be left
    //      pointing at a path that no longer exists. Only the caller knows,
    //      which is what `followMovedEntry` is for.
    //
    //      This exists because ablating that function left the check passing:
    //      every other rename assertion here is satisfied by the watcher
    //      re-listing the parent, so none of them touched it.
    at("renaming an open folder");
    if (await openMenuOn("worktrees/alpha")) {
      await evaluate(
        `[...document.querySelectorAll('.workspace-tree-menu button')].find((button) => button.textContent === 'Rename').click()`,
      );
      await waitFor(
        `document.querySelector('.workspace-tree-rename input')`,
        "the inline rename field for the folder",
      );
      await replaceText("opened");
      await pressEnter();
      if (
        !(await settles(
          `[...document.querySelectorAll('.workspace-tree-entry > button')].some((button) => button.getAttribute('title') === 'worktrees/opened')`,
        ))
      )
        failures.push("Renaming a folder did not produce the new name");
      if (
        !(await evaluate<boolean>(
          `[...document.querySelectorAll('.workspace-tree-entry > button')].some((button) => button.getAttribute('title') === 'worktrees/opened/notes.md')`,
        ))
      )
        failures.push(
          "A renamed folder came back closed; the tree did not follow it",
        );
      // The breadcrumb, not the tab: the tab shows only the file's name, which
      // a folder rename does not change, so it cannot tell a followed file
      // from one still pointing at a path that no longer exists.
      const breadcrumb = await evaluate<string>(
        `document.querySelector('.workspace-viewer-breadcrumb')?.textContent?.replace(/\\s*›\\s*/g, '/') ?? "GONE"`,
      );
      if (breadcrumb !== "worktrees/opened/notes.md")
        failures.push(
          `The editor did not follow the file into the renamed folder; it points at ${JSON.stringify(breadcrumb)}`,
        );
      // And the tree agrees about which row is open.
      if (
        !(await evaluate<boolean>(
          `document.querySelector('.workspace-tree-entry > button[title="worktrees/opened/notes.md"]')?.classList.contains('selected') ?? false`,
        ))
      )
        failures.push(
          "The renamed file's row is not the selected one; the tree and the editor disagree",
        );
      // The draft from step 9 is still unsaved. A rename must not cost it
      // either — it belongs to the user, not to the path it was opened from.
      const carried = await evaluate<string>(
        `document.querySelector('.workspace-viewer .cm-content')?.textContent ?? "GONE"`,
      );
      if (carried !== "work in progress that must survive")
        failures.push(
          `Renaming the folder lost the unsaved draft; the editor holds ${JSON.stringify(carried)}`,
        );
    }

    // 10c. Moving, through the same menu. Its destination arrives by prompt
    //      rather than by drag — drag-to-move is deliberately out of scope —
    //      so the dialog handler answers with the folder to move into.
    at("moving an entry");
    if (await openMenuOn("worktrees/renamed.md")) {
      dialogReply = "worktrees/opened";
      await evaluate(
        `[...document.querySelectorAll('.workspace-tree-menu button')].find((button) => button.textContent === 'Move to…').click()`,
      );
      const landed = await settles(
        `[...document.querySelectorAll('.workspace-tree-entry > button')].some((button) => button.getAttribute('title') === 'worktrees/opened/renamed.md')`,
      );
      dialogReply = undefined;
      if (!landed)
        failures.push(
          "Moving a file into another folder did not put it there in the tree",
        );
      if (
        !(await pathExists(
          join(workspacePath, "worktrees", "opened", "renamed.md"),
        ))
      )
        failures.push("The move never reached the filesystem");
      if (await pathExists(join(workspacePath, "worktrees", "renamed.md")))
        failures.push("The move left the file at its old path as well");
      // Moved back, so the delete step below still has something to delete
      // where it expects to find it.
      dialogReply = "worktrees";
      if (await openMenuOn("worktrees/opened/renamed.md"))
        await evaluate(
          `[...document.querySelectorAll('.workspace-tree-menu button')].find((button) => button.textContent === 'Move to…').click()`,
        );
      await settles(
        `[...document.querySelectorAll('.workspace-tree-entry > button')].some((button) => button.getAttribute('title') === 'worktrees/renamed.md')`,
      );
      dialogReply = undefined;
    }

    at("delete confirmation");
    // 11. Deleting asks first, and a cancelled confirm deletes nothing. The
    //     dialog is answered through CDP, so this is the real `window.confirm`.
    await openMenuOn("worktrees/renamed.md");
    acceptDialogs = false;
    await evaluate(
      `[...document.querySelectorAll('.workspace-tree-menu button')].find((button) => button.textContent === 'Delete').click()`,
    );
    await Bun.sleep(500);
    if (!(await pathExists(join(workspacePath, "worktrees", "renamed.md"))))
      failures.push(
        "Cancelling the delete confirmation deleted the file anyway",
      );

    await openMenuOn("worktrees/renamed.md");
    acceptDialogs = true;
    await evaluate(
      `[...document.querySelectorAll('.workspace-tree-menu button')].find((button) => button.textContent === 'Delete').click()`,
    );
    if (
      !(await settles(
        `![...document.querySelectorAll('.workspace-tree-entry > button')].some((button) => button.getAttribute('title') === 'worktrees/renamed.md')`,
      ))
    )
      failures.push("A confirmed delete left the row in the tree");
    if (await pathExists(join(workspacePath, "worktrees", "renamed.md")))
      failures.push("A confirmed delete never reached the filesystem");
    // Two prompts, not one: deleting without asking would pass both assertions
    // above and still be the wrong behaviour.
    const confirms = dialogs.filter((dialog) => dialog.type === "confirm");
    if (confirms.length !== 2)
      failures.push(
        `Expected the two delete confirmations to be asked; saw ${confirms.length} of ${dialogs.length} dialogs`,
      );
    if (!confirms.every((dialog) => dialog.message.includes("renamed.md")))
      failures.push(
        `A delete confirmation did not name the file: ${JSON.stringify(confirms)}`,
      );
  }

  // 13. The generated files are not offered. This is the check that was
  //      missing: deleting BRIEF.md *succeeded*, and the content refetch that
  //      follows every mutation recreated it before the tree redrew, so the
  //      menu item looked broken while the service was doing exactly what it
  //      was told. Refusing is the honest answer, and the menu says so first.
  at("the generated-file context menu");
  // The drags above left the file tree at its floor, so most of the root is
  // scrolled out of it. Give the tree its room back before asking for rows.
  at("generated: restoring tree height");
  await drag(".explorer-section-resize-handle", 0, 2000);
  // One file, not the whole list. Which entries count as generated is a pure
  // predicate asserted in `bun test`; what needs a browser is that the menu is
  // actually wired to it, and one file proves that. Driving three menus in a
  // row was harness fragility with no extra coverage.
  for (const generated of ["BRIEF.md"]) {
    at(`generated: opening menu on ${generated}`);
    if (!(await openMenuOn(generated))) continue;
    at(`generated: reading menu for ${generated}`);
    const items = await evaluate<Array<{ label: string; disabled: boolean }>>(
      `[...document.querySelectorAll('.workspace-tree-menu button')].map((button) => ({ label: button.textContent, disabled: button.disabled }))`,
    );
    for (const item of items)
      if (!item.disabled)
        failures.push(
          `"${item.label}" is offered for ${generated}, which Daedalus regenerates`,
        );
    // Greyed out is not enough on its own: with no reason shown it reads as a
    // broken menu, which is how this was reported.
    const reason = await evaluate<string>(
      `document.querySelector('.workspace-tree-menu-reason')?.textContent ?? ""`,
    );
    if (!reason.includes(generated))
      failures.push(
        `The menu for ${generated} greys everything out without saying why (reason: ${JSON.stringify(reason)})`,
      );
    at(`generated: dismissing menu for ${generated}`);
    await dismissMenu();
  }
  at("generated: asking the service directly");
  // And the service refuses it even when the menu is bypassed, because the
  // menu is not a guard.
  const refusedGenerated = await evaluate<string>(`(async () => {
    const response = await fetch('${`http://127.0.0.1:${bridgePort}/remove`}', {
      body: JSON.stringify({ path: 'BRIEF.md' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();
    return body.ok ? 'ALLOWED' : body.error.code;
  })()`);
  if (refusedGenerated !== "CONFLICT")
    failures.push(
      `Removing BRIEF.md over RPC answered ${refusedGenerated}; a generated file must be refused, not deleted and recreated`,
    );
  if (!(await pathExists(join(workspacePath, "BRIEF.md"))))
    failures.push("BRIEF.md is gone after the service was asked to remove it");

  at("the read-only context menu");
  // 12. The read-only checkouts are read-only in the menu too. The service
  //     refuses them as well, but a menu item that is going to fail should
  //     not look clickable.
  await ensureOpen("repos", "repos/daedalus");
  await waitFor(
    `document.querySelector('.workspace-tree-entry > button[title="repos/daedalus"]')`,
    "the repos folder to open",
  );
  await openMenuOn("repos/daedalus");
  const repoMenu = await evaluate<Array<{ label: string; disabled: boolean }>>(
    `[...document.querySelectorAll('.workspace-tree-menu button')].map((button) => ({ label: button.textContent, disabled: button.disabled }))`,
  );
  for (const item of repoMenu)
    if (!item.disabled)
      failures.push(
        `"${item.label}" is offered for a read-only repository checkout`,
      );
  await dismissMenu();

  await send("Page.captureScreenshot", {}).then(async (result) => {
    const data = (result as unknown as { data?: string }).data;
    if (data)
      await Bun.write(
        join(artifactsDirectory, "explorer-ui-check.png"),
        Buffer.from(data, "base64"),
      );
  });
} catch (error) {
  // Whatever went wrong, the assertions collected up to that point are still
  // the most useful thing this run produced.
  failures.push(
    `The check could not finish: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  clearTimeout(watchdog);
  // Only on a failure. A wedged renderer answers no assertion at all, so when
  // one happens the useful evidence is what the page last said and how much
  // traffic it was generating — which is how the form-submit wedge above was
  // found, and is worth keeping for the next one.
  if (failures.length > 0 || process.exitCode) {
    console.error(
      `  page console (last 12): ${JSON.stringify(consoleErrors.slice(-12))}`,
    );
    console.error(
      `  bridge traffic: ${JSON.stringify(Object.fromEntries(traffic))}, watcher batches: ${watchEvents}`,
    );
    console.error(`  dialogs seen: ${JSON.stringify(dialogs)}`);
  }
  chrome?.kill();
  vite.kill();
  bridge.stop(true);
  context.close();
  await rm(profile, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(
  "Explorer check passed: open folders survive a reload, closing forgets the subtree, both borders drag within their limits, the tree follows the filesystem without a click while keeping expansion, selection and an unsaved draft, and rename and delete do what they say.",
);

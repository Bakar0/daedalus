/**
 * Drives the real renderer (apps/desktop/src/renderer/nav-test.html, over a
 * fake client) in headless Chrome through Go Back and Go Forward: moves
 * between sessions, workspaces, Home's pages, files, plans, tasks and tabs
 * the way a person does, then walks the history back and forward and checks
 * each step lands where the person had been.
 *
 * `bun run scripts/nav-ui-check.ts` runs every scenario;
 * `bun run scripts/nav-ui-check.ts explore` prints what the page shows.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const port = 41749;
const debuggingPort = 41750;
const pageUrl = `http://127.0.0.1:${port}/nav-test.html`;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactsDirectory = join(projectRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(join(artifactsDirectory, ".nav-check-profile-"));

/** How long a place stays in front before the app counts it, and then some. */
const SETTLE = 450;

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
    "--strictPort",
  ],
  { cwd: projectRoot, stdout: "ignore", stderr: "ignore" },
);

let chrome: Bun.Subprocess | undefined;
let failed = false;
try {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(pageUrl)).ok) break;
    } catch {
      if (attempt === 199) throw new Error("The nav test server did not start");
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
      "--window-size=1500,900",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  let websocketUrl: string | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const pages = (await (
        await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
      ).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      websocketUrl = pages.find(
        (page) => page.type === "page",
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
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: {
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      };
      error?: { message: string };
      result?: unknown;
    };
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      rendererErrors.push(
        details?.exception?.description ?? details?.text ?? "Unknown error",
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
  const send = <T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ) =>
    new Promise<T>((resolveRequest, rejectRequest) => {
      const id = ++sequence;
      pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async <T>(expression: string): Promise<T> => {
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

  const waitFor = async (expression: string, what: string, ms = 5000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return;
      await Bun.sleep(40);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  /** Clicks the centre of the first element matching, as a mouse does. */
  const click = async (selector: string, what = selector, count = 1) => {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`, what);
    const point = await evaluate<{ x: number; y: number } | null>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: "nearest" });
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!point) throw new Error(`${what} has no size to click`);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    for (let clickCount = 1; clickCount <= count; clickCount += 1)
      for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", {
          type,
          x: point.x,
          y: point.y,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount,
        });
  };

  /** Clicks the element whose text is exactly `text`, among `selector`. */
  const clickText = async (selector: string, text: string, count = 1) => {
    const marked = await evaluate<boolean>(`(() => {
      document.querySelectorAll("[data-nav-target]").forEach((el) => el.removeAttribute("data-nav-target"));
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((el) => el.textContent.trim() === ${JSON.stringify(text)});
      if (!element) return false;
      element.setAttribute("data-nav-target", "");
      return true;
    })()`);
    if (!marked) throw new Error(`No ${selector} reads "${text}"`);
    await click("[data-nav-target]", `"${text}"`, count);
  };

  /** ⌃- or ⌃⇧-, sent to whatever has focus. */
  const press = async (direction: "back" | "forward") => {
    const shift = direction === "forward";
    const key = shift ? "_" : "-";
    const base = {
      key,
      code: "Minus",
      windowsVirtualKeyCode: 189,
      nativeVirtualKeyCode: 189,
      modifiers: 2 | (shift ? 8 : 0),
    };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  /** Where the app is, as the page shows it. */
  const probe = () =>
    evaluate<string>(`(() => {
      const homeLink = document.querySelector('.sidebar-routines-link[aria-current="page"]');
      const homePage = document.querySelector('.home-page');
      if (homePage)
        return 'home:' + (homeLink?.textContent.trim().split(/\\s/)[0] ?? '?');
      const ws = document.querySelector('[data-tree-id^="w:"][aria-current="true"]')?.dataset.treeId?.slice(2)
        ?? 'home';
      const center = document.querySelector('[data-area="center"]');
      const tab = center?.querySelector('.dv-groupview.dv-active-group .dv-tab.dv-active-tab')
        ?? center?.querySelector('.dv-tab.dv-active-tab');
      const session = document.querySelector('[data-tree-id^="s:"][aria-selected="true"]')?.dataset.treeId?.slice(2);
      const tabText = tab?.querySelector('.file-tab-name')?.textContent.trim() ?? tab?.textContent.trim() ?? 'none';
      return ws + '/' + (session ? 'session:' + session : 'tab:' + tabText);
    })()`);

  const backButton = '.nav-history-button[aria-label="Go back"]';
  const forwardButton = '.nav-history-button[aria-label="Go forward"]';
  const buttonDisabled = (selector: string) =>
    evaluate<boolean>(
      `Boolean(document.querySelector(${JSON.stringify(selector)})?.disabled)`,
    );

  const load = async () => {
    rendererErrors.length = 0;
    await send("Page.navigate", { url: pageUrl });
    await waitFor(
      "document.querySelector('.nav-history-button')",
      "the app to render",
      15000,
    );
    await Bun.sleep(800);
  };

  if (process.argv[2] === "debug") {
    // A1 -> file one -> file two, back twice, then forward step by step.
    await load();
    const state = async (label: string) =>
      console.log(
        label.padEnd(18),
        await probe(),
        "back:",
        !(await buttonDisabled(backButton)),
        "fwd:",
        !(await buttonDisabled(forwardButton)),
        "tabs:",
        await evaluate<string>(
          `[...document.querySelectorAll('[data-area="center"] .dv-tab')].map((el) => (el.querySelector('.file-tab-name')?.textContent ?? '?') + (el.querySelector('.file-tab-name')?.className.includes('preview') || el.querySelector('[class*="preview"]') ? '(preview)' : '')).join(', ')`,
        ),
      );
    await state("start");
    const side = `.side-panel-tab[title="Files"]`;
    void side;
    for (const name of ["alpha-one.md", "alpha-two.md"]) {
      await clickText('[role="treeitem"]', name, 2);
      await Bun.sleep(SETTLE);
      await state(`open ${name}`);
    }
    console.log(
      "focus:",
      await evaluate<string>(
        `(() => { const el = document.activeElement; return el.tagName + '.' + el.className + ' in ' + (el.closest('[data-area]')?.dataset.area ?? 'none'); })()`,
      ),
    );
    for (const direction of ["back", "back", "forward", "forward"] as const) {
      await press(direction);
      await Bun.sleep(SETTLE);
      await state(`key ${direction}`);
    }
    for (const direction of ["back", "back", "forward"] as const) {
      await click(direction === "back" ? backButton : forwardButton);
      await Bun.sleep(SETTLE);
      await state(`button ${direction}`);
    }
    // Any re-render: if Forward comes back, its disabled state was stale.
    await click('.side-panel-tab[title="Tasks"]');
    await Bun.sleep(SETTLE);
    await state("after a re-render");
    await click(forwardButton);
    await Bun.sleep(SETTLE);
    await state("button forward");
    console.log(
      "focus:",
      await evaluate<string>(
        `(() => { const el = document.activeElement; return el.tagName + '.' + el.className + ' in ' + (el.closest('[data-area]')?.dataset.area ?? 'none'); })()`,
      ),
    );
    for (const direction of ["back", "forward"] as const) {
      await press(direction);
      await Bun.sleep(SETTLE);
      await state(`key ${direction}`);
    }
    await Bun.sleep(1500);
    await state("1.5s later");
    console.log("errors:", rendererErrors);
  } else if (process.argv[2] === "explore") {
    await load();
    if (process.argv[3]) {
      for (const id of process.argv.slice(3)) {
        await click(`[data-tree-id="s:${id}"]`);
        await Bun.sleep(1500);
        console.log("after", id, await probe());
      }
    }
    console.log("place:", await probe());
    console.log(
      await evaluate<string>(`(() => {
        const describe = (el) => el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' "' + el.textContent.trim().slice(0, 40) + '"';
        const out = [];
        out.push('home links: ' + [...document.querySelectorAll('.sidebar-home-link, .sidebar-routines-link')].map(describe).join(' | '));
        out.push('tree: ' + [...document.querySelectorAll('[data-tree-id]')].map((el) => el.dataset.treeId).join(' '));
        out.push('center tabs: ' + [...document.querySelectorAll('[data-area="center"] .dv-tab')].map(describe).join(' | '));
        out.push('center: ' + (document.querySelector('[data-area="center"]')?.textContent.trim().slice(0, 200) ?? 'none'));
        out.push('selected: ' + [...document.querySelectorAll('[aria-selected="true"], [aria-current]')].map(describe).join(' | '));
        out.push('side tabs: ' + [...document.querySelectorAll('.side-panel-tab')].map((el) => el.title + '=' + el.getAttribute('aria-selected')).join(' | '));
        out.push('file rows: ' + [...document.querySelectorAll('[role="treeitem"]')].filter((el) => !el.dataset.treeId).map(describe).join(' | '));
        out.push('buttons: ' + [...document.querySelectorAll('button')].map((el) => el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20)).filter(Boolean).join(', '));
        return out.join('\\n');
      })()`),
    );
    console.log("unstubbed:", await evaluate("window.navTest.unstubbed()"));
    console.log("errors:", rendererErrors);
  } else {
    type Step = () => Promise<void>;
    interface Scenario {
      name: string;
      run: (helpers: ScenarioHelpers) => Promise<void>;
    }
    interface ScenarioHelpers {
      /** Takes a navigation step, waits for it to count, and notes where it landed. */
      go: (what: string, step: Step) => Promise<string>;
      /** Walks back over every noted place, then forward again, checking each. */
      walk: (how?: "keys" | "buttons") => Promise<void>;
      expect: (what: string, actual: string, expected: string) => void;
      places: string[];
    }

    const results: { name: string; ok: boolean; detail: string }[] = [];
    const scenarios: Scenario[] = [];
    const scenario = (name: string, run: Scenario["run"]) =>
      scenarios.push({ name, run });

    const sidebarSession = (id: string) => `[data-tree-id="s:${id}"]`;
    const sidebarWorkspace = (id: string) => `[data-tree-id="w:${id}"]`;
    const openSession = (id: string) => async () => {
      await click(sidebarSession(id), `session ${id}`);
    };
    const openHome = (page: "Activity" | "Routines") => async () => {
      await clickText(".sidebar-home-link, .sidebar-routines-link", page);
    };
    // A click on the side panel's open tab folds the panel, so only a
    // closed one is clicked.
    const sideTab = (label: string) => async () => {
      const selector = `.side-panel-tab[title=${JSON.stringify(label)}]`;
      if (
        await evaluate<boolean>(
          `document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-selected") === "true"`,
        )
      )
        return;
      await click(selector, `side tab ${label}`);
      await Bun.sleep(150);
    };
    const openFile = (name: string) => async () => {
      await sideTab("Files")();
      await waitFor(
        `[...document.querySelectorAll('[role="treeitem"]')].some((el) => el.textContent.trim() === ${JSON.stringify(name)})`,
        `file ${name} in the explorer`,
      );
      await clickText('[role="treeitem"]', name, 2);
    };
    const centerTab = (text: string) => async () => {
      await clickText('[data-area="center"] .dv-tab .file-tab-name', text);
    };

    for (const entry of [
      [
        "1 sessions across workspaces",
        async (h: ScenarioHelpers) => {
          await h.go("A1", openSession("s-a1"));
          await h.go("A2", openSession("s-a2"));
          await h.go("B1", openSession("s-b1"));
          await h.walk();
        },
      ],
      [
        "2 session, Activity, Routines, session",
        async (h: ScenarioHelpers) => {
          await h.go("A1", openSession("s-a1"));
          await h.go("Activity", openHome("Activity"));
          await h.go("Routines", openHome("Routines"));
          await h.go("B1", openSession("s-b1"));
          await h.walk();
        },
      ],
      [
        "3 Activity, file in A, plans in A",
        async (h: ScenarioHelpers) => {
          await h.go("Activity", openHome("Activity"));
          await h.go("A1", openSession("s-a1"));
          await h.go("file alpha-one", openFile("alpha-one.md"));
          await h.go("A1 again", openSession("s-a1"));
          await h.go("plans", async () => {
            await clickText(".plans-pane button", "Open ↗");
          });
          await h.walk();
        },
      ],
      [
        "4 switching tabs in one workspace",
        async (h: ScenarioHelpers) => {
          await h.go("A1", openSession("s-a1"));
          await h.go("file one", openFile("alpha-one.md"));
          await h.go("file two", openFile("alpha-two.md"));
          await h.go("tab one", centerTab("alpha-one.md"));
          await h.go("tab two", centerTab("alpha-two.md"));
          await h.go("session tab", async () => {
            const titles = await evaluate<string[]>(
              `[...document.querySelectorAll('[data-area="center"] .dv-tab .file-tab-name')].map((el) => el.textContent.trim())`,
            );
            const sessionTab = titles.find((title) => !title.includes(".md"));
            if (!sessionTab) throw new Error(`No session tab in ${titles}`);
            await centerTab(sessionTab)();
          });
          await h.walk("buttons");
        },
      ],
      [
        "5 plans from its button while a session shows",
        async (h: ScenarioHelpers) => {
          await h.go("A2", openSession("s-a2"));
          await h.go("plans", async () => {
            await clickText(".plans-pane button", "Open ↗");
          });
          await h.walk();
        },
      ],
      [
        "6 task, board, session",
        async (h: ScenarioHelpers) => {
          await h.go("A1", openSession("s-a1"));
          await h.go("task", async () => {
            await sideTab("Tasks")();
            await clickText(".task-card, [data-task-id]", "Task in A").catch(
              async () => click('[data-task-id="task-a"]', "task card"),
            );
          });
          await h.go("board", async () => {
            await click(".task-drawer-close", "close task");
          });
          await h.go("B1", openSession("s-b1"));
          await h.walk();
        },
      ],
      [
        "7 new place after Back drops Forward",
        async (h: ScenarioHelpers) => {
          await h.go("A1", openSession("s-a1"));
          await h.go("A2", openSession("s-a2"));
          await h.go("B1", openSession("s-b1"));
          await press("back");
          await Bun.sleep(SETTLE);
          h.expect("after Back", await probe(), h.places[1]!);
          await openSession("s-a1")();
          await Bun.sleep(SETTLE);
          h.expect(
            "Go forward disabled",
            String(await buttonDisabled(forwardButton)),
            "true",
          );
          await press("back");
          await Bun.sleep(SETTLE);
          h.expect("Back after the new place", await probe(), h.places[1]!);
        },
      ],
      [
        "8 Back within 100ms of arriving",
        async (h: ScenarioHelpers) => {
          await h.go("A1", openSession("s-a1"));
          await h.go("A2", openSession("s-a2"));
          await openSession("s-b1")();
          await Bun.sleep(80);
          await press("back");
          await Bun.sleep(SETTLE);
          h.expect("Back right after arriving", await probe(), h.places[1]!);
          await press("forward");
          await Bun.sleep(SETTLE);
          h.expect("Forward to it again", await probe(), "ws-b/session:s-b1");
        },
      ],
      [
        "9 Home file, Activity, Back",
        async (h: ScenarioHelpers) => {
          await h.go("A1", openSession("s-a1"));
          await h.go("Activity", openHome("Activity"));
          await h.go("home file", openFile("home-notes.md"));
          await h.go("Routines", openHome("Routines"));
          await h.walk();
        },
      ],
      [
        "10 keys with the caret in the file editor",
        async (h: ScenarioHelpers) => {
          await h.go("A1", openSession("s-a1"));
          await h.go("file one", openFile("alpha-one.md"));
          await h.go("file two", openFile("alpha-two.md"));
          await click(
            '[data-area="center"] .monaco-editor .view-lines',
            "the editor text",
          );
          await Bun.sleep(150);
          h.expect(
            "focus in the editor",
            String(
              await evaluate<boolean>(
                `Boolean(document.activeElement?.closest('.monaco-editor'))`,
              ),
            ),
            "true",
          );
          await press("back");
          await Bun.sleep(SETTLE);
          h.expect("⌃- from the editor", await probe(), h.places.at(-2)!);
          await click(
            '[data-area="center"] .monaco-editor .view-lines',
            "the editor text",
          );
          await Bun.sleep(150);
          await press("forward");
          await Bun.sleep(SETTLE);
          h.expect("⌃⇧- from the editor", await probe(), h.places.at(-1)!);
        },
      ],
      [
        "11 Routines, Activity, Home file, workspace B, mixed",
        async (h: ScenarioHelpers) => {
          await h.go("Routines", openHome("Routines"));
          await h.go("Activity", openHome("Activity"));
          await h.go("home file", openFile("home-notes.md"));
          await h.go("B1", openSession("s-b1"));
          await h.go("Activity again", openHome("Activity"));
          await h.walk("buttons");
          await h.walk();
        },
      ],
    ] as const)
      scenario(entry[0], entry[1]);

    for (const { name, run } of scenarios) {
      await load();
      const problems: string[] = [];
      // Where the page opened is the first place in its history.
      const places: string[] = [await probe()];
      const labels: string[] = ["start"];
      const helpers: ScenarioHelpers = {
        places,
        go: async (what, step) => {
          await step();
          await Bun.sleep(SETTLE);
          const place = await probe();
          // Showing the place already in front adds nothing to the history.
          if (place !== places.at(-1)) {
            places.push(place);
            labels.push(what);
          }
          return place;
        },
        expect: (what, actual, expected) => {
          if (actual !== expected)
            problems.push(`${what}: expected ${expected}, got ${actual}`);
        },
        walk: async (how = "keys") => {
          const step = async (direction: "back" | "forward") => {
            if (how === "buttons")
              await click(direction === "back" ? backButton : forwardButton);
            else await press(direction);
            await Bun.sleep(SETTLE);
          };
          for (let index = places.length - 2; index >= 0; index -= 1) {
            await step("back");
            helpers.expect(
              `Back to ${labels[index]}`,
              await probe(),
              places[index]!,
            );
          }
          helpers.expect(
            "Go back disabled at the start",
            String(await buttonDisabled(backButton)),
            "true",
          );
          for (let index = 1; index < places.length; index += 1) {
            await step("forward");
            helpers.expect(
              `Forward to ${labels[index]}`,
              await probe(),
              places[index]!,
            );
          }
        },
      };
      try {
        await run(helpers);
      } catch (error) {
        problems.push(`step failed: ${(error as Error).message}`);
      }
      if (rendererErrors.length)
        problems.push(`renderer errors: ${rendererErrors.join(" / ")}`);
      const ok = problems.length === 0;
      if (!ok) failed = true;
      results.push({
        name,
        ok,
        detail: ok
          ? `${labels.join(" -> ")}: ${places.join(" -> ")}`
          : `${problems.join("\n    ")}\n    places: ${places.join(" -> ")}`,
      });
      console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
      console.log(`    ${results.at(-1)!.detail}`);
    }
    console.log(
      "unstubbed requests:",
      await evaluate("window.navTest.unstubbed()"),
    );
  }
  socket.close();
} finally {
  chrome?.kill();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}
if (failed) process.exit(1);

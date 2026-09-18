/**
 * Drives the repository picker with real keys in a real browser.
 *
 * The point is what markup cannot show. Whether Space ticks a row and whether
 * Enter submits depends on what actually holds focus and on the platform's own
 * handling of a checkbox inside a form — neither of which is scripted in the
 * app, and neither of which a rendered-HTML assertion can observe. Synthesised
 * events would not prove it either: these go in through CDP as genuine input.
 *
 * Gated like the other browser checks: `bun run test:repo-picker-ui`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
// Free ports rather than fixed ones. A Chrome left behind by an interrupted
// run keeps listening on its debugging port, and the next run then attaches to
// that dead browser and sees an empty page with no errors — which looks exactly
// like a renderer crash and is nothing of the kind.
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
const pageUrl = `http://127.0.0.1:${port}/picker-test.html`;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactsDirectory = join(projectRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(
  join(artifactsDirectory, ".picker-check-profile-"),
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(pageUrl)).ok) break;
    } catch {
      if (attempt === 199) throw new Error("Picker test server did not start");
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
      "--window-size=1280,900",
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
        page.url.startsWith(pageUrl),
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

  // Real key input, not synthesised events: the platform's own handling of a
  // focused checkbox is the behaviour under test.
  const press = async (key: string, code: string, text?: string) => {
    const base = { key, code, windowsVirtualKeyCode: 0 } as Record<
      string,
      unknown
    >;
    const codes: Record<string, number> = {
      ArrowDown: 40,
      ArrowUp: 38,
      Enter: 13,
      Space: 32,
    };
    base.windowsVirtualKeyCode = codes[code] ?? 0;
    base.nativeVirtualKeyCode = base.windowsVirtualKeyCode;
    await send("Input.dispatchKeyEvent", {
      ...base,
      type: text ? "keyDown" : "rawKeyDown",
      // Chrome needs both forms of the character, or a printable key arrives
      // without the text that makes it activate the focused control.
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    await Bun.sleep(120);
  };

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await evaluate<boolean>(
        "!!document.querySelector('input[data-repository-option]')",
      )
    )
      break;
    await Bun.sleep(50);
  }

  // The row's name, not its tick mark: the check indicator is the label's
  // first text node, so reading innerText reports "✓" for every row.
  const focusedLabel = () =>
    evaluate<string>(
      "document.activeElement?.closest('label')?.querySelector('strong')?.textContent ?? document.activeElement?.tagName ?? ''",
    );
  const selectionCount = () =>
    evaluate<string>(
      "document.querySelector('.repository-selection-count')?.textContent || ''",
    );
  const checkedNames = () =>
    evaluate<string[]>(
      "[...document.querySelectorAll('input[data-repository-option]')].filter((i) => i.checked).map((i) => i.closest('label').querySelector('strong').textContent)",
    );

  // A headless window is not focused, so the document would ignore key events
  // and `autoFocus` never applies. Focus emulation plus an explicit focus puts
  // the page in the state the real modal opens in; everything after this point
  // is the platform's own behaviour under real keys.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const focusedSearch = await evaluate<boolean>(
    "(() => { const s = document.querySelector('.repository-unified-search input'); s.focus(); return document.activeElement === s; })()",
  );
  if (!focusedSearch) failures.push("Could not focus the search box");

  await press("ArrowDown", "ArrowDown");
  if ((await focusedLabel()) !== "alpha")
    failures.push(
      `Down from the search box should focus the first repository, focused "${await focusedLabel()}"`,
    );

  // Space is the platform's, not ours.
  await press(" ", "Space", " ");
  if ((await checkedNames()).join(",") !== "alpha")
    failures.push(
      `Space should tick the focused repository, ticked "${(await checkedNames()).join(",")}"`,
    );

  await press("ArrowDown", "ArrowDown");
  await press(" ", "Space", " ");
  if ((await checkedNames()).join(",") !== "alpha,beta")
    failures.push(
      `A second Space should add to the selection, ticked "${(await checkedNames()).join(",")}"`,
    );

  // Up walks back, and unticking has to work the same way.
  await press("ArrowUp", "ArrowUp");
  if ((await focusedLabel()) !== "alpha")
    failures.push(
      `Up should walk back to the previous repository, focused "${await focusedLabel()}"`,
    );
  await press(" ", "Space", " ");
  if ((await checkedNames()).join(",") !== "beta")
    failures.push(
      `Space should untick a ticked repository, ticked "${(await checkedNames()).join(",")}"`,
    );

  if (!(await selectionCount()).includes("1 selected"))
    failures.push(
      `The footer should count the selection, showed "${await selectionCount()}"`,
    );

  // Enter from the search box, which is where the modal opens and where a user
  // who ticked rows with the mouse still has the caret. This is the case that
  // actually broke: implicit submission clicks the form's FIRST submit button,
  // so a disabled one above the primary action swallowed every Enter, while
  // pressing Enter on a focused checkbox still worked and hid it.
  const backToSearch = await evaluate<boolean>(
    "(() => { const s = document.querySelector('.repository-unified-search input'); s.focus(); return document.activeElement === s; })()",
  );
  if (!backToSearch) failures.push("Could not return focus to the search box");
  // Carrying its text, so it arrives as a real Enter rather than a bare key
  // code that never reaches implicit form submission.
  await press("Enter", "Enter", "\r");
  const attached = await evaluate<string[]>("window.pickerAttached");
  if (attached.join(",") !== "r2")
    failures.push(
      `Enter should submit the ticked repositories, submitted "${attached.join(",")}"`,
    );
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
  "Repository picker check passed: arrows move, Space ticks, Enter submits.",
);

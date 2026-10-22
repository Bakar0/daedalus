/**
 * What one `dataChanged` reload costs the window, measured.
 *
 *   bun run scripts/render-perf-check.ts <snapshot.json> [board|session] [reloads]
 *
 * Builds `render-perf-test.html` for production with React's profiling build
 * (development React is several times slower and would measure the wrong
 * thing), opens it in headless Chrome, triggers the reloads one at a time and
 * prints the median and 90th percentile of React's commit time and of the
 * whole reload, request to paint.
 *
 * The snapshot is a `DesktopSnapshotDto` as JSON; `scripts/perf-snapshot.ts`
 * writes one the size of a real machine's.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = resolve(import.meta.dir, "..");
const [snapshotPath, view = "board", reloadsArgument = "40"] =
  Bun.argv.slice(2);
if (!snapshotPath) {
  console.error(
    "Usage: bun run scripts/render-perf-check.ts <snapshot.json> [board|session] [reloads]",
  );
  process.exit(2);
}
const reloads = Number(reloadsArgument);
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const renderer = join(projectRoot, "apps/desktop/src/renderer");
const outDir = await mkdtemp(join(tmpdir(), "daedalus-render-perf-"));

await build({
  configFile: false,
  logLevel: "warn",
  root: renderer,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react-dom\/client$/, replacement: "react-dom/profiling" },
      {
        find: "electrobun/browser",
        replacement: join(projectRoot, ".hutch/devkit/api/browser/index.ts"),
      },
    ],
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: join(renderer, "render-perf-test.html") },
  },
});

const snapshot = await Bun.file(snapshotPath).text();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/snapshot.json")
      return new Response(snapshot, {
        headers: { "content-type": "application/json" },
      });
    const file = Bun.file(join(outDir, path === "/" ? "index.html" : path));
    return file.size ? new Response(file) : new Response("", { status: 404 });
  },
});
const pageUrl = `http://127.0.0.1:${server.port}/render-perf-test.html?data=/snapshot.json&view=${view}`;
const profile = await mkdtemp(join(tmpdir(), "daedalus-render-perf-chrome-"));
const debuggingPort = 41000 + Math.floor(Math.random() * 1000);
const chrome = Bun.spawn(
  [
    chromePath,
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    pageUrl,
  ],
  { stdout: "ignore", stderr: "ignore" },
);

try {
  let websocketUrl: string | undefined;
  for (let attempt = 0; attempt < 200 && !websocketUrl; attempt += 1) {
    try {
      const pages = (await (
        await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
      ).json()) as Array<{ url: string; webSocketDebuggerUrl: string }>;
      websocketUrl = pages.find(
        (page) => page.url === pageUrl,
      )?.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    if (!websocketUrl) await Bun.sleep(50);
  }
  if (!websocketUrl) throw new Error("Chrome DevTools endpoint did not start");
  const socket = new WebSocket(websocketUrl);
  await new Promise((open) =>
    socket.addEventListener("open", open, { once: true }),
  );
  let sequence = 0;
  const pending = new Map<number, (value: unknown) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(
      message.result?.result?.value ?? message.result?.metrics,
    );
    pending.delete(message.id);
  });
  const evaluate = <T>(expression: string): Promise<T> =>
    new Promise((answer) => {
      const id = ++sequence;
      pending.set(id, answer as (value: unknown) => void);
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await evaluate<boolean>("Boolean(window.renderPerf?.commits.length)"))
      break;
    await Bun.sleep(50);
  }
  const metrics = () =>
    new Promise<Record<string, number>>((answer) => {
      const id = ++sequence;
      pending.set(id, (value) =>
        answer(
          Object.fromEntries(
            (value as Array<{ name: string; value: number }>).map((item) => [
              item.name,
              item.value,
            ]),
          ),
        ),
      );
      socket.send(JSON.stringify({ id, method: "Performance.getMetrics" }));
    });
  socket.send(JSON.stringify({ id: ++sequence, method: "Performance.enable" }));
  // Let the first loads settle before anything is counted.
  await Bun.sleep(1_000);
  const before = await metrics();
  const results = await evaluate<{ commit: number[]; reload: number[] }>(`
    (async () => {
      const commit = [], reload = [];
      for (let i = 0; i < ${reloads}; i++) {
        const before = window.renderPerf.commits.length;
        const start = performance.now();
        await window.renderPerf.reload();
        reload.push(performance.now() - start);
        commit.push(window.renderPerf.commits.slice(before).reduce((a, b) => a + b, 0));
      }
      return { commit, reload };
    })()
  `);
  const after = await metrics();
  const perReload = (name: string) =>
    (((after[name] ?? 0) - (before[name] ?? 0)) * 1000) / reloads;
  const stat = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const at = (fraction: number) =>
      sorted[
        Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
      ]!;
    return `median ${at(0.5).toFixed(1)} ms, p90 ${at(0.9).toFixed(1)} ms`;
  };
  console.log(`view ${view}, ${reloads} reloads`);
  console.log(`  React commit per reload: ${stat(results.commit)}`);
  console.log(`  reload, request to paint: ${stat(results.reload)}`);
  console.log(
    `  main thread per reload: ${perReload("TaskDuration").toFixed(1)} ms ` +
      `(script ${perReload("ScriptDuration").toFixed(1)}, ` +
      `style ${perReload("RecalcStyleDuration").toFixed(1)}, ` +
      `layout ${perReload("LayoutDuration").toFixed(1)})`,
  );
  socket.close();
} finally {
  chrome.kill();
  server.stop(true);
  await rm(outDir, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}

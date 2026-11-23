/**
 * Runs and drives the dev app on Chromium, so an agent can see and operate
 * the real window. See scripts/lib/dev-app.ts for how it works.
 *
 *   bun scripts/dev-app.ts start                build and start it, wait for the window
 *   bun scripts/dev-app.ts stop                 stop the app this checkout started
 *   bun scripts/dev-app.ts status
 *   bun scripts/dev-app.ts shot <file.png> [--size 1288x801]
 *   bun scripts/dev-app.ts text                 the window's visible text
 *   bun scripts/dev-app.ts click "<text>" [--nth N]
 *   bun scripts/dev-app.ts key <Key>            such as Enter or Meta+K
 *   bun scripts/dev-app.ts eval "<expression>"
 *   bun scripts/dev-app.ts run <script.ts>      a Playwright script; see below
 *
 * `click` presses the real mouse on the Nth (from 0) visible element whose
 * text or accessible name is exactly <text>. `run` imports the script and
 * calls its default export with the connected app:
 *
 *   import type { DevApp } from "./lib/dev-app";
 *   export default async ({ page, shot }: DevApp) => { ... };
 */
import { resolve } from "node:path";
import {
  connect,
  logFile,
  start,
  status,
  stop,
  type DevApp,
} from "./lib/dev-app";

const usage = `usage: bun scripts/dev-app.ts <command>
  start                          build and start the dev app, wait for the window
  stop                           stop the dev app this checkout started
  status                         whether a dev app runs, and whose
  shot <file.png> [--size WxH]   screenshot the window
  text                           print the window's visible text
  click <text> [--nth N]         click the Nth element named <text>
  key <Key>                      press a key, such as Enter or Meta+K
  eval <expression>              evaluate JS in the window, print the result
  run <script.ts>                run a Playwright script against the window`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  args.splice(index, 2);
  return value;
}

async function withApp(body: (app: DevApp) => Promise<void>) {
  const app = await connect();
  try {
    await body(app);
  } finally {
    await app.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  switch (command) {
    case "start":
      await start((line) => console.log(line));
      console.log("the dev app is ready");
      return;
    case "stop":
      console.log(
        (await stop()) ? "stopped" : "this checkout's dev app is not running",
      );
      return;
    case "status": {
      const now = await status();
      console.log(
        now.running.length
          ? `running: ${now.running.join(", ")}${now.ours ? " (this checkout)" : ""}`
          : "no dev app is running",
      );
      console.log(
        now.ready
          ? "window: answers over CDP"
          : "window: not reachable over CDP",
      );
      if (now.portOwner && !now.ready)
        console.log(`port held by: ${now.portOwner}`);
      console.log(`log: ${logFile}`);
      return;
    }
    case "shot": {
      const size = option(args, "--size");
      const file = args[0];
      if (!file) throw new Error("shot needs a file path");
      let dimensions: { width: number; height: number } | undefined;
      if (size) {
        const [width, height] = size.split("x").map(Number);
        if (!width || !height)
          throw new Error("--size is WxH, such as 1288x801");
        dimensions = { width, height };
      }
      await withApp(async (app) =>
        console.log(await app.shot(file, dimensions)),
      );
      return;
    }
    case "text":
      await withApp(async ({ page }) =>
        console.log(await page.locator("body").innerText()),
      );
      return;
    case "click": {
      const nth = Number(option(args, "--nth") ?? "0");
      const text = args[0];
      if (!text) throw new Error("click needs the element's text");
      await withApp(async ({ page }) => {
        const named = page
          .getByText(text, { exact: true })
          .or(page.getByLabel(text, { exact: true }))
          .or(page.getByRole("button", { name: text, exact: true }));
        const visible = named.filter({ visible: true });
        const count = await visible.count();
        if (nth >= count)
          throw new Error(
            `no element number ${nth} named "${text}" (found ${count})`,
          );
        await visible.nth(nth).click({ timeout: 5000 });
        console.log(
          `clicked "${text}" (${count} match${count === 1 ? "" : "es"})`,
        );
      });
      return;
    }
    case "key": {
      const key = args[0];
      if (!key) throw new Error("key needs a key name, such as Enter");
      await withApp(({ page }) => page.keyboard.press(key));
      return;
    }
    case "eval": {
      const expression = args[0];
      if (!expression) throw new Error("eval needs an expression");
      await withApp(async ({ page }) =>
        console.log(JSON.stringify(await page.evaluate(expression), null, 2)),
      );
      return;
    }
    case "run": {
      const script = args[0];
      if (!script) throw new Error("run needs a script path");
      const module = (await import(resolve(script))) as {
        default?: (app: DevApp) => Promise<void>;
      };
      if (typeof module.default !== "function")
        throw new Error(`${script} has no default export function`);
      await withApp(module.default);
      return;
    }
    default:
      console.log(usage);
      if (command && command !== "help" && command !== "--help")
        process.exit(2);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

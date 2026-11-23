/**
 * Proves an agent can see and drive the real dev app: starts this checkout's
 * dev app on Chromium (or reuses it), attaches Playwright, waits for the
 * workspace shell, opens and closes Settings with real clicks and keys, and
 * screenshots each state into artifacts/dev-app-*.png. Fails on any error the
 * window logs meanwhile. Leaves the app running; `bun scripts/dev-app.ts stop`
 * ends it.
 *
 *   bun run test:app
 */
import { join } from "node:path";
import { connect, projectRoot, start } from "./lib/dev-app";

const artifacts = join(projectRoot, "artifacts");

await start((line) => console.log(line));
const app = await connect();
const errors: string[] = [];
app.page.on("pageerror", (error) => errors.push(error.message));
app.page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
try {
  const { page } = app;
  await page.locator(".app").waitFor({ timeout: 30_000 });
  await page.getByText("Workspaces", { exact: true }).first().waitFor();
  console.log(await app.shot(join(artifacts, "dev-app-shell.png")));

  await page.getByRole("button", { name: "Open settings" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 5000 });
  console.log(await app.shot(join(artifacts, "dev-app-settings.png")));
  // Settings has focus, not a terminal, so Escape cannot interrupt an agent.
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached", timeout: 5000 });

  if (errors.length)
    throw new Error(`the window logged errors:\n${errors.join("\n")}`);
  console.log("dev app check passed");
} finally {
  await app.close();
}

/**
 * The workspace menu's cloud items in a real browser, against
 * `cloud-test.tsx`: Run in cloud for a local workspace; status, Sleep, Wake
 * and a Delete that needs a second click for a cloud one; nothing while this
 * Mac is signed out. The menu has to stay inside the window at two heights.
 *
 *   bun run test:cloud-menu-ui
 */
import {
  expect,
  openMenu,
  withBrowser,
  type Browser,
} from "./lib/browser-check";

const open = async (browser: Browser, workspace: string) => {
  expect(
    await browser.evaluate<boolean>(openMenu(`Settings of ${workspace}`)),
    `no menu for ${workspace}`,
  );
  await browser.waitFor(
    `document.querySelector('summary[aria-label="Settings of ${workspace}"]').parentElement.querySelector('.menu-popover:popover-open')`,
    `the ${workspace} menu to open`,
  );
  browser.scope = ".menu-popover:popover-open";
};

const closeMenus = (browser: Browser) => {
  browser.scope = "";
  return browser.evaluate(
    `document.querySelectorAll('details.menu[open]').forEach((one) => { one.open = false; })`,
  );
};

const requestNames = async (browser: Browser) =>
  (await browser.requests()).map((one) => Object.keys(one)[0]);

const lastRequest = async (browser: Browser) =>
  JSON.stringify((await browser.requests()).at(-1));

const menuInsideWindow = async (browser: Browser, label: string) => {
  for (const height of [820, 560]) {
    await browser.resize(height);
    const seen = await browser.evaluate<{
      top: number;
      bottom: number;
      viewport: number;
    }>(`(() => {
      const rect = document.querySelector('.menu-popover:popover-open').getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewport: window.innerHeight };
    })()`);
    expect(
      seen.top >= 0 && seen.bottom <= seen.viewport,
      `the ${label} menu runs off the screen at ${height}px: ${seen.top}..${seen.bottom} of ${seen.viewport}`,
    );
  }
  await browser.resize(820);
};

await withBrowser({ port: 41764, page: "cloud-test.html" }, async (browser) => {
  await browser.waitFor(
    "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
    "the workspace list",
  );
  // The cloud state arrives after the first paint.
  await Bun.sleep(300);

  // A local workspace: Run in cloud, and no status.
  await open(browser, "Plain local");
  expect(
    await browser.has("cloud-run"),
    "no Run in cloud for a local workspace",
  );
  expect(
    !(await browser.has("cloud-status")) &&
      !(await browser.has("cloud-sleep")) &&
      !(await browser.has("cloud-delete")),
    "a local workspace shows cloud status or controls",
  );
  expect(
    (await browser.text("cloud-run")) === "Run in cloud",
    `the item reads "${await browser.text("cloud-run")}"`,
  );
  await menuInsideWindow(browser, "local workspace");
  await browser.screenshot("cloud-menu-local");
  await browser.click("cloud-run");
  await browser.waitFor(
    "window.requests.some((one) => 'cloudWorkspaceCreate' in one)",
    "the create call",
  );
  expect(
    (await lastRequest(browser)) ===
      '{"cloudWorkspaceCreate":{"workspace":"local-ws"}}',
    `Run in cloud sent ${await lastRequest(browser)}`,
  );
  await closeMenus(browser);
  await open(browser, "Plain local");
  await browser.waitFor(
    "document.querySelector('.menu-popover:popover-open [data-testid=\"cloud-status\"]')",
    "the status after Run in cloud",
  );
  expect(
    !(await browser.has("cloud-run")),
    "Run in cloud is still offered once the workspace has one",
  );
  await closeMenus(browser);

  // A running cloud workspace: status, Sleep, no Wake.
  await open(browser, "Cloud project");
  expect(
    (await browser.attribute("cloud-status", "data-status")) === "running",
    "Cloud project is not shown running",
  );
  expect(
    (await browser.has("cloud-sleep")) && !(await browser.has("cloud-wake")),
    "a running workspace should offer Sleep and not Wake",
  );
  expect(
    !(await browser.has("cloud-run")),
    "Run in cloud is offered on a workspace that has one",
  );
  await menuInsideWindow(browser, "running workspace");
  await browser.screenshot("cloud-menu-running");
  await browser.click("cloud-sleep");
  await browser.waitFor(
    "window.requests.some((one) => 'cloudWorkspaceSleep' in one)",
    "the sleep call",
  );
  expect(
    (await lastRequest(browser)) ===
      '{"cloudWorkspaceSleep":{"workspace":"cloud-ws"}}',
    `Sleep sent ${await lastRequest(browser)}`,
  );
  await closeMenus(browser);

  // Asleep: Wake, no Sleep.
  await open(browser, "Cloud project");
  await browser.waitFor(
    "document.querySelector('.menu-popover:popover-open [data-testid=\"cloud-status\"]')?.getAttribute('data-status') === 'sleeping'",
    "the sleeping status",
  );
  expect(
    (await browser.has("cloud-wake")) && !(await browser.has("cloud-sleep")),
    "a sleeping workspace should offer Wake and not Sleep",
  );
  await browser.screenshot("cloud-menu-sleeping");
  await browser.click("cloud-wake");
  await browser.waitFor(
    "window.requests.some((one) => 'cloudWorkspaceWake' in one)",
    "the wake call",
  );
  expect(
    (await lastRequest(browser)) ===
      '{"cloudWorkspaceWake":{"workspace":"cloud-ws"}}',
    `Wake sent ${await lastRequest(browser)}`,
  );
  await closeMenus(browser);

  // Delete asks twice. The first click arms it and sends nothing.
  await open(browser, "Cloud project");
  await browser.waitFor(
    "document.querySelector('.menu-popover:popover-open [data-testid=\"cloud-status\"]')?.getAttribute('data-status') === 'running'",
    "the running status after Wake",
  );
  const before = (await requestNames(browser)).length;
  await browser.click("cloud-delete");
  expect(
    (await requestNames(browser)).length === before,
    "one click on Delete already deleted the cloud workspace",
  );
  expect(
    (await browser.attribute("cloud-delete", "data-armed")) === "true",
    "the first click did not arm Delete",
  );
  await browser.screenshot("cloud-menu-delete-armed");
  // A second click inside the double-click window is ignored on purpose.
  await Bun.sleep(700);
  await browser.click("cloud-delete");
  await browser.waitFor(
    "window.requests.some((one) => 'cloudWorkspaceDelete' in one)",
    "the delete call",
  );
  expect(
    (await lastRequest(browser)) ===
      '{"cloudWorkspaceDelete":{"workspace":"cloud-ws","force":true}}',
    `Delete sent ${await lastRequest(browser)}`,
  );
  await closeMenus(browser);
  await open(browser, "Cloud project");
  await browser.waitFor(
    "document.querySelector('.menu-popover:popover-open [data-testid=\"cloud-run\"]')",
    "Run in cloud after the delete",
  );
  expect(
    !(await browser.has("cloud-status")),
    "the status stays after the cloud workspace was deleted",
  );
  expect(
    await browser.evaluate<boolean>(
      "[...document.querySelectorAll('.session-card')].length > 0",
    ),
    "deleting the cloud workspace removed the local workspace's sessions",
  );
  await browser.screenshot("cloud-menu-after-delete");
});

// Signed out: the menu has no cloud items at all.
await withBrowser(
  { port: 41766, page: "cloud-test.html", query: "signedIn=0" },
  async (browser) => {
    await browser.waitFor(
      "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
      "the workspace list",
    );
    await Bun.sleep(300);
    await open(browser, "Plain local");
    expect(
      !(await browser.has("cloud-run")) && !(await browser.has("cloud-status")),
      "the menu offers cloud items while signed out",
    );
    await browser.screenshot("cloud-menu-signed-out");
  },
);

console.log("cloud menu check passed");

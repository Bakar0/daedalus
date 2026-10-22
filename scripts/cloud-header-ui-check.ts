/**
 * A workspace's cloud icon in a real browser, against `cloud-test.tsx`: the
 * icon shows on a workspace's header only while it has a cloud workspace;
 * its popover has the status, Sleep or Wake, and a Delete under a separator
 * that needs a second click. Nothing while this Mac is signed out, and the
 * workspace menu itself has no cloud items. The popover has to stay inside
 * the window at two heights.
 *
 *   bun run test:cloud-header-ui
 */
import {
  expect,
  openMenu,
  withBrowser,
  type Browser,
} from "./lib/browser-check";

const cloudSummary = (workspace: string) =>
  `document.querySelector('summary[aria-label^="Cloud workspace of ${workspace}:"]')`;

/** Opens a workspace's cloud popover from the icon on its header. */
const open = async (browser: Browser, workspace: string) => {
  browser.scope = "";
  expect(
    await browser.evaluate<boolean>(`(() => {
      const summary = ${cloudSummary(workspace)};
      if (!summary) return false;
      if (!summary.parentElement.open) summary.click();
      return true;
    })()`),
    `no cloud icon on ${workspace}`,
  );
  await browser.waitFor(
    `${cloudSummary(workspace)}.parentElement.querySelector('.menu-popover:popover-open')`,
    `the ${workspace} cloud popover to open`,
  );
  browser.scope = ".menu-popover:popover-open";
};

/** Whether a workspace's header shows the cloud icon. */
const hasIcon = (browser: Browser, workspace: string) =>
  browser.evaluate<boolean>(`Boolean(${cloudSummary(workspace)})`);

const openSettings = async (browser: Browser, workspace: string) => {
  browser.scope = "";
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

  // A local workspace: no cloud items at all; its first cloud session makes
  // its cloud workspace, so there is nothing to enable here.
  // A local workspace: no cloud icon, and no cloud items in its menu; its
  // first cloud session makes its cloud workspace.
  expect(
    !(await hasIcon(browser, "Plain local")),
    "a local workspace shows a cloud icon",
  );
  await openSettings(browser, "Plain local");
  expect(
    !(await browser.has("cloud-status")) &&
      !(await browser.has("cloud-sleep")) &&
      !(await browser.has("cloud-delete")),
    "the workspace menu still has cloud items",
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
    await browser.evaluate<boolean>(
      "document.querySelector('.menu-popover:popover-open hr.menu-separator + [data-testid=\"cloud-delete\"]') !== null",
    ),
    "Delete is not under a separator",
  );
  await menuInsideWindow(browser, "running workspace");
  browser.scope = "";
  await browser.screenshot("cloud-header-running");
  browser.scope = ".menu-popover:popover-open";
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
  await browser.screenshot("cloud-header-sleeping");
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
  await browser.screenshot("cloud-header-delete-armed");
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
  await browser.waitFor(
    `!${cloudSummary("Cloud project")}`,
    "the cloud icon to go after the delete",
  );
  expect(
    await browser.evaluate<boolean>(
      "[...document.querySelectorAll('.session-card')].length > 0",
    ),
    "deleting the cloud workspace removed the local workspace's sessions",
  );
  await browser.screenshot("cloud-header-after-delete");
});

// Signed out: no cloud icon anywhere, and no cloud items in the menu.
await withBrowser(
  { port: 41766, page: "cloud-test.html", query: "signedIn=0" },
  async (browser) => {
    await browser.waitFor(
      "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
      "the workspace list",
    );
    await Bun.sleep(300);
    expect(
      !(await browser.evaluate<boolean>(
        "Boolean(document.querySelector('[data-testid=\"workspace-cloud-icon\"]'))",
      )),
      "a cloud icon shows while signed out",
    );
    await openSettings(browser, "Cloud project");
    expect(
      !(await browser.has("cloud-status")),
      "the menu offers cloud items while signed out",
    );
    await browser.screenshot("cloud-header-signed-out");
  },
);

console.log("cloud header check passed");

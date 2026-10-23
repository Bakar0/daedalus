/**
 * A workspace's Cloud section in its settings menu, in a real browser
 * against `cloud-test.tsx`: shown only while the workspace has a cloud copy,
 * with its status, when it was made, and Remove cloud copy (two clicks); no
 * Sleep or Wake anywhere, and no cloud icon on the workspace header. Nothing
 * while this Mac is signed out. The menu has to stay inside the window at
 * two heights.
 *
 *   bun run test:cloud-workspace-ui
 */
import {
  expect,
  openMenu,
  withBrowser,
  type Browser,
} from "./lib/browser-check";

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

const noSleepOrWake = async (browser: Browser) =>
  !(await browser.evaluate<boolean>(
    'Boolean(document.querySelector(\'[data-testid="cloud-sleep"], [data-testid="cloud-wake"], [data-testid="workspace-cloud-icon"]\'))',
  ));

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
  expect(
    await noSleepOrWake(browser),
    "a Sleep, Wake or header cloud icon shows",
  );

  // A local workspace: no Cloud section.
  await openSettings(browser, "Plain local");
  expect(
    !(await browser.has("cloud-status")) &&
      !(await browser.has("cloud-delete")),
    "a local workspace's settings show a Cloud section",
  );
  await closeMenus(browser);

  // A running cloud copy: status, when it was made, Remove, no Sleep.
  await openSettings(browser, "Cloud project");
  expect(
    (await browser.attribute("cloud-status", "data-status")) === "running" &&
      (await browser.text("cloud-made")).startsWith("Cloud copy made"),
    "the Cloud section does not show the status and when it was made",
  );
  expect(
    await noSleepOrWake(browser),
    "the Cloud section offers Sleep or Wake",
  );
  await menuInsideWindow(browser, "workspace settings");
  browser.scope = "";
  await browser.screenshot("cloud-workspace-settings");
  browser.scope = ".menu-popover:popover-open";

  // Remove asks twice. The first click arms it and sends nothing.
  const before = (await requestNames(browser)).length;
  await browser.click("cloud-delete");
  expect(
    (await requestNames(browser)).length === before &&
      (await browser.attribute("cloud-delete", "data-armed")) === "true",
    "one click on Remove already removed the cloud copy",
  );
  // A second click inside the double-click window is ignored on purpose.
  await Bun.sleep(700);
  await browser.click("cloud-delete");
  await browser.waitFor(
    "window.requests.some((one) => 'cloudWorkspaceDelete' in one)",
    "the remove call",
  );
  expect(
    (await lastRequest(browser)) ===
      '{"cloudWorkspaceDelete":{"workspace":"cloud-ws","force":true}}',
    `Remove sent ${await lastRequest(browser)}`,
  );
  await closeMenus(browser);
  await openSettings(browser, "Cloud project");
  await browser.waitFor(
    "!document.querySelector('.menu-popover:popover-open [data-testid=\"cloud-status\"]')",
    "the Cloud section to go after Remove",
  );
  await closeMenus(browser);

  // An asleep copy says so, and still offers no Wake.
  await openSettings(browser, "Sleepy project");
  expect(
    (await browser.attribute("cloud-status", "data-status")) === "sleeping" &&
      (await noSleepOrWake(browser)),
    "an asleep cloud copy does not read asleep, or offers Wake",
  );
});

// Signed out: no Cloud section anywhere.
await withBrowser(
  { port: 41766, page: "cloud-test.html", query: "signedIn=0" },
  async (browser) => {
    await browser.waitFor(
      "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
      "the workspace list",
    );
    await Bun.sleep(300);
    await openSettings(browser, "Cloud project");
    expect(
      !(await browser.has("cloud-status")),
      "the menu offers cloud items while signed out",
    );
  },
);

console.log("cloud workspace check passed");

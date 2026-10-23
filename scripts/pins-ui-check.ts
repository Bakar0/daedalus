/**
 * Pinned card actions in a real browser, against `cloud-test.tsx`. A
 * workspace's header always shows Settings and its +; terminal, secrets and
 * archive live in Settings with a pin each, and a pinned one shows on every
 * workspace's card, after a reload too. A session starts with rebirth, its
 * cloud action and archive pinned, and its menu unpins them.
 *
 *   bun run test:pins-ui
 */
import {
  expect,
  openMenu,
  withBrowser,
  type Browser,
} from "./lib/browser-check";

const open = async (browser: Browser, label: string) => {
  browser.scope = "";
  expect(
    await browser.evaluate<boolean>(openMenu(label)),
    `no menu "${label}"`,
  );
  await browser.waitFor(
    `document.querySelector('summary[aria-label="${label}"]').parentElement.querySelector('.menu-popover:popover-open')`,
    `the menu "${label}" to open`,
  );
  browser.scope = ".menu-popover:popover-open";
};

const close = (browser: Browser) => {
  browser.scope = "";
  return browser.evaluate(
    `document.querySelectorAll('details.menu[open]').forEach((one) => { one.open = false; })`,
  );
};

const exists = (browser: Browser, selector: string) =>
  browser.evaluate<boolean>(
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
  );

await withBrowser({ port: 41800, page: "cloud-test.html" }, async (browser) => {
  await browser.waitFor(
    "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
    "the workspace list",
  );
  await Bun.sleep(300);

  // Settings and + always show; the rest wait in Settings.
  const header = await browser.evaluate<{
    settings: string;
    plus: string;
  }>(`(() => {
    const card = document.querySelector('summary[aria-label="Settings of Plain local"]').closest('.workspace-card');
    const settings = card.querySelector('summary[aria-label="Settings of Plain local"]');
    const plus = card.querySelector('[aria-label="Create session in Plain local"]');
    return { settings: getComputedStyle(settings.parentElement).display, plus: getComputedStyle(plus).display };
  })()`);
  expect(
    header.settings !== "none" && header.plus !== "none",
    `Settings or + is hidden: ${JSON.stringify(header)}`,
  );
  expect(
    !(await exists(
      browser,
      '[aria-label="Open Plain local in integrated terminal"]',
    )) &&
      !(await exists(browser, '[aria-label="Secrets of Plain local"]')) &&
      !(await exists(browser, '[aria-label="Archive Plain local workspace"]')),
    "a workspace action is on the card before it is pinned",
  );

  await open(browser, "Settings of Plain local");
  expect(
    (await browser.has("menu-action-terminal")) &&
      (await browser.has("menu-action-secrets")) &&
      (await browser.has("menu-action-archive")) &&
      (await browser.attribute("pin-terminal", "aria-pressed")) === "false",
    "Settings does not list terminal, secrets and archive, unpinned",
  );
  await browser.screenshot("pins-workspace-menu");
  await browser.click("pin-terminal");
  expect(
    (await browser.attribute("pin-terminal", "aria-pressed")) === "true",
    "the terminal pin did not stick",
  );
  await close(browser);
  expect(
    (await exists(
      browser,
      '[aria-label="Open Plain local in integrated terminal"]',
    )) &&
      (await exists(
        browser,
        '[aria-label="Open Cloud project in integrated terminal"]',
      )),
    "a pinned action is not on every workspace's card",
  );

  // Pins are the user's: they outlast a reload.
  await browser.evaluate("location.reload()");
  await browser.waitFor(
    "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
    "the workspace list after a reload",
  );
  expect(
    await exists(
      browser,
      '[aria-label="Open Plain local in integrated terminal"]',
    ),
    "the pin was forgotten on reload",
  );

  // Sessions: rebirth, cloud and archive start pinned.
  await open(browser, "More actions for s-local");
  expect(
    (await browser.attribute("pin-rebirth", "aria-pressed")) === "true" &&
      (await browser.attribute("pin-cloud", "aria-pressed")) === "true" &&
      (await browser.attribute("pin-archive", "aria-pressed")) === "true",
    "a session's rebirth, cloud and archive should start pinned",
  );
  await browser.screenshot("pins-session-menu");
  await browser.click("pin-rebirth");
  await close(browser);
  expect(
    !(await exists(browser, '[aria-label="Rebirth s-local"]')) &&
      !(await exists(browser, '[aria-label="Rebirth s-cloud"]')) &&
      (await exists(browser, '[aria-label="Archive s-local session"]')),
    "unpinning rebirth did not take it off the cards, or took archive too",
  );
  await open(browser, "More actions for s-local");
  expect(
    await browser.has("menu-action-rebirth"),
    "an unpinned rebirth is gone from the menu too",
  );
  await close(browser);
});

console.log("pins check passed");

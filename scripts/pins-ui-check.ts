/**
 * Pinned card actions in a real browser, against `cloud-test.tsx`. A
 * workspace's header always shows Settings and its +; terminal, secrets and
 * archive live in Settings with a pin each, and a pinned one shows on every
 * workspace's card, after a reload too. A session starts with rebirth and
 * archive pinned, has no cloud action, and its menu unpins them.
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

  // Sessions: rebirth and archive start pinned; there is no cloud action.
  await open(browser, "More actions for s-local");
  expect(
    (await browser.attribute("pin-rebirth", "aria-pressed")) === "true" &&
      !(await browser.has("pin-cloud")) &&
      (await browser.attribute("pin-archive", "aria-pressed")) === "true",
    "a session's rebirth and archive should start pinned, with no cloud",
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

// Nothing on a header or a card waits for hover: with the pointer away,
// every action is there, and no name or count runs under them.
await withBrowser({ port: 41802, page: "cloud-test.html" }, async (browser) => {
  await browser.waitFor(
    "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
    "the workspace list",
  );
  await Bun.sleep(400);
  await browser.evaluate(
    `localStorage.setItem('daedalus.pins', JSON.stringify({ workspace: ['terminal', 'secrets', 'cloud', 'archive'], session: ['rebirth', 'archive'] })); location.reload()`,
  );
  await browser.waitFor(
    "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
    "the workspace list after the reload",
  );
  await Bun.sleep(600);
  await browser.evaluate(
    "document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900, clientY: 700 }))",
  );
  const seen = await browser.evaluate<{
    hidden: string[];
    under: string[];
  }>(`(() => {
    const hidden = [];
    const under = [];
    for (const card of document.querySelectorAll('.workspace-group > .workspace-card, .workspace-sessions .session-card')) {
      const actions = card.querySelector(':scope > .workspace-card-actions');
      if (!actions) continue;
      for (const one of actions.children) {
        const box = one.getBoundingClientRect();
        if (getComputedStyle(one).display === 'none' || box.width === 0 || getComputedStyle(one).opacity === '0')
          hidden.push(one.getAttribute('aria-label') ?? one.className);
      }
      const left = actions.getBoundingClientRect().left;
      for (const text of card.querySelectorAll('.workspace-card-name > span:first-child, .session-card-title > strong, .workspace-insight-copy')) {
        const box = text.getBoundingClientRect();
        const top = actions.getBoundingClientRect();
        if (box.width && box.right > left + 1 && box.top < top.bottom && box.bottom > top.top)
          under.push(text.textContent);
        // A name with no room is as bad as one under the actions.
        if (!text.matches('.workspace-insight-copy') && box.width < 40)
          under.push(\`\${text.textContent} (no room)\`);
      }
    }
    return { hidden, under };
  })()`);
  expect(
    !seen.hidden.length,
    `actions wait for hover: ${JSON.stringify(seen.hidden)}`,
  );
  expect(
    !seen.under.length,
    `text runs under the actions: ${JSON.stringify(seen.under)}`,
  );
  await browser.screenshot("pins-all-showing");
});

// A narrow sidebar: each workspace's name has its line up to the actions,
// the count sits on a second line in full, and a workspace out of focus
// keeps no empty row for its archived sessions.
await withBrowser(
  { port: 41804, page: "cloud-test.html", query: "archived=1" },
  async (browser) => {
    await browser.waitFor(
      "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
      "the workspace list",
    );
    await browser.evaluate(
      `localStorage.setItem('daedalus.panel.workspace-width', '200'); localStorage.setItem('daedalus.pins', JSON.stringify({ workspace: ['archive'], session: ['rebirth', 'archive'] })); location.reload()`,
    );
    await browser.waitFor(
      "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
      "the workspace list after the reload",
    );
    await Bun.sleep(600);
    // Focus on another workspace, so Plain local's archive is out of focus.
    await browser.evaluate(
      `document.querySelector('summary[aria-label="Settings of Cloud project"]').closest('.workspace-card').querySelector('.workspace-item').click()`,
    );
    await Bun.sleep(300);
    const seen = await browser.evaluate<{
      column: number;
      bad: string[];
      gap: number;
    }>(`(() => {
      const bad = [];
      for (const card of document.querySelectorAll('.workspace-group > .workspace-card')) {
        const name = card.querySelector('.workspace-card-name > span:first-child');
        const count = card.querySelector('.workspace-insight-copy');
        const actions = card.querySelector(':scope > .workspace-card-actions').getBoundingClientRect();
        const nameBox = name.getBoundingClientRect();
        const countBox = count.getBoundingClientRect();
        const label = name.textContent;
        if (countBox.top < nameBox.bottom - 1) bad.push(label + ': the count shares the name line');
        if (nameBox.right > actions.left + 1) bad.push(label + ': the name runs under the actions');
        // Cut short only at the actions: a cut name reaches them.
        if (name.scrollWidth > name.clientWidth + 1 && nameBox.right < actions.left - 30)
          bad.push(label + ': the name is cut short of the actions');
        if (count.scrollWidth > count.clientWidth + 1) bad.push(label + ': the count is cut');
      }
      const group = document.querySelector('summary[aria-label="Settings of Plain local"]').closest('.workspace-group');
      const cards = group.querySelectorAll('.workspace-sessions .session-card');
      const last = cards[cards.length - 1].getBoundingClientRect();
      return {
        column: Math.round(document.querySelector('.workspace-column').getBoundingClientRect().width),
        bad,
        gap: Math.round(group.getBoundingClientRect().bottom - last.bottom),
      };
    })()`);
    expect(seen.column <= 210, `the sidebar is ${seen.column}px, not narrow`);
    expect(!seen.bad.length, `narrow sidebar: ${JSON.stringify(seen.bad)}`);
    expect(
      seen.gap <= 10,
      `${seen.gap}px of empty space under Plain local's last session`,
    );
    await browser.screenshot("pins-narrow");
  },
);

console.log("pins check passed");

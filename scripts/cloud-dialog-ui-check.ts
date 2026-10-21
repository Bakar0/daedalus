/**
 * The new session dialog's Local/Cloud choice in a real browser, against
 * `cloud-test.tsx`. The choice shows only when the workspace has a cloud
 * workspace. Cloud hides what a pod cannot honour (Codex, accounts,
 * abilities, remembering a model) and offers Claude and a terminal. The
 * dialog must stay inside the window at two heights.
 *
 *   bun run test:cloud-dialog-ui
 */
import { expect, withBrowser, type Browser } from "./lib/browser-check";

const openDialog = async (browser: Browser, workspace: string) => {
  await browser.waitFor(
    `document.querySelector('[aria-label="Create session in ${workspace}"]')`,
    `the ${workspace} row`,
  );
  await browser.evaluate(
    `document.querySelector('[aria-label="Create session in ${workspace}"]').click()`,
  );
  await browser.waitFor(
    "document.querySelector('.modal input')",
    "the session dialog",
  );
  browser.scope = ".modal";
};

const closeDialog = async (browser: Browser) => {
  browser.scope = "";
  await browser.evaluate(
    `[...document.querySelectorAll('.modal button')].find((one) => one.textContent.trim() === 'Cancel').click()`,
  );
  await browser.waitFor(
    "!document.querySelector('.modal')",
    "the dialog to close",
  );
};

const present = (browser: Browser, selector: string) =>
  browser.evaluate<boolean>(
    `Boolean(document.querySelector('.modal ${selector}'))`,
  );

const ACCOUNT = '[aria-label="Claude account"]';
const ABILITIES = ".session-abilities";
const REMEMBER = ".session-model-remember";

const checked = (browser: Browser, id: string) =>
  browser.attribute(`session-location-${id}`, "aria-checked");

const fits = async (browser: Browser, label: string) => {
  for (const height of [820, 560]) {
    await browser.resize(height);
    const seen = await browser.evaluate<{
      top: number;
      bottom: number;
      viewport: number;
      scrolls: boolean;
    }>(`(() => {
      const modal = document.querySelector('.modal');
      const rect = modal.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        viewport: window.innerHeight,
        scrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      };
    })()`);
    expect(
      seen.top >= 0 && seen.bottom <= seen.viewport,
      `the dialog runs off the screen at ${height}px (${label}): ${seen.top}..${seen.bottom} of ${seen.viewport}`,
    );
    expect(!seen.scrolls, `the page scrolls at ${height}px (${label})`);
  }
  await browser.resize(820);
};

const chooseModel = async (browser: Browser, id: string) => {
  await browser.waitFor(
    `document.querySelector('.modal select[aria-label="Model"] option[value="${id}"]')`,
    `the ${id} model option`,
  );
  await browser.evaluate(`(() => {
    const select = document.querySelector('.modal select[aria-label="Model"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(id)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await Bun.sleep(80);
};

const submit = async (browser: Browser) => {
  // The name is required, so the form will not submit without one.
  await browser.evaluate(`(() => {
    const input = document.querySelector('.modal input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Check session');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await Bun.sleep(50);
  await browser.evaluate(
    `[...document.querySelectorAll('.modal button')].find((one) => one.textContent.trim() === 'Create session').click()`,
  );
  await browser.waitFor(
    "window.requests.some((one) => 'agentSpawn' in one)",
    "the spawn call",
  );
};

await withBrowser({ port: 41768, page: "cloud-test.html" }, async (browser) => {
  await Bun.sleep(400);

  // A workspace with no cloud workspace gets the dialog it always had.
  await openDialog(browser, "Plain local");
  expect(
    !(await browser.has("session-location")),
    "the Local/Cloud choice shows for a workspace with no cloud workspace",
  );
  expect(
    (await browser.has("session-tool-codex")) &&
      !(await browser.has("session-tool-terminal")) &&
      (await present(browser, ACCOUNT)) &&
      (await present(browser, ABILITIES)),
    "the local dialog lost Codex, the account or the abilities",
  );
  await browser.screenshot("cloud-dialog-local-only");
  await closeDialog(browser);

  // Its cloud twin: both choices, Local first, and Local keeps everything.
  await openDialog(browser, "Cloud project");
  expect(await browser.has("session-location"), "no Local/Cloud choice");
  expect(
    (await browser.attribute("session-location", "role")) === "radiogroup",
    "the choice is not a radiogroup",
  );
  expect(
    (await checked(browser, "local")) === "true" &&
      (await checked(browser, "cloud")) === "false",
    `Local should start chosen: local ${await checked(browser, "local")}, cloud ${await checked(browser, "cloud")}`,
  );
  expect(
    (await browser.has("session-tool-codex")) &&
      (await present(browser, ACCOUNT)) &&
      (await present(browser, ABILITIES)),
    "Local lost Codex, the account or the abilities",
  );
  await chooseModel(browser, "sonnet");
  expect(
    await present(browser, REMEMBER),
    "Local does not offer to remember the model",
  );
  await fits(browser, "local choice");
  await browser.screenshot("cloud-dialog-local");

  await browser.click("session-location-cloud");
  expect(
    (await checked(browser, "cloud")) === "true" &&
      (await checked(browser, "local")) === "false",
    "Cloud did not become the chosen place",
  );
  expect(
    !(await browser.has("session-tool-codex")),
    "Codex is offered for a cloud session",
  );
  expect(
    (await browser.has("session-tool-claude")) &&
      (await browser.has("session-tool-terminal")),
    "Cloud should offer Claude and Terminal",
  );
  expect(
    !(await present(browser, ACCOUNT)),
    "the account choice is offered for a cloud session",
  );
  expect(
    !(await present(browser, ABILITIES)),
    "abilities are offered for a cloud session",
  );
  expect(
    !(await present(browser, REMEMBER)),
    "'Remember for this workspace' is offered for a cloud session",
  );
  await fits(browser, "cloud choice");
  await browser.screenshot("cloud-dialog-cloud");

  // Back to Local: the terminal tool goes and Codex returns.
  await browser.click("session-location-local");
  expect(
    (await browser.has("session-tool-codex")) &&
      !(await browser.has("session-tool-terminal")),
    "Local did not bring Codex back and drop Terminal",
  );

  // Create a Claude session in the cloud.
  await browser.click("session-location-cloud");
  await submit(browser);
  const claude = (await browser.requests()).find((one) => "agentSpawn" in one)
    ?.agentSpawn as Record<string, unknown>;
  expect(
    claude.cloud === true &&
      claude.workspace === "cloud-ws" &&
      claude.provider === "claude",
    `a cloud Claude session sent ${JSON.stringify(claude)}`,
  );
  expect(
    !("account" in claude) && !("abilities" in claude),
    `a cloud session sent a local-only option: ${JSON.stringify(claude)}`,
  );
  await browser.waitFor(
    "!document.querySelector('.modal')",
    "the dialog to close after Create",
  );

  // And a terminal in the cloud.
  await openDialog(browser, "Cloud project");
  await browser.click("session-location-cloud");
  await browser.click("session-tool-terminal");
  await submit(browser);
  const terminal = (await browser.requests())
    .filter((one) => "agentSpawn" in one)
    .at(-1)?.agentSpawn as Record<string, unknown>;
  expect(
    terminal.cloud === true && terminal.terminal === true,
    `a cloud terminal sent ${JSON.stringify(terminal)}`,
  );
  await browser.waitFor(
    "!document.querySelector('.modal')",
    "the dialog to close after Create",
  );

  // A local session in a workspace that also has a cloud one stays local.
  await openDialog(browser, "Cloud project");
  await submit(browser);
  const local = (await browser.requests())
    .filter((one) => "agentSpawn" in one)
    .at(-1)?.agentSpawn as Record<string, unknown>;
  expect(
    !("cloud" in local),
    `a local session sent cloud: ${JSON.stringify(local)}`,
  );
  await browser.waitFor(
    "!document.querySelector('.modal')",
    "the dialog to close after Create",
  );

  // An asleep cloud workspace cannot take a new session.
  browser.scope = "";
  await openDialog(browser, "Sleepy project");
  expect(await browser.has("session-location"), "no choice for Sleepy project");
  expect(
    await browser.evaluate<boolean>(
      `document.querySelector('[data-testid="session-location-cloud"]').disabled`,
    ),
    "Cloud can be chosen while the workspace sleeps",
  );
  await browser.screenshot("cloud-dialog-sleeping");
  await closeDialog(browser);
});

// Signed out, the dialog is the local one even for a workspace that had a
// cloud workspace.
await withBrowser(
  { port: 41770, page: "cloud-test.html", query: "signedIn=0" },
  async (browser) => {
    await Bun.sleep(400);
    await openDialog(browser, "Cloud project");
    expect(
      !(await browser.has("session-location")),
      "the Local/Cloud choice shows while signed out",
    );
    await browser.screenshot("cloud-dialog-signed-out");
  },
);

console.log("cloud dialog check passed");

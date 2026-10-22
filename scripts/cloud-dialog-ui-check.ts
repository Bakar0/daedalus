/**
 * The new session dialog's Local/Cloud choice in a real browser, against
 * `cloud-test.tsx`. The choice shows only when the workspace has a cloud
 * workspace. Cloud hides what a pod cannot honour (Codex, accounts,
 * abilities, remembering a model, a terminal) and offers Claude only. The
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

  // Signed in, a workspace with no cloud workspace yet offers Cloud too: its
  // first cloud session makes one. Local starts chosen.
  await openDialog(browser, "Plain local");
  expect(
    (await browser.has("session-location")) &&
      (await checked(browser, "local")) === "true",
    "a signed-in Mac should offer Cloud for a workspace with no cloud workspace yet",
  );
  expect(
    (await browser.has("session-tool-codex")) &&
      !(await browser.has("session-tool-terminal")) &&
      (await present(browser, ACCOUNT)) &&
      (await present(browser, ABILITIES)),
    "the local dialog lost Codex, the account or the abilities",
  );
  await browser.screenshot("cloud-dialog-no-cloud-yet");
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
      !(await browser.has("session-tool-terminal")),
    "Cloud should offer Claude only, with no Terminal",
  );
  expect(
    (await present(browser, ACCOUNT)) &&
      !(await browser.has("session-cloud-account-note")),
    "Cloud should offer the Claude account, with no extra note",
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

  // Back to Local: Codex returns, and still no terminal tool.
  await browser.click("session-location-local");
  expect(
    (await browser.has("session-tool-codex")) &&
      !(await browser.has("session-tool-terminal")),
    "Local did not bring Codex back and drop Terminal",
  );

  // Create a Claude session in the cloud, on the Work account.
  await browser.click("session-location-cloud");
  await browser.evaluate(`(() => {
    const select = document.querySelector('.modal ${ACCOUNT}');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'work-1a2b');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await Bun.sleep(80);
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
    claude.account === "work-1a2b" && !("abilities" in claude),
    `a cloud session sent a local-only option: ${JSON.stringify(claude)}`,
  );
  await browser.waitFor(
    "!document.querySelector('.modal')",
    "the dialog to close after Create",
  );

  // The dialog remembers Cloud for this workspace; This Mac starts a local
  // session even though the workspace has a cloud one.
  await openDialog(browser, "Cloud project");
  expect(
    (await checked(browser, "cloud")) === "true",
    "the last choice, Cloud, was not remembered",
  );
  await browser.click("session-location-local");
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

  // An asleep cloud workspace can take a new session: it wakes for it.
  browser.scope = "";
  await openDialog(browser, "Sleepy project");
  expect(await browser.has("session-location"), "no choice for Sleepy project");
  expect(
    !(await browser.evaluate<boolean>(
      `document.querySelector('[data-testid="session-location-cloud"]').disabled`,
    )),
    "Cloud cannot be chosen while the workspace sleeps; it should wake for the session",
  );
  await browser.screenshot("cloud-dialog-sleeping");
  await closeDialog(browser);
});

// Signed out, the dialog runs on this Mac and offers 'Set up cloud', which
// signs in right in the dialog and then chooses Cloud.
await withBrowser(
  { port: 41770, page: "cloud-test.html", query: "signedIn=0" },
  async (browser) => {
    await Bun.sleep(400);
    await openDialog(browser, "Cloud project");
    expect(
      !(await browser.has("session-location")) &&
        (await browser.has("cloud-setup")),
      "signed out, the dialog should offer Set up cloud and no choice",
    );
    await browser.screenshot("cloud-dialog-signed-out");
    await browser.click("cloud-setup");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-setup-form\"]')",
      "the inline sign-in",
    );
    await browser.type("cloud-gateway-url", "http://127.0.0.1:8080");
    await browser.type("cloud-email", "dev@example.com");
    await fits(browser, "inline sign-in");
    await browser.screenshot("cloud-dialog-setup");
    await browser.click("cloud-sign-in");
    await browser.waitFor(
      'document.querySelector(\'[data-testid="session-location-cloud"][aria-checked="true"]\')',
      "Cloud chosen after the inline sign-in",
    );
    expect(
      Boolean(
        await browser.evaluate<boolean>(
          "Boolean(document.querySelector('.modal'))",
        ),
      ),
      "the inline sign-in left the dialog",
    );
    expect(
      (await browser.requests()).some(
        (one) =>
          JSON.stringify(one) ===
          '{"cloudSignIn":{"gatewayUrl":"http://127.0.0.1:8080","email":"dev@example.com"}}',
      ),
      "the inline sign-in sent the wrong call",
    );
    await browser.screenshot("cloud-dialog-after-setup");
  },
);

// The last choice in a workspace is the next dialog's.
await withBrowser({ port: 41772, page: "cloud-test.html" }, async (browser) => {
  await Bun.sleep(400);
  await openDialog(browser, "Cloud project");
  await browser.click("session-location-cloud");
  await closeDialog(browser);
  await openDialog(browser, "Cloud project");
  expect(
    (await checked(browser, "cloud")) === "true",
    "the dialog forgot Cloud for this workspace",
  );
  await browser.click("session-location-local");
  await closeDialog(browser);
  await openDialog(browser, "Plain local");
  expect(
    (await checked(browser, "local")) === "true",
    "another workspace took this one's choice",
  );
  await closeDialog(browser);
});

console.log("cloud dialog check passed");

/**
 * The new session dialog in a real browser, against `cloud-test.tsx`. It has
 * no Runs on choice and sends no cloud flag: the workspace's place decides.
 * In a cloud workspace it offers Claude only, in the pod, with abilities;
 * on this Mac it offers Codex too and remembers a model. Signed out, it has
 * no cloud sign-in of its own. The dialog must stay inside the window at
 * two heights.
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
  const before = (await browser.requests()).filter(
    (one) => "agentSpawn" in one,
  ).length;
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
    `window.requests.filter((one) => 'agentSpawn' in one).length > ${before}`,
    "the spawn call",
  );
};

const noRunsOn = async (browser: Browser) =>
  !(await browser.has("session-location")) &&
  !(await browser.has("cloud-setup")) &&
  !(await present(browser, ".session-runs-on"));

const lastSpawn = async (browser: Browser) =>
  (await browser.requests()).filter((one) => "agentSpawn" in one).at(-1)
    ?.agentSpawn as Record<string, unknown>;

await withBrowser({ port: 41768, page: "cloud-test.html" }, async (browser) => {
  await Bun.sleep(400);

  // On this Mac: Codex, the account, abilities and remembering a model.
  await openDialog(browser, "Plain local");
  expect(await noRunsOn(browser), "the local dialog shows Runs on");
  expect(
    (await browser.has("session-tool-codex")) &&
      !(await browser.has("session-tool-terminal")) &&
      (await present(browser, ACCOUNT)) &&
      (await present(browser, ABILITIES)),
    "the local dialog lost Codex, the account or the abilities",
  );
  await chooseModel(browser, "sonnet");
  expect(
    await present(browser, REMEMBER),
    "the local dialog does not offer to remember the model",
  );
  await fits(browser, "on this Mac");
  await browser.screenshot("cloud-dialog-local");
  await submit(browser);
  const local = await lastSpawn(browser);
  expect(
    !("cloud" in local) && local.workspace === "local-ws",
    `a session on this Mac sent ${JSON.stringify(local)}`,
  );
  await browser.waitFor(
    "!document.querySelector('.modal')",
    "the dialog to close after Create",
  );

  // In the cloud: Claude and Codex, in the pod, abilities kept, no
  // remembering.
  browser.scope = "";
  await openDialog(browser, "Cloud project");
  expect(await noRunsOn(browser), "the cloud dialog shows Runs on");
  expect(
    (await browser.has("session-tool-codex")) &&
      (await browser.has("session-tool-claude")) &&
      !(await browser.has("session-tool-terminal")),
    "a cloud workspace should offer Claude and Codex",
  );
  for (const tool of ["claude", "codex"])
    expect(
      (await browser.text(`session-tool-${tool}`)).includes("In the pod"),
      `the ${tool} tool reads "${await browser.text(`session-tool-${tool}`)}"`,
    );
  expect(
    await present(browser, ABILITIES),
    "a cloud workspace's session lost its abilities",
  );
  expect(
    !(await present(browser, REMEMBER)),
    "'Remember for this workspace' is offered in a cloud workspace",
  );
  await fits(browser, "in the cloud");
  await browser.screenshot("cloud-dialog-cloud");
  await submit(browser);
  const cloud = await lastSpawn(browser);
  expect(
    !("cloud" in cloud) &&
      cloud.workspace === "cloud-ws" &&
      cloud.provider === "claude",
    `a session in the cloud workspace sent ${JSON.stringify(cloud)}`,
  );
  await browser.waitFor(
    "!document.querySelector('.modal')",
    "the dialog to close after Create",
  );
});

// Signed out, the dialog has no cloud sign-in of its own.
await withBrowser(
  { port: 41770, page: "cloud-test.html", query: "signedIn=0" },
  async (browser) => {
    await Bun.sleep(400);
    await openDialog(browser, "Plain local");
    expect(await noRunsOn(browser), "signed out, the dialog offers the cloud");
    await closeDialog(browser);
  },
);

console.log("cloud dialog check passed");

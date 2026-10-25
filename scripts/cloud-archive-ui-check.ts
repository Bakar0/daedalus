/**
 * Archiving in a cloud workspace, in a real browser against `cloud-test.tsx`.
 * A session archives in place and asks nothing. A workspace in the cloud
 * comes home and is archived in one call, with no question. One too big to
 * come home is not archived, and the window says what is over its cap.
 *
 *   bun run test:cloud-archive-ui
 */
import { expect, withBrowser, type Browser } from "./lib/browser-check";

const archiveSession = async (browser: Browser, name: string) => {
  // Archive asks for a second click on the card, not too fast. Armed, its
  // label changes, so the button is held from the first click.
  await browser.evaluate(
    `(window.armed = document.querySelector('[aria-label="Archive ${name} session"]')).click()`,
  );
  await Bun.sleep(500);
  await browser.evaluate("window.armed.click()");
};

const archiveWorkspace = async (browser: Browser, name: string) => {
  await browser.evaluate(
    `document.querySelector('summary[aria-label="Settings of ${name}"]').click()`,
  );
  await browser.waitFor(
    "document.querySelector('.menu-popover:popover-open [data-testid=\"menu-action-archive\"]')",
    "the workspace's archive item",
  );
  await browser.evaluate(
    `(window.armed = document.querySelector('.menu-popover:popover-open [data-testid="menu-action-archive"]')).click()`,
  );
  await Bun.sleep(500);
  await browser.evaluate("window.armed.click()");
};

const calls = async (browser: Browser, name: string) =>
  (await browser.requests())
    .filter((one) => name in one)
    .map((one) => JSON.stringify(one[name]));

const noDialog = (browser: Browser) =>
  browser.evaluate<boolean>("!document.querySelector('.modal')");

// A session and then its workspace, in the cloud, with no question.
await withBrowser({ port: 41810, page: "cloud-test.html" }, async (browser) => {
  await Bun.sleep(400);
  await archiveSession(browser, "s-cloud");
  await browser.waitFor(
    "window.requests.some((one) => 'agentArchive' in one)",
    "the session archive",
  );
  await Bun.sleep(300);
  expect(
    JSON.stringify(await calls(browser, "agentArchive")) ===
      JSON.stringify(['{"id":"s-cloud","force":false}']) &&
      (await noDialog(browser)),
    `the session archive asked or sent ${JSON.stringify(await calls(browser, "agentArchive"))}`,
  );

  await archiveWorkspace(browser, "Cloud project");
  await browser.waitFor(
    "!document.querySelector('summary[aria-label=\"Settings of Cloud project\"]')",
    "the workspace to leave the list",
  );
  expect(
    JSON.stringify(await calls(browser, "workspaceArchive")) ===
      JSON.stringify(['{"reference":"cloud-ws"}']) && (await noDialog(browser)),
    `the workspace archive asked or sent ${JSON.stringify(await calls(browser, "workspaceArchive"))}`,
  );
});

// Too big to come home: not archived, and the window says what is over.
await withBrowser(
  { port: 41812, page: "cloud-test.html", query: "archive=big" },
  async (browser) => {
    await Bun.sleep(400);
    await archiveWorkspace(browser, "Cloud project");
    await browser.waitFor(
      "document.body.innerText.includes('repos/app')",
      "the too-big message",
    );
    const text = await browser.evaluate<string>("document.body.innerText");
    expect(
      text.includes("1.5 GB") && text.includes("1 GB"),
      "the too-big message does not give the size and the cap",
    );
    expect(
      await browser.evaluate<boolean>(
        "Boolean(document.querySelector('summary[aria-label=\"Settings of Cloud project\"]'))",
      ),
      "the workspace left the list though it was not archived",
    );
    await browser.screenshot("cloud-archive-too-big");
  },
);

console.log("cloud archive check passed");

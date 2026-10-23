/**
 * Archiving in a cloud workspace, in a real browser against `cloud-test.tsx`.
 * A session archives in place and asks nothing. A workspace in the cloud
 * comes home first: when files that steer agents changed there, the window
 * lists them as plain text and asks, then archives with them approved, and
 * a cancelled question archives nothing. One too big to come home is not
 * archived, and the window says what is over its cap.
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

const dialogButton = (label: string) =>
  `[...document.querySelectorAll('.modal button')].find((one) => one.textContent.trim() === ${JSON.stringify(label)})`;

const calls = async (browser: Browser, name: string) =>
  (await browser.requests())
    .filter((one) => name in one)
    .map((one) => JSON.stringify(one[name]));

// A session in the cloud archives in place, with no question.
await withBrowser(
  { port: 41810, page: "cloud-test.html", query: "archive=approval" },
  async (browser) => {
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
        !(await browser.evaluate<boolean>(
          "Boolean(document.querySelector('.modal'))",
        )),
      `the session archive asked or sent ${JSON.stringify(await calls(browser, "agentArchive"))}`,
    );

    // The workspace asks about the steering files; Cancel archives nothing.
    await archiveWorkspace(browser, "Cloud project");
    await browser.waitFor(dialogButton("Cancel"), "the approval question");
    const text = await browser.evaluate<string>(
      "document.querySelector('.modal').textContent",
    );
    expect(
      text.includes(".claude/settings.json") && text.includes("CLAUDE.md"),
      `the question reads "${text}"`,
    );
    await browser.screenshot("cloud-archive-approval");
    await browser.evaluate(`${dialogButton("Cancel")}.click()`);
    await Bun.sleep(300);
    expect(
      (await calls(browser, "workspaceArchive")).length === 1,
      "cancelling the question archived the workspace anyway",
    );

    await archiveWorkspace(browser, "Cloud project");
    await browser.waitFor(
      dialogButton("Archive with them"),
      "the approval question",
    );
    await browser.evaluate(`${dialogButton("Archive with them")}.click()`);
    await browser.waitFor(
      "window.requests.filter((one) => 'workspaceArchive' in one).length === 3",
      "the approved archive",
    );
    expect(
      (await calls(browser, "workspaceArchive"))[2] ===
        '{"reference":"cloud-ws","approved":[".claude/settings.json","CLAUDE.md"]}',
      `the approved archive sent ${(await calls(browser, "workspaceArchive"))[2]}`,
    );
  },
);

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

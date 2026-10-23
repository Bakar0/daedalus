/**
 * Archiving with a cloud copy, in a real browser against `cloud-test.tsx`.
 * A cloud session moves home before it is archived, and the host may ask
 * first: about files that steer agents (the window asks, then archives with
 * them approved), or about a pod it cannot reach (the window asks, then
 * archives without the cloud's changes). Cancelling archives nothing. A
 * workspace's archive asks the same, once, naming the session.
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

const dialogButton = (label: string) =>
  `[...document.querySelectorAll('.modal button')].find((one) => one.textContent.trim() === ${JSON.stringify(label)})`;

const answer = async (browser: Browser, label: string) => {
  await browser.waitFor(dialogButton(label), `the "${label}" question`);
  const text = await browser.evaluate<string>(
    "document.querySelector('.modal').textContent",
  );
  await browser.evaluate(`${dialogButton(label)}.click()`);
  return text;
};

const calls = async (browser: Browser, name: string) =>
  (await browser.requests())
    .filter((one) => name in one)
    .map((one) => JSON.stringify(one[name]));

// Files that steer agents changed in the cloud: ask, then archive with them.
await withBrowser(
  { port: 41810, page: "cloud-test.html", query: "archive=approval" },
  async (browser) => {
    await Bun.sleep(400);
    await archiveSession(browser, "s-cloud");
    const text = await answer(browser, "Archive with them");
    expect(
      text.includes("Bring these changes to this Mac?") &&
        text.includes(".claude/settings.json"),
      `the question reads "${text}"`,
    );
    await browser.waitFor(
      "window.requests.filter((one) => 'agentArchive' in one).length === 2",
      "the approved archive",
    );
    expect(
      (await calls(browser, "agentArchive"))[1] ===
        '{"id":"s-cloud","force":false,"approved":[".claude/settings.json"]}',
      `the approved archive sent ${(await calls(browser, "agentArchive"))[1]}`,
    );
  },
);

// The pod cannot be reached: ask, then archive without its changes; and a
// cancelled question archives nothing.
await withBrowser(
  { port: 41812, page: "cloud-test.html", query: "archive=unreachable" },
  async (browser) => {
    await Bun.sleep(400);
    await archiveSession(browser, "s-cloud");
    await browser.waitFor(dialogButton("Cancel"), "the unreachable question");
    await browser.screenshot("cloud-archive-unreachable");
    await browser.evaluate(`${dialogButton("Cancel")}.click()`);
    await Bun.sleep(300);
    expect(
      (await calls(browser, "agentArchive")).length === 1 &&
        (await browser.evaluate<boolean>(
          `Boolean(document.querySelector('[data-session-id="s-cloud"]'))`,
        )),
      "cancelling the question archived the session anyway",
    );

    await archiveSession(browser, "s-cloud");
    const text = await answer(browser, "Archive anyway");
    expect(
      text.includes("Archive without the cloud's changes?") &&
        text.includes("the pod did not answer"),
      `the question reads "${text}"`,
    );
    await browser.waitFor(
      "window.requests.filter((one) => 'agentArchive' in one).length === 3",
      "the archive without the cloud's changes",
    );
    expect(
      (await calls(browser, "agentArchive"))[2] ===
        '{"id":"s-cloud","force":false,"withoutCloudChanges":true}',
      `the archive sent ${(await calls(browser, "agentArchive"))[2]}`,
    );

    // A workspace asks once, naming its session.
    await browser.evaluate(
      `document.querySelector('summary[aria-label="Settings of Cloud project"]').click()`,
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
    const workspaceText = await answer(browser, "Archive anyway");
    expect(
      workspaceText.includes("s-cloud"),
      `the workspace question does not name the session: "${workspaceText}"`,
    );
    await browser.waitFor(
      "window.requests.filter((one) => 'workspaceArchive' in one).length === 2",
      "the workspace archive without the cloud's changes",
    );
    expect(
      (await calls(browser, "workspaceArchive"))[1] ===
        '{"reference":"cloud-ws","withoutCloudChanges":true}',
      `the workspace archive sent ${(await calls(browser, "workspaceArchive"))[1]}`,
    );
  },
);

console.log("cloud archive check passed");

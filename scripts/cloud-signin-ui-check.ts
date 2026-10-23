/**
 * The cloud sign-in bar and card chip in a real browser, against
 * `cloud-test.tsx`. A cloud session asked to open a sign-in page: the card
 * shows a chip, the session shows a bar naming the host only (the fixture's
 * offer carries no URL, and the window must not invent one), with Open and
 * Dismiss. Open calls `cloudSignInOpen` once; Dismiss calls
 * `cloudSignInDismiss`. Both clear the bar and the chip. The paste-code form
 * shows its own bar. The bar fits at two heights.
 *
 *   bun run test:cloud-signin-ui
 */
import { expect, withBrowser, type Browser } from "./lib/browser-check";

const openSession = async (browser: Browser, id: string) => {
  await browser.waitFor(
    `document.querySelector('[data-session-id="${id}"]')`,
    `the ${id} card`,
  );
  await browser.evaluate(
    `document.querySelector('[data-session-id="${id}"]').click()`,
  );
  await Bun.sleep(300);
};

/**
 * Waits until an element has been there for a second straight: opening a
 * session redraws its view once while it settles, and an assertion made in
 * between reads the wrong frame.
 */
const steady = async (browser: Browser, testId: string) => {
  let seen = 0;
  for (let tries = 0; tries < 50 && seen < 5; tries++) {
    seen = (await browser.has(testId)) ? seen + 1 : 0;
    await Bun.sleep(200);
  }
  expect(seen >= 5, `${testId} never held still`);
};

const fits = async (browser: Browser, testId: string) => {
  for (const height of [820, 560]) {
    await browser.resize(height);
    const seen = await browser.evaluate<{
      left: number;
      right: number;
      top: number;
      bottom: number;
      width: number;
      height: number;
      buttonsInside: boolean;
      pageScrolls: boolean;
    }>(`(() => {
      const bar = document.querySelector('[data-testid="${testId}"]');
      const box = bar.getBoundingClientRect();
      const buttons = [...bar.querySelectorAll('button')].map((one) => one.getBoundingClientRect());
      return {
        left: Math.round(box.left),
        right: Math.round(box.right),
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        width: window.innerWidth,
        height: window.innerHeight,
        buttonsInside: buttons.every((one) => one.left >= box.left - 1 && one.right <= box.right + 1 && one.top >= box.top - 1 && one.bottom <= box.bottom + 1),
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      };
    })()`);
    expect(
      seen.left >= 0 &&
        seen.right <= seen.width &&
        seen.top >= 0 &&
        seen.bottom <= seen.height,
      `${testId} runs off the window at ${height}px: ${JSON.stringify(seen)}`,
    );
    expect(seen.buttonsInside, `${testId} buttons spill out at ${height}px`);
    expect(!seen.pageScrolls, `the page scrolls at ${height}px`);
  }
  await browser.resize(820);
};

const calls = async (browser: Browser, name: string) =>
  (await browser.requests()).filter((one) => name in one);

// Claude's page: chip, then bar, then Open.
await withBrowser(
  { port: 41782, page: "cloud-test.html", query: "signin=claude" },
  async (browser) => {
    await browser.waitFor(
      "document.querySelector('[data-testid=\"session-cloud-signin\"]')",
      "the sign-in chip on the card",
    );
    expect(
      await browser.evaluate<boolean>(
        `Boolean(document.querySelector('[data-session-id="s-cloud"]').closest('.session-card').querySelector('[data-testid="session-cloud-signin"]'))`,
      ),
      "the chip is not on the session that asked",
    );
    expect(
      (await browser.evaluate<number>(
        "document.querySelectorAll('[data-testid=\"session-cloud-signin\"]').length",
      )) === 1,
      "another session shows a sign-in chip",
    );
    expect(
      !(await browser.has("cloud-signin-bar")),
      "the bar shows before the session is open",
    );
    await browser.screenshot("cloud-signin-chip");

    await openSession(browser, "s-cloud");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-signin-bar\"]')",
      "the sign-in bar",
    );
    await steady(browser, "cloud-signin-bar");
    expect(
      (await browser.attribute("cloud-signin-bar", "data-kind")) === "claude",
      "the bar is not marked as a Claude sign-in",
    );
    expect(
      (await browser.text("cloud-signin-host")) === "claude.com",
      `the bar names "${await browser.text("cloud-signin-host")}"`,
    );
    const text = await browser.text("cloud-signin-bar");
    expect(
      !/https?:\/\//.test(text) &&
        !text.includes("state=") &&
        !text.includes("oauth"),
      `the bar shows a URL or its parts: "${text}"`,
    );
    const html = await browser.evaluate<string>(
      "document.documentElement.outerHTML",
    );
    expect(
      !/https?:\/\/(?:claude\.com|[^"' ]*awsapps)/.test(html) &&
        !html.includes("dtok-SECRET") &&
        !html.includes("rkey-SECRET"),
      "the DOM holds a sign-in URL or a secret",
    );
    expect(
      (await browser.has("cloud-signin-open")) &&
        (await browser.has("cloud-signin-dismiss")),
      "the bar lacks Open or Dismiss",
    );
    expect(
      !(await calls(browser, "cloudSignInOpen")).length,
      "showing the bar already opened the page",
    );
    await fits(browser, "cloud-signin-bar");
    await browser.screenshot("cloud-signin-bar");

    await browser.click("cloud-signin-open");
    await browser.waitFor(
      "window.requests.some((one) => 'cloudSignInOpen' in one)",
      "the open call",
    );
    expect(
      JSON.stringify(await calls(browser, "cloudSignInOpen")) ===
        '[{"cloudSignInOpen":{"requestId":"req-1"}}]',
      `Open sent ${JSON.stringify(await calls(browser, "cloudSignInOpen"))}`,
    );
    await browser.waitFor(
      "!document.querySelector('[data-testid=\"cloud-signin-bar\"]')",
      "the bar to go after Open",
    );
    expect(
      !(await browser.has("session-cloud-signin")) &&
        !(await browser.has("cloud-signin-paste")),
      "the chip stays after Open, or the paste bar shows for a page that needs none",
    );
  },
);

// Dismiss.
await withBrowser(
  { port: 41784, page: "cloud-test.html", query: "signin=aws" },
  async (browser) => {
    await openSession(browser, "s-cloud");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-signin-bar\"]')",
      "the sign-in bar",
    );
    await steady(browser, "cloud-signin-bar");
    expect(
      (await browser.attribute("cloud-signin-bar", "data-kind")) === "aws" &&
        (await browser.text("cloud-signin-host")) ===
          "d-9a672d87aa.awsapps.com",
      "the AWS bar names the wrong kind or host",
    );
    await fits(browser, "cloud-signin-bar");
    await browser.screenshot("cloud-signin-aws");
    await browser.click("cloud-signin-dismiss");
    await browser.waitFor(
      "!document.querySelector('[data-testid=\"cloud-signin-bar\"]')",
      "the bar to go after Dismiss",
    );
    expect(
      JSON.stringify(await calls(browser, "cloudSignInDismiss")) ===
        '[{"cloudSignInDismiss":{"sessionId":"s-cloud"}}]' &&
        !(await calls(browser, "cloudSignInOpen")).length,
      "Dismiss sent the wrong calls",
    );
    expect(
      !(await browser.has("session-cloud-signin")),
      "the chip stays after Dismiss",
    );
  },
);

// A page that opened in its paste-code form leaves a bar to finish.
await withBrowser(
  { port: 41786, page: "cloud-test.html", query: "signin=claude&paste=1" },
  async (browser) => {
    await openSession(browser, "s-cloud");
    await browser.click("cloud-signin-open");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-signin-paste\"]')",
      "the paste-code bar",
    );
    await steady(browser, "cloud-signin-paste");
    expect(
      (await browser.text("cloud-signin-paste")).includes("claude.com") &&
        !(await browser.has("cloud-signin-bar")),
      "the paste bar does not name the host, or the offer bar remains",
    );
    await fits(browser, "cloud-signin-paste");
    await browser.screenshot("cloud-signin-paste");
  },
);

console.log("cloud sign-in check passed");

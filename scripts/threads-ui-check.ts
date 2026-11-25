/**
 * The Threads page in a real browser against `threads-test.tsx`: every
 * agent's threads are rows of one list, the one that stops an agent first;
 * resolved threads sit in a section that starts collapsed; a row asks the
 * app to open its thread; Snooze puts one off and Reopen brings a resolved
 * one back. Screenshots land in artifacts/threads-*.png.
 *
 *   bun run test:threads-ui
 */
import { expect, withBrowser, type Browser } from "./lib/browser-check";

const clickText = (browser: Browser, selector: string, label: string) =>
  browser.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.includes(${JSON.stringify(label)})).click()`,
  );

await withBrowser(
  { port: 41834, page: "threads-test.html", width: 1100, height: 700 },
  async (browser) => {
    await browser.waitFor(
      "document.querySelectorAll('.threads-row').length >= 3 && document.querySelector('.threads-group-toggle')?.getAttribute('aria-expanded') === 'false'",
      "open threads as rows, and resolved collapsed",
    );
    const first = await browser.evaluate<string>(
      "document.querySelector('.threads-row').innerText",
    );
    expect(
      first.includes("dead-lettered") && first.includes("Blocking agent"),
      `the blocking thread is not first: ${first}`,
    );
    expect(
      (await browser.evaluate<number>(
        "document.querySelectorAll('.threads-card, textarea').length",
      )) === 0,
      "the page still answers in place",
    );
    await browser.screenshot("threads-home");
    await browser.evaluate(
      "document.querySelector('.threads-row .threads-row-main').click()",
    );
    await browser.waitFor(
      "window.requests.some((one) => one.openThread === 12)",
      "the row asked for thread #12",
    );
    await clickText(browser, ".threads-row .threads-quiet", "Snooze");
    await clickText(browser, ".threads-snooze-menu button", "1 hour");
    await browser.waitFor(
      "window.requests.some((one) => one.threadSnooze?.id === 12 && one.threadSnooze.until)",
      "#12 snoozed",
    );
    await clickText(browser, ".threads-group-toggle", "Resolved");
    await clickText(browser, ".threads-row.ended .threads-quiet", "Reopen");
    await browser.waitFor(
      "window.requests.some((one) => one.threadReopen?.id === 11)",
      "#11 reopened",
    );
  },
);

console.log("threads check passed");

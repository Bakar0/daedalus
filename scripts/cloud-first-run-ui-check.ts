/**
 * The first-run sign-in note in a real browser, against `cloud-test.tsx`.
 * Claude in a new pod is not signed in, so a live cloud Claude session shows
 * a note above its terminal. It does not show for a local session or a
 * cloud shell, it goes away with "Got it", and it stays away for that cloud
 * workspace after a reload. The terminal below it keeps usable room at two
 * heights.
 *
 *   bun run test:cloud-first-run-ui
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

const noteLayout = (browser: Browser) =>
  browser.evaluate<{
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
    terminalHeight: number;
    pageScrolls: boolean;
  }>(`(() => {
    const note = document.querySelector('[data-testid="cloud-first-run-note"]').getBoundingClientRect();
    const terminal = document.querySelector('.terminal-host, .terminal, [class*="terminal"] canvas, .xterm');
    return {
      left: Math.round(note.left),
      right: Math.round(note.right),
      top: Math.round(note.top),
      bottom: Math.round(note.bottom),
      width: window.innerWidth,
      height: window.innerHeight,
      terminalHeight: terminal ? Math.round(terminal.getBoundingClientRect().height) : -1,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
    };
  })()`);

await withBrowser(
  { port: 41780, page: "cloud-test.html", query: "extra=terminal" },
  async (browser) => {
    await browser.waitFor(
      "document.querySelectorAll('.session-card').length === 5",
      "the session cards",
    );
    await Bun.sleep(400);

    // Not for a local Claude session, and not for a cloud shell.
    await openSession(browser, "s-local");
    expect(
      !(await browser.has("cloud-first-run-note")),
      "the note shows for a local session",
    );
    await openSession(browser, "s-shell");
    expect(
      !(await browser.has("cloud-first-run-note")),
      "the note shows for a cloud shell",
    );

    // For the live cloud Claude session.
    await openSession(browser, "s-cloud");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-first-run-note\"]')",
      "the first-run note",
    );
    const text = await browser.text("cloud-first-run-note");
    expect(
      /sign in to claude/i.test(text) && text.includes("/login"),
      `the note reads "${text}"`,
    );
    expect(
      (await browser.has("cloud-first-run-dismiss")) &&
        !text.includes("dtok-SECRET") &&
        !text.includes("rkey-SECRET"),
      "the note has no way to dismiss it, or shows a secret",
    );
    for (const height of [820, 560]) {
      await browser.resize(height);
      const seen = await noteLayout(browser);
      expect(
        seen.left >= 0 &&
          seen.right <= seen.width &&
          seen.top >= 0 &&
          seen.bottom <= seen.height,
        `the note runs off the window at ${height}px: ${JSON.stringify(seen)}`,
      );
      expect(!seen.pageScrolls, `the page scrolls at ${height}px`);
      expect(
        seen.terminalHeight >= 120,
        `the note leaves the terminal ${seen.terminalHeight}px at ${height}px`,
      );
    }
    await browser.resize(820);
    await browser.screenshot("cloud-first-run-note");

    // Dismissed once, for this cloud workspace.
    await browser.click("cloud-first-run-dismiss");
    expect(
      !(await browser.has("cloud-first-run-note")),
      "the note stays after Got it",
    );
    expect(
      (await browser.evaluate<string | null>(
        "window.localStorage.getItem('daedalus.cloud.firstRunSeen.ws:c-run')",
      )) === "1",
      "dismissing did not remember the cloud workspace",
    );
    await openSession(browser, "s-local");
    await openSession(browser, "s-cloud");
    expect(
      !(await browser.has("cloud-first-run-note")),
      "the note came back after opening another session and returning",
    );
    await browser.screenshot("cloud-first-run-dismissed");

    // And after a reload, since the choice lives in localStorage.
    await browser.evaluate("window.location.reload()");
    await Bun.sleep(600);
    await browser.waitFor(
      "document.querySelector('[data-session-id=\"s-cloud\"]')",
      "the cards after reload",
    );
    await openSession(browser, "s-cloud");
    expect(
      !(await browser.has("cloud-first-run-note")),
      "the note came back after a reload",
    );
  },
);

console.log("cloud first-run check passed");

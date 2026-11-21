/**
 * The Threads feed in a real browser against `threads-test.tsx`: open
 * threads are cards, blocking first, replied to in place with the picker or
 * typed words (shift+enter is a new line), and stay open with the reply in
 * them; resolved threads fold to rows; the quoted message opens main's
 * messages at the thread's message; ctrl+f forks a thread in place; a
 * conversation is searched and a thread opened on a match; Resolve ends a
 * thread and Reopen brings it back. Screenshots land in artifacts/threads-*.png.
 *
 *   bun run test:threads-ui
 */
import { expect, withBrowser, type Browser } from "./lib/browser-check";

const clickText = (browser: Browser, selector: string, label: string) =>
  browser.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.includes(${JSON.stringify(label)})).click()`,
  );
const key = (browser: Browser, selector: string, name: string, shift = false) =>
  browser.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, shiftKey: ${shift}, bubbles: true }))`,
  );
const type = (browser: Browser, selector: string, value: string) =>
  browser.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
/** Opens the Resolved section, which starts collapsed. */
const openResolved = async (browser: Browser) => {
  if (
    (await browser.evaluate<string | null>(
      "document.querySelector('.threads-group-toggle')?.getAttribute('aria-expanded') ?? null",
    )) === "false"
  )
    await clickText(browser, ".threads-group-toggle", "Resolved");
};
const answers = async (browser: Browser) =>
  (await browser.requests()).filter((one) => "threadSay" in one);

await withBrowser(
  { port: 41830, page: "threads-test.html", width: 900, height: 760 },
  async (browser) => {
    // Resolved threads start collapsed, under their section's header.
    await browser.waitFor(
      "document.querySelectorAll('.threads-card').length === 3 && document.querySelectorAll('.threads-row').length === 0 && document.querySelector('.threads-group-toggle')?.getAttribute('aria-expanded') === 'false'",
      "three open cards, one a member's, and resolved collapsed",
    );
    await browser.screenshot("threads-resolved-collapsed");
    // A URL in a thread opens in the browser; a team handle opens its
    // session; a handle that names no session stays text.
    const linked = await browser.evaluate<string[]>(
      "[...document.querySelectorAll('#thread-card-13 .threads-text-link')].map((link) => link.textContent)",
    );
    expect(
      JSON.stringify(linked) ===
        JSON.stringify(["https://example.com/runbook", "@tests"]),
      `#13 links ${JSON.stringify(linked)}`,
    );
    await clickText(browser, "#thread-card-13 .threads-text-link", "https://");
    await clickText(browser, "#thread-card-13 .threads-text-link", "@tests");
    await browser.waitFor(
      "window.requests.some((one) => one.openUrl === 'https://example.com/runbook') && window.requests.some((one) => one.openSession === 's-tests')",
      "the URL opened and @tests' session shown",
    );
    // A narrow panel never scrolls sideways: the header's names shrink, the
    // lead's line sits under the title, and the buttons stay on one line.
    const overflow = await browser.evaluate<string[]>(`(() => {
      const panel = document.querySelector('.side-panel-activity');
      panel.style.width = '260px';
      const wide = [panel, document.querySelector('.threads-head'), ...document.querySelectorAll('.threads-card-head')]
        .filter((el) => el.scrollWidth > el.clientWidth)
        .map((el) => el.className + ' ' + el.scrollWidth + '>' + el.clientWidth);
      const buttons = [...document.querySelectorAll('.threads-head > button')]
        .filter((button) => button.getClientRects().length > 1 || button.offsetHeight > 24)
        .map((button) => 'wrapped: ' + button.textContent);
      return [...wide, ...buttons];
    })()`);
    await browser.screenshot("threads-narrow");
    await browser.evaluate(
      "document.querySelector('.side-panel-activity').style.width = '380px'",
    );
    expect(
      overflow.length === 0,
      `the narrow pane overflows: ${JSON.stringify(overflow)}`,
    );
    await clickText(browser, ".threads-group-toggle", "Resolved");
    await browser.waitFor(
      "document.querySelectorAll('.threads-row').length === 1",
      "the resolved row, once the section opens",
    );
    const cards = await browser.evaluate<string[]>(
      "[...document.querySelectorAll('.threads-card')].map((card) => card.id)",
    );
    expect(
      cards[0] === "thread-card-12" && cards.length === 3,
      `the blocking card is not first: ${JSON.stringify(cards)}`,
    );
    expect(
      (
        await browser.evaluate<string>(
          "document.querySelector('#thread-card-14 .threads-card-head').textContent",
        )
      ).includes("testsmember"),
      "the member's card does not say whose it is",
    );
    expect(
      (
        await browser.evaluate<string>(
          "document.querySelector('#thread-card-12 .threads-option.on').textContent",
        )
      ).includes("3 tries"),
      "the picker does not start on the first option",
    );
    await browser.screenshot("threads-feed");

    // The quoted message opens main's messages with the thread's message in focus.
    await browser.evaluate(
      "document.querySelector('#thread-card-12 .threads-quote-go').click()",
    );
    await browser.waitFor(
      "document.querySelector('.threads-message.focus')",
      "the focused message in main",
    );
    expect(
      (
        await browser.evaluate<string>(
          "document.querySelector('.threads-message.focus').textContent",
        )
      ).includes("How many delivery tries should a webhook get"),
      "show focused the wrong message",
    );
    await browser.screenshot("threads-show");
    expect(
      (await browser.requests()).some(
        (one) =>
          JSON.stringify(one.sessionMessages) ===
          JSON.stringify({ sessionId: "s-lead" }),
      ),
      "show did not read the lead's conversation",
    );
    await clickText(browser, ".threads-back", "Threads");
    // A member's quote opens the member's conversation, not the lead's.
    await browser.evaluate(
      "document.querySelector('#thread-card-14 .threads-quote-go').click()",
    );
    await browser.waitFor(
      "window.requests.some((one) => one.sessionMessages?.sessionId === 's-tests')",
      "the member's conversation",
    );
    expect(
      (await browser.evaluate<string>(
        "document.querySelector('.threads-head h2').textContent",
      )) === "tests's conversation",
      "the conversation does not name the member",
    );
    await clickText(browser, ".threads-back", "Threads");

    // A number on the card picks and sends; the reply shows in the card,
    // which stays open, now with the agent.
    await browser.waitFor(
      "document.querySelector('#thread-card-12')",
      "the feed again",
    );
    // A number or a click only picks an option; Enter sends it.
    await key(browser, "#thread-card-12", "2");
    await browser.evaluate(
      "document.querySelectorAll('#thread-card-12 .threads-option')[0].click()",
    );
    expect(
      !(await browser.evaluate<boolean>(
        "window.requests.some((one) => 'threadSay' in one)",
      )),
      "picking an option sent it before Enter",
    );
    expect(
      (
        await browser.evaluate<string>(
          "document.querySelector('#thread-card-12 .threads-option.on').textContent",
        )
      ).includes("3 tries"),
      "a click did not pick the option",
    );
    await key(browser, "#thread-card-12", "Enter");
    await browser.waitFor(
      "window.requests.some((one) => 'threadSay' in one)",
      "the reply",
    );
    const [first] = await answers(browser);
    expect(
      JSON.stringify(first!.threadSay) ===
        JSON.stringify({ id: 12, body: null, option: 0 }),
      `the picker sent ${JSON.stringify(first)}`,
    );
    await browser.waitFor(
      "document.querySelector('#thread-card-12.replied')?.innerText.includes('> 3 tries')",
      "#12 with the reply, waiting on the agent",
    );
    await browser.screenshot("threads-answered");
    await openResolved(browser);
    await browser.waitFor(
      "document.querySelectorAll('.threads-row').length === 1",
      "the resolved row",
    );
    // A resolved row opens in place, with its whole conversation.
    await clickText(browser, ".threads-row-main", "Branch name");
    await browser.waitFor(
      "document.querySelector('#thread-card-11')?.innerText.includes('resolved by')",
      "the resolved card, open in place",
    );
    await clickText(browser, "#thread-card-11 .threads-quiet", "Fold");
    await browser.waitFor(
      "!document.querySelector('#thread-card-11')",
      "#11 folded again",
    );

    // ctrl+f on a thread forks that thread: no second thread.
    await clickText(browser, "#thread-card-13 .threads-foot-link", "fork");
    await browser.waitFor(
      "document.querySelector('.threads-fork-terminal .fake-terminal')",
      "the fork's terminal",
    );
    const opened = (await browser.requests()).find(
      (one) => "threadOpenFork" in one,
    )!;
    expect(
      JSON.stringify(opened.threadOpenFork) ===
        JSON.stringify({ sessionId: "s-lead", anchorId: "a-4", threadId: 13 }),
      `the fork opened on ${JSON.stringify(opened)}`,
    );
    expect(
      (await browser.evaluate<string>("document.body.innerText")).includes(
        "Which Slack channel",
      ),
      "the fork does not show the question it works on",
    );
    await clickText(browser, ".threads-send-bar", "Reply with");
    await browser.waitFor(
      "document.querySelector('#threads-draft')?.value.includes('Keep custom backoff')",
      "the draft, filled from the fork's last reply",
    );
    await browser.screenshot("threads-fork-draft");
    await browser.evaluate(
      "document.querySelector('.threads-draft .threads-back').click()",
    );
    await browser.evaluate("document.querySelector('.threads-back').click()");
    await browser.waitFor(
      "document.querySelector('#thread-card-13 .threads-fork-line')",
      "#13's card, with its fork",
    );
    expect(
      (await browser.evaluate<number>(
        "document.querySelectorAll('.threads-card').length",
      )) === 3,
      "forking a thread added a thread",
    );
    await browser.screenshot("threads-question-forked");

    // Shift+enter is a new line; enter sends what was typed.
    await type(
      browser,
      "#thread-card-13 .threads-prompt textarea",
      "#webhook-alerts",
    );
    await key(
      browser,
      "#thread-card-13 .threads-prompt textarea",
      "Enter",
      true,
    );
    expect((await answers(browser)).length === 1, "shift+enter sent the reply");
    await key(browser, "#thread-card-13 .threads-prompt textarea", "Enter");
    await browser.waitFor(
      "window.requests.filter((one) => 'threadSay' in one).length === 2",
      "the typed reply",
    );
    const typed = (await answers(browser))[1]!;
    expect(
      JSON.stringify(typed.threadSay) ===
        JSON.stringify({ id: 13, body: "#webhook-alerts", option: null }),
      `the typed reply sent ${JSON.stringify(typed)}`,
    );

    // The prompt grows with each line and shrinks back once it is sent.
    const prompt = "#thread-card-13 .threads-prompt textarea";
    const height = () =>
      browser.evaluate<number>(
        `document.querySelector(${JSON.stringify(prompt)}).offsetHeight`,
      );
    const oneLine = await height();
    await type(browser, prompt, "first line\nsecond line\nthird line");
    const threeLines = await height();
    expect(
      threeLines > oneLine,
      `the prompt grew with its lines (${oneLine}px -> ${threeLines}px)`,
    );
    await key(browser, prompt, "Enter");
    await browser.waitFor(
      "window.requests.filter((one) => 'threadSay' in one).length === 3",
      "the three-line reply",
    );
    await browser.waitFor(
      `document.querySelector(${JSON.stringify(prompt)}).value === '' && document.querySelector(${JSON.stringify(prompt)}).offsetHeight === ${oneLine}`,
      `the prompt back to one line after sending (it is ${await height()}px)`,
    );

    // Resolve ends a thread.
    await clickText(browser, "#thread-card-14 .threads-quiet", "Resolve");
    await browser.waitFor(
      "window.requests.some((one) => one.threadResolve?.id === 14)",
      "#14 resolved",
    );
    // A resolved thread reopens from its row.
    await openResolved(browser);
    await browser.waitFor(
      "[...document.querySelectorAll('.threads-row')].some((row) => row.textContent.includes('flaky-delivery'))",
      "#14's resolved row",
    );
    await browser.evaluate(
      `[...document.querySelectorAll('.threads-row')].find((row) => row.textContent.includes('flaky-delivery')).querySelector('.threads-quiet').click()`,
    );
    await browser.waitFor(
      "window.requests.some((one) => one.threadReopen?.id === 14) && document.querySelector('#thread-card-14')",
      "#14 open again, as a card",
    );

    // New thread: search the conversation, then open a thread on the match.
    await clickText(browser, ".threads-link", "New thread");
    await browser.waitFor(
      "document.querySelector('.threads-message .markdown-body')",
      "main's messages, as markdown",
    );
    await type(browser, ".threads-search input", "dead-letter");
    await browser.waitFor(
      "document.querySelector('.threads-search-count')?.textContent === '1 of 3'",
      "three matches, the latest current",
    );
    await browser.screenshot("threads-search");
    await browser.evaluate(
      "document.querySelector('.threads-message.current .threads-open-fork').click()",
    );
    await browser.waitFor(
      "document.querySelector('.threads-fork-terminal .fake-terminal')",
      "the new thread's fork",
    );
    const fromMessage = (await browser.requests()).filter(
      (one) => "threadOpenFork" in one,
    )[1]!;
    expect(
      JSON.stringify(fromMessage.threadOpenFork) ===
        JSON.stringify({ sessionId: "s-lead", anchorId: "a-5" }),
      `the thread opened on ${JSON.stringify(fromMessage)}`,
    );
    await clickText(browser, ".threads-send-bar", "Send to main");
    await browser.waitFor(
      "document.querySelector('#threads-draft')",
      "the draft",
    );
    await clickText(
      browser,
      ".threads-draft .threads-action",
      "Send to main agent",
    );
    await browser.waitFor(
      "document.querySelector('.threads-sent')",
      "the sent line",
    );
    await browser.screenshot("threads-fork");
    await browser.evaluate("document.querySelector('.threads-back').click()");
    // The thread is a card in the feed, with what was sent in it.
    await browser.waitFor(
      "document.querySelector('#thread-card-20 .threads-fork-line') && document.querySelector('#thread-card-20').innerText.includes('Keep custom backoff')",
      "the new thread's card",
    );
    await browser.screenshot("threads-feed-fork");
    await clickText(browser, "#thread-card-20 .threads-quiet", "Resolve");
    await browser.waitFor(
      "window.requests.some((one) => one.threadResolve?.id === 20)",
      "the thread resolved",
    );
  },
);

// Home: every session's open threads as cards; reply, snooze and show in
// place; "show in main" asks for main beside the session at that message.
await withBrowser(
  {
    port: 41834,
    page: "threads-test.html",
    query: "home=1",
    width: 1100,
    height: 700,
  },
  async (browser) => {
    await browser.waitFor(
      "document.querySelectorAll('.threads-home .threads-card').length === 3",
      "three cards at Home",
    );
    // One chip per workspace with threads, each with what waits on you.
    const chips = await browser.evaluate<string[]>(
      "[...document.querySelectorAll('.threads-filter-chip')].map((chip) => chip.textContent)",
    );
    expect(
      JSON.stringify(chips) === JSON.stringify(["All3", "Daedalus2", "Docs1"]),
      `the workspace chips are ${JSON.stringify(chips)}`,
    );
    await browser.screenshot("threads-home");
    await clickText(browser, ".threads-filter-chip", "Docs");
    await browser.waitFor(
      "[...document.querySelectorAll('.threads-home .threads-card')].map((card) => card.id).join() === 'thread-card-14'",
      "only Docs' thread",
    );
    await browser.screenshot("threads-home-filtered");
    await clickText(browser, ".threads-filter-chip", "All");
    await browser.waitFor(
      "document.querySelectorAll('.threads-home .threads-card').length === 3",
      "every workspace again",
    );
    await clickText(browser, "#thread-card-13 .threads-quiet", "Snooze");
    // A click elsewhere puts the menu away; Snooze opens it again.
    await browser.evaluate(
      "document.querySelector('.threads-home-head').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))",
    );
    await browser.waitFor(
      "!document.querySelector('.threads-snooze-menu')",
      "the menu put away",
    );
    await clickText(browser, "#thread-card-13 .threads-quiet", "Snooze");
    await clickText(browser, ".threads-snooze-menu button", "1 hour");
    await browser.waitFor(
      "document.body.innerText.includes('SNOOZED') && !document.querySelector('#thread-card-13')",
      "#13 folded into Snoozed",
    );
    const snoozed = (await browser.requests()).find(
      (one) => "threadSnooze" in one,
    )!;
    expect(
      (snoozed.threadSnooze as { id: number }).id === 13,
      `snoozed ${JSON.stringify(snoozed)}`,
    );
    await browser.evaluate(
      "document.querySelector('#thread-card-12 .threads-quote-go').click()",
    );
    await browser.waitFor(
      "window.requests.some((one) => one.openThread === 12 && one.focus === 'a-3')",
      "main at #12's message, beside its session",
    );
    await key(browser, "#thread-card-12", "2");
    await key(browser, "#thread-card-12", "Enter");
    await browser.waitFor(
      "window.requests.some((one) => 'threadSay' in one)",
      "the reply from Home",
    );
    const [home] = await answers(browser);
    expect(
      JSON.stringify(home!.threadSay) ===
        JSON.stringify({ id: 12, body: null, option: 1 }),
      `Home sent ${JSON.stringify(home)}`,
    );
    await browser.screenshot("threads-home-answered");
  },
);

// A thread in its own tab opens on its fork, with the thread it works on.
await withBrowser(
  {
    port: 41838,
    page: "threads-test.html",
    query: "thread=13",
    width: 1100,
    height: 700,
  },
  async (browser) => {
    await browser.waitFor(
      "document.querySelector('.threads-fork-terminal .fake-terminal')",
      "the thread's fork, first thing",
    );
    expect(
      (await browser.evaluate<string>("document.body.innerText")).includes(
        "Which Slack channel",
      ),
      "the tab does not show the thread's question",
    );
    await browser.screenshot("threads-tab");
  },
);

console.log("threads check passed");

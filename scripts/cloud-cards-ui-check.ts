/**
 * Session cards in a real browser, against `cloud-test.tsx`. A session in a
 * cloud workspace has no cloud icon of its own, and its card shows only two
 * cloud states: 'cloud asleep' and 'waking…'. Opening a sleeping session
 * wakes its workspace and revives it through one call. A session this Mac
 * cannot reach (another cloud account, or signed out) shows no cloud state
 * and offers neither wake nor revive.
 *
 *   bun run test:cloud-cards-ui
 */
import { expect, withBrowser, type Browser } from "./lib/browser-check";

interface Card {
  id: string;
  cloud: string | null;
  state: string | null;
  icon: boolean;
  label: string;
  revive: boolean;
}

const cards = async (browser: Browser) =>
  Object.fromEntries(
    (
      await browser.evaluate<
        Card[]
      >(`[...document.querySelectorAll('.session-card')].map((card) => ({
        id: card.querySelector('.session-card-main').dataset.sessionId,
        cloud: card.getAttribute('data-cloud'),
        state: card.getAttribute('data-cloud-state'),
        icon: Boolean(card.querySelector('[data-testid="session-cloud-action"], .session-cloud-action')),
        label: card.innerText.replace(/\\s+/g, ' ').trim(),
        revive: Boolean(card.querySelector('[aria-label^="Revive "]')),
      }))`)
    ).map((card) => [card.id, card]),
  ) as Record<string, Card>;

const ready = async (browser: Browser) => {
  await browser.waitFor(
    "document.querySelectorAll('.session-card').length === 4",
    "the four session cards",
  );
  // The cloud state arrives after the first paint.
  await browser.waitFor(
    "document.querySelector('[data-session-id=\"s-sleepy\"]').closest('.session-card').getAttribute('data-cloud-state')",
    "the cloud state on the cards",
  );
};

const wakeCalls = async (browser: Browser) =>
  (await browser.requests()).filter((one) => "cloudSessionWake" in one);

const fits = async (browser: Browser) => {
  for (const height of [820, 560]) {
    await browser.resize(height);
    const seen = await browser.evaluate<{ bad: string[] }>(`(() => {
      const bad = [];
      for (const card of document.querySelectorAll('.session-card[data-cloud]'))
        if (card.scrollWidth > card.clientWidth + 1) bad.push('card overflows sideways');
      if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push('page scrolls sideways');
      return { bad };
    })()`);
    expect(
      !seen.bad.length,
      `layout at ${height}px: ${[...new Set(seen.bad)].join(", ")}`,
    );
  }
  await browser.resize(820);
};

// Signed in: one card per state.
await withBrowser(
  { port: 41772, page: "cloud-test.html", query: "holdWake=1" },
  async (browser) => {
    await ready(browser);
    const seen = await cards(browser);
    expect(
      !seen["s-local"]!.cloud && !seen["s-local"]!.state,
      `the local card carries cloud marks: ${JSON.stringify(seen["s-local"])}`,
    );
    for (const id of ["s-cloud", "s-sleepy", "s-other"])
      expect(
        seen[id]!.cloud === "true" && !seen[id]!.icon,
        `${id} has a cloud icon of its own: ${JSON.stringify(seen[id])}`,
      );
    expect(
      !seen["s-cloud"]!.state && seen["s-cloud"]!.label.includes("running"),
      `a running cloud session reads "${seen["s-cloud"]!.label}"`,
    );
    expect(
      seen["s-sleepy"]!.state === "sleeping" &&
        seen["s-sleepy"]!.label.includes("cloud asleep") &&
        seen["s-sleepy"]!.revive,
      `the sleeping card reads ${JSON.stringify(seen["s-sleepy"])}`,
    );
    expect(
      !seen["s-other"]!.state &&
        !seen["s-other"]!.label.includes("unavailable") &&
        !seen["s-other"]!.label.includes("cloud") &&
        !seen["s-other"]!.revive,
      `the unreachable card reads ${JSON.stringify(seen["s-other"])}`,
    );
    await fits(browser);
    await browser.screenshot("cloud-cards");

    // An unreachable session does nothing when opened.
    await browser.evaluate(
      `document.querySelector('[data-session-id="s-other"]').click()`,
    );
    await Bun.sleep(300);
    expect(
      !(await wakeCalls(browser)).length,
      "opening an unreachable session called cloudSessionWake",
    );

    // Opening the sleeping one wakes and revives it through one call.
    await browser.evaluate(
      `document.querySelector('[data-session-id="s-sleepy"]').click()`,
    );
    await browser.waitFor(
      "document.querySelector('[data-session-id=\"s-sleepy\"]').closest('.session-card').innerText.includes('waking')",
      "the waking label",
    );
    await browser.screenshot("cloud-cards-waking");
    const calls = await wakeCalls(browser);
    expect(
      JSON.stringify(calls) ===
        '[{"cloudSessionWake":{"sessionId":"s-sleepy"}}]',
      `opening a sleeping session sent ${JSON.stringify(calls)}`,
    );
    await browser.evaluate("window.cloudFixture.releaseWake()");
    await browser.waitFor(
      "!document.querySelector('[data-session-id=\"s-sleepy\"]').closest('.session-card').hasAttribute('data-cloud-state')",
      "the card to leave the sleeping state",
    );
    const after = (await cards(browser))["s-sleepy"]!;
    expect(
      after.label.includes("running") && !after.label.includes("asleep"),
      `after waking the card reads "${after.label}"`,
    );
    const names = (await browser.requests()).map((one) => Object.keys(one)[0]);
    expect(
      names.filter((name) => name === "cloudSessionWake").length === 1 &&
        !names.includes("agentRevive"),
      `waking called ${names.join(", ")}`,
    );
    await browser.screenshot("cloud-cards-woken");
  },
);

// The revive button on a sleeping card takes the same road.
await withBrowser({ port: 41774, page: "cloud-test.html" }, async (browser) => {
  await ready(browser);
  await browser.evaluate(
    `document.querySelector('[aria-label="Revive s-sleepy session"]').click()`,
  );
  await browser.waitFor(
    "window.requests.some((one) => 'cloudSessionWake' in one)",
    "the wake call from the revive button",
  );
  const calls = await wakeCalls(browser);
  expect(
    JSON.stringify(calls) === '[{"cloudSessionWake":{"sessionId":"s-sleepy"}}]',
    `the revive button sent ${JSON.stringify(calls)}`,
  );
});

// Signed out: every cloud session is out of reach, the running one too.
await withBrowser(
  { port: 41776, page: "cloud-test.html", query: "signedIn=0" },
  async (browser) => {
    await browser.waitFor(
      "document.querySelectorAll('.session-card').length === 4",
      "the four session cards",
    );
    // The cloud state arrives after the first paint.
    await Bun.sleep(400);
    const seen = await cards(browser);
    expect(
      !seen["s-local"]!.state && seen["s-local"]!.label.includes("running"),
      "the local card changed while signed out",
    );
    for (const id of ["s-cloud", "s-sleepy", "s-other"])
      expect(
        !seen[id]!.state && !seen[id]!.icon && !seen[id]!.revive,
        `${id} while signed out: ${JSON.stringify(seen[id])}`,
      );
    await browser.evaluate(
      `document.querySelector('[data-session-id="s-sleepy"]').click()`,
    );
    await Bun.sleep(300);
    expect(
      !(await wakeCalls(browser)).length,
      "opening a session called cloudSessionWake while signed out",
    );
    await fits(browser);
    await browser.screenshot("cloud-cards-signed-out");
  },
);

console.log("cloud cards check passed");

/**
 * Session cards in a real browser, against `cloud-test.tsx`: the cloud
 * action lit on a cloud session, the quiet sleeping state, opening a sleeping session (which wakes
 * its workspace and revives it through one call), and the unavailable state
 * for a session of another cloud account or while this Mac is signed out,
 * which offers neither wake nor revive.
 *
 *   bun run test:cloud-cards-ui
 */
import { expect, withBrowser, type Browser } from "./lib/browser-check";

interface Card {
  id: string;
  cloud: string | null;
  state: string | null;
  badge: boolean;
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
        badge: Boolean(card.querySelector('[data-testid="session-cloud-action"][data-cloud-lit]')),
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
      for (const card of document.querySelectorAll('.session-card[data-cloud]')) {
        const box = card.getBoundingClientRect();
        const action = card.querySelector('[data-testid="session-cloud-action"][data-cloud-lit]')?.getBoundingClientRect();
        if (action && (action.left < box.left - 1 || action.right > box.right + 1 || action.top < box.top - 1 || action.bottom > box.bottom + 1))
          bad.push('cloud action outside its card');
        const revive = card.querySelector('[aria-label^="Revive "]')?.getBoundingClientRect();
        if (action && revive && action.right > revive.left + 1 && action.left < revive.right && action.bottom > revive.top && action.top < revive.bottom)
          bad.push('cloud action overlaps the revive button');
        // What the title row shows (its children), not its padded box.
        const shown = [...(card.querySelector('.session-card-title')?.children ?? [])].map((one) => one.getBoundingClientRect());
        if (action && shown.some((one) => one.width && one.right > action.left + 1 && one.top < action.bottom && one.bottom > action.top))
          bad.push('the title runs under the cloud action');
        if (card.scrollWidth > card.clientWidth + 1) bad.push('card overflows sideways');
      }
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
      !seen["s-local"]!.cloud &&
        !seen["s-local"]!.badge &&
        !seen["s-local"]!.state,
      `the local card carries cloud marks: ${JSON.stringify(seen["s-local"])}`,
    );
    for (const id of ["s-cloud", "s-sleepy", "s-other"])
      expect(
        seen[id]!.cloud === "true" && seen[id]!.badge,
        `${id} has no cloud mark: ${JSON.stringify(seen[id])}`,
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
      seen["s-other"]!.state === "unavailable" &&
        seen["s-other"]!.label.includes("unavailable") &&
        !seen["s-other"]!.revive,
      `the unavailable card reads ${JSON.stringify(seen["s-other"])}`,
    );
    await fits(browser);
    await browser.screenshot("cloud-cards");

    // An unavailable session does nothing when opened.
    await browser.evaluate(
      `document.querySelector('[data-session-id="s-other"]').click()`,
    );
    await Bun.sleep(300);
    expect(
      !(await wakeCalls(browser)).length,
      "opening an unavailable session called cloudSessionWake",
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
      "document.querySelectorAll('.session-card[data-cloud-state=\"unavailable\"]').length === 3",
      "all three cloud cards unavailable while signed out",
    );
    const seen = await cards(browser);
    expect(
      !seen["s-local"]!.state && seen["s-local"]!.label.includes("running"),
      "the local card changed while signed out",
    );
    for (const id of ["s-cloud", "s-sleepy", "s-other"])
      expect(
        seen[id]!.badge && !seen[id]!.revive,
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

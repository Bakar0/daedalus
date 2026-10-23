/**
 * Moving a session between this Mac and the cloud, in a real browser against
 * `cloud-test.tsx`: the card's cloud action moves a local Claude session to
 * the cloud, and is lit on a cloud one, where it moves it back to this Mac
 * (the menu has no move items); a moving card says so, with
 * Cancel while it waits for the turn; a move back that changed files which
 * steer agents asks first, then sends them as approved.
 *
 *   bun run test:cloud-move-ui
 */
import {
  expect,
  openMenu,
  withBrowser,
  type Browser,
} from "./lib/browser-check";

const openCardMenu = async (browser: Browser, session: string) => {
  browser.scope = "";
  expect(
    await browser.evaluate<boolean>(openMenu(`More actions for ${session}`)),
    `no menu for ${session}`,
  );
  await browser.waitFor(
    `document.querySelector('summary[aria-label="More actions for ${session}"]').parentElement.querySelector('.menu-popover:popover-open')`,
    `the ${session} menu to open`,
  );
  browser.scope = ".menu-popover:popover-open";
};

const cardAction = (session: string) =>
  `document.querySelector('[data-session-id="${session}"]').closest('.session-card').querySelector('[data-testid="session-cloud-action"]')`;

const action = (browser: Browser, session: string) =>
  browser.evaluate<{
    to: string | null;
    lit: boolean;
    disabled: boolean;
    label: string;
  } | null>(`(() => {
    const button = ${cardAction(session)};
    return button
      ? {
          to: button.dataset.moveTo ?? null,
          lit: button.hasAttribute('data-cloud-lit'),
          disabled: button.disabled,
          label: button.getAttribute('aria-label'),
        }
      : null;
  })()`);

const clickAction = (browser: Browser, session: string) =>
  browser.evaluate(`${cardAction(session)}.click()`);

const moves = async (browser: Browser) =>
  (await browser.requests())
    .filter((one) => "agentMove" in one)
    .map((one) => JSON.stringify(one.agentMove));

await withBrowser({ port: 41790, page: "cloud-test.html" }, async (browser) => {
  await Bun.sleep(400);

  // A local Claude session moves to the cloud from its card's cloud action.
  const local = await action(browser, "s-local");
  expect(
    local?.to === "cloud" &&
      !local.lit &&
      local.label === "Move s-local to cloud",
    `a local session's cloud action: ${JSON.stringify(local)}`,
  );
  await openCardMenu(browser, "s-local");
  expect(
    !(await browser.has("session-move")),
    "the card menu still has a move item",
  );
  browser.scope = "";
  await clickAction(browser, "s-local");
  await browser.waitFor(
    "window.requests.some((one) => 'agentMove' in one)",
    "the move call",
  );
  expect(
    (await moves(browser))[0] === '{"sessionId":"s-local","to":"cloud"}',
    `Move to cloud sent ${(await moves(browser))[0]}`,
  );

  // A cloud session's action is lit, and moves it back.
  const cloud = await action(browser, "s-cloud");
  expect(
    cloud?.to === "local" && cloud.lit && !cloud.disabled,
    `a cloud session's cloud action: ${JSON.stringify(cloud)}`,
  );
  await browser.screenshot("cloud-move-actions");

  // One in another cloud account is lit but cannot move from here.
  const other = await action(browser, "s-other");
  expect(
    other?.lit === true && other.disabled && !other.to,
    `a session of another cloud account: ${JSON.stringify(other)}`,
  );
});

// A move back that changed files which steer agents asks first.
await withBrowser(
  { port: 41792, page: "cloud-test.html", query: "move=approval" },
  async (browser) => {
    await Bun.sleep(400);
    await clickAction(browser, "s-cloud");
    browser.scope = "";
    await browser.waitFor(
      "[...document.querySelectorAll('.modal button')].some((one) => one.textContent.trim() === 'Move back')",
      "the approval question",
    );
    const question = await browser.evaluate<string>(
      "document.querySelector('.modal').textContent",
    );
    expect(
      question.includes(".claude/settings.json") &&
        question.includes("CLAUDE.md"),
      `the question does not list the files: ${question}`,
    );
    await browser.screenshot("cloud-move-approval");
    await browser.evaluate(
      "[...document.querySelectorAll('.modal button')].find((one) => one.textContent.trim() === 'Move back').click()",
    );
    await browser.waitFor(
      "window.requests.filter((one) => 'agentMove' in one).length === 2",
      "the approved move",
    );
    expect(
      (await moves(browser))[1] ===
        '{"sessionId":"s-cloud","to":"local","approved":[".claude/settings.json","CLAUDE.md"]}',
      `the approved move sent ${(await moves(browser))[1]}`,
    );
  },
);

// A moving card says so, with Cancel while it waits for the turn.
await withBrowser(
  { port: 41794, page: "cloud-test.html", query: "moving=waiting" },
  async (browser) => {
    await Bun.sleep(400);
    const card = `document.querySelector('[data-session-id="s-cloud"]').closest('.session-card')`;
    expect(
      (await browser.evaluate<string>(`${card}.dataset.movePhase`)) ===
        "waiting" &&
        (await browser.evaluate<string>(
          `${card}.querySelector('.session-status-label').textContent`,
        )) === "moving to this Mac",
      "the moving card does not say it is moving",
    );
    expect(
      (await action(browser, "s-cloud"))?.disabled === true,
      "a moving session offers another move",
    );
    await browser.screenshot("cloud-move-waiting");
    await browser.click("session-move-cancel");
    await browser.waitFor(
      "window.requests.some((one) => 'agentMoveCancel' in one)",
      "the cancel call",
    );
    await browser.waitFor(
      `!${card}.dataset.movePhase`,
      "the card to stop moving after Cancel",
    );
  },
);

// A failed move says why on the card, and has no Cancel.
await withBrowser(
  { port: 41796, page: "cloud-test.html", query: "moving=failed" },
  async (browser) => {
    await Bun.sleep(400);
    const card = `document.querySelector('[data-session-id="s-cloud"]').closest('.session-card')`;
    expect(
      (await browser.evaluate<string>(
        `${card}.querySelector('.session-status-label').textContent`,
      )) === "move failed" && !(await browser.has("session-move-cancel")),
      "a failed move does not read 'move failed', or offers Cancel",
    );
    expect(
      (
        await browser.evaluate<string>(
          `${card}.querySelector('.session-card-main').title`,
        )
      ).includes("The pod did not answer"),
      "the failed move does not say why",
    );
  },
);

// After a move back, the session view says how it resumed until dismissed,
// and the card is not moving.
await withBrowser(
  {
    port: 41798,
    page: "cloud-test.html",
    query: "moving=moved",
  },
  async (browser) => {
    await Bun.sleep(400);
    await browser.evaluate(
      `document.querySelector('[data-session-id="s-cloud"]').click()`,
    );
    await browser.waitFor(
      "document.querySelector('[data-testid=\"session-move-notice\"]')",
      "the moved-back notice",
    );
    expect(
      (await browser.text("session-move-notice")).includes("ask mode"),
      "the notice does not say how the session resumed",
    );
    const card = `document.querySelector('[data-session-id="s-cloud"]').closest('.session-card')`;
    expect(
      !(await browser.evaluate<string | undefined>(
        `${card}.dataset.movePhase`,
      )),
      "a moved session's card still reads as moving",
    );
    await browser.screenshot("cloud-move-notice");
    await browser.click("session-move-notice-dismiss");
    await browser.waitFor(
      "!document.querySelector('[data-testid=\"session-move-notice\"]')",
      "the notice to go after Got it",
    );
    expect(
      (await browser.requests()).some(
        (one) =>
          JSON.stringify(one) ===
          '{"agentMoveDismiss":{"sessionId":"s-cloud"}}',
      ),
      "Got it did not call agentMoveDismiss",
    );
  },
);

console.log("cloud move check passed");

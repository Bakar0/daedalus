/**
 * Moving a whole workspace in a real browser, against `cloud-test.tsx`. The
 * workspace header has a cloud action: lit while the workspace is in the
 * cloud, where a click brings it home; on this Mac it shows on hover and
 * moves the workspace to the cloud. Both ask first. While a move runs, the
 * workspace shows where it is going, its steps and the host's detail, Cancel
 * while waiting, and no new session. Questions from the host (files that
 * steer agents, sessions waiting on the user) are asked and sent back; a
 * refusal (sessions the cloud cannot run, something too big) is shown and
 * nothing is sent again. Text from the pod is plain and cut short. Notices
 * stay until Got it. Signed out, only a workspace in the cloud has the
 * action, and it is off.
 *
 *   bun run test:cloud-move-ui
 */
import { expect, withBrowser, type Browser } from "./lib/browser-check";

const action = (name: string) =>
  `document.querySelector('summary[aria-label="Settings of ${name}"]').closest('.workspace-card-actions').querySelector('[data-testid="workspace-cloud-action"]')`;

const group = (name: string) =>
  `document.querySelector('summary[aria-label="Settings of ${name}"]').closest('.workspace-group')`;

const dialogButton = (label: string) =>
  `[...document.querySelectorAll('.modal button')].find((one) => one.textContent.trim() === ${JSON.stringify(label)})`;

const answer = async (browser: Browser, label: string) => {
  await browser.waitFor(dialogButton(label), `the "${label}" button`);
  const text = await browser.evaluate<string>(
    "document.querySelector('.modal').textContent",
  );
  await browser.evaluate(`${dialogButton(label)}.click()`);
  // Gone, or followed by the host's next question.
  await browser.waitFor(
    `document.querySelector('.modal')?.textContent !== ${JSON.stringify(text)}`,
    `the dialog to close after "${label}"`,
  );
  return text;
};

const moves = async (browser: Browser) =>
  (await browser.requests())
    .filter((one) => "workspaceMove" in one)
    .map((one) => JSON.stringify(one.workspaceMove));

const ready = async (browser: Browser) => {
  await browser.waitFor(
    "document.querySelector('summary[aria-label=\"Settings of Plain local\"]')",
    "the workspace list",
  );
  // The cloud state arrives after the first paint.
  await Bun.sleep(400);
};

const startMove = async (browser: Browser, name: string, confirm: string) => {
  await browser.evaluate(`${action(name)}.click()`);
  return answer(browser, confirm);
};

const fits = async (browser: Browser, testId: string) => {
  for (const height of [820, 560]) {
    await browser.resize(height);
    const seen = await browser.evaluate<{ inside: boolean; scrolls: boolean }>(
      `(() => {
        const box = document.querySelector('[data-testid="${testId}"]').getBoundingClientRect();
        const column = document.querySelector('nav[aria-label="Workspaces"]').getBoundingClientRect();
        return {
          inside: box.left >= column.left - 1 && box.right <= column.right + 1,
          scrolls: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      })()`,
    );
    expect(
      seen.inside && !seen.scrolls,
      `${testId} spills out of the column at ${height}px`,
    );
  }
  await browser.resize(820);
};

// The action, lit or on hover; a move to the cloud end to end, held midway.
await withBrowser(
  { port: 41820, page: "cloud-test.html", query: "holdMove=1" },
  async (browser) => {
    await ready(browser);
    const seen = await browser.evaluate<{
      cloudLit: boolean;
      cloudShown: boolean;
      localLit: boolean;
      localShown: boolean;
    }>(`({
      cloudLit: ${action("Cloud project")}.dataset.cloudLit === 'true',
      cloudShown: ${action("Cloud project")}.offsetParent !== null,
      localLit: ${action("Plain local")}.dataset.cloudLit === 'true',
      localShown: ${action("Plain local")}.offsetParent !== null,
    })`);
    expect(
      seen.cloudLit && seen.cloudShown,
      `a workspace in the cloud does not show a lit cloud action: ${JSON.stringify(seen)}`,
    );
    expect(
      !seen.localLit && !seen.localShown,
      `a workspace on this Mac shows its cloud action without hover: ${JSON.stringify(seen)}`,
    );
    const order = await browser.evaluate<string[]>(
      `[...${action("Cloud project")}.parentElement.children].map((one) => one.matches('.workspace-card-menu') ? 'settings' : one.matches('.workspace-session-create') ? 'new' : one.matches('.workspace-cloud-action') ? 'cloud' : 'other')`,
    );
    expect(
      order.slice(-3).join(",") === "cloud,new,settings",
      `the header reads ${JSON.stringify(order)}`,
    );
    await browser.screenshot("cloud-move-header");

    // Asks first; Cancel moves nothing.
    await browser.evaluate(`${action("Plain local")}.click()`);
    const text = await answer(browser, "Cancel");
    expect(
      text.includes("Move Plain local to the cloud?") &&
        text.includes("backup"),
      `the question reads "${text}"`,
    );
    expect(!(await moves(browser)).length, "Cancel moved the workspace");

    await startMove(browser, "Plain local", "Move to cloud");
    await browser.waitFor(
      `${group("Plain local")}.querySelector('[data-testid="workspace-move"][data-phase="copying"]')`,
      "the moving state",
    );
    const moving = await browser.evaluate<{
      label: string;
      detail: string;
      done: number;
      now: number;
      createOff: boolean;
      actionOff: boolean;
    }>(`(() => {
      const strip = ${group("Plain local")}.querySelector('[data-testid="workspace-move"]');
      return {
        label: strip.querySelector('.workspace-move-label').textContent,
        detail: strip.querySelector('[data-testid="workspace-move-detail"]').textContent,
        done: strip.querySelectorAll('li[data-state="done"]').length,
        now: strip.querySelectorAll('li[data-state="now"]').length,
        createOff: document.querySelector('[aria-label="Create session in Plain local"]').disabled,
        actionOff: ${action("Plain local")}.disabled && ${action("Plain local")}.dataset.moving === 'true',
      };
    })()`);
    expect(
      moving.label === "Moving to the cloud…" &&
        moving.detail === "Copying repos/app" &&
        moving.done === 2 &&
        moving.now === 1,
      `the moving state reads ${JSON.stringify(moving)}`,
    );
    expect(
      moving.createOff && moving.actionOff,
      `a moving workspace still takes a session or another move: ${JSON.stringify(moving)}`,
    );
    expect(
      !(await browser.has("workspace-move-cancel")),
      "Cancel shows while copying",
    );
    await fits(browser, "workspace-move");
    await browser.screenshot("cloud-move-moving");

    await browser.evaluate("window.cloudFixture.releaseMove()");
    await browser.waitFor(
      `${action("Plain local")}.dataset.cloudLit === 'true' && !${group("Plain local")}.querySelector('[data-testid="workspace-move"]')`,
      "the workspace to be in the cloud",
    );
    expect(
      JSON.stringify(await moves(browser)) ===
        JSON.stringify(['{"reference":"local-ws","to":"cloud"}']),
      `the move sent ${JSON.stringify(await moves(browser))}`,
    );
  },
);

// Home, with the notice it leaves.
await withBrowser({ port: 41822, page: "cloud-test.html" }, async (browser) => {
  await ready(browser);
  const text = await startMove(browser, "Cloud project", "Move to this Mac");
  expect(
    text.includes("Move Cloud project back to this Mac?") &&
      text.includes("ask mode"),
    `the question reads "${text}"`,
  );
  await browser.waitFor(
    "document.querySelector('[data-testid=\"workspace-move-notice\"]')",
    "the moved notice",
  );
  expect(
    (await browser.text("workspace-move-notice")).includes("ask mode") &&
      !(await browser.evaluate<boolean>(
        `${action("Cloud project")}.dataset.cloudLit === 'true'`,
      )),
    "the notice does not say it resumes in ask mode, or the action stays lit",
  );
  await fits(browser, "workspace-move-notice");
  await browser.screenshot("cloud-move-notice");
  await browser.click("workspace-move-notice-dismiss");
  await browser.waitFor(
    "!document.querySelector('[data-testid=\"workspace-move-notice\"]')",
    "the notice to go after Got it",
  );
  expect(
    (await browser.requests()).some(
      (one) =>
        JSON.stringify(one) ===
        '{"workspaceMoveDismiss":{"reference":"cloud-ws"}}',
    ),
    "Got it did not call workspaceMoveDismiss",
  );
});

// Files that steer agents: listed as plain lines, then sent back approved.
await withBrowser(
  { port: 41824, page: "cloud-test.html", query: "moveAsk=approval" },
  async (browser) => {
    await ready(browser);
    await startMove(browser, "Cloud project", "Move to this Mac");
    await browser.waitFor(dialogButton("Move with them"), "the approval");
    const lines = await browser.evaluate<string[]>(
      "[...document.querySelectorAll('[data-testid=\"dialog-lines\"] li')].map((one) => one.textContent)",
    );
    expect(
      lines.length === 2 &&
        lines[0] === ".claude/settings.json" &&
        lines[1] === "CLAUDE.md [2J",
      `the approval lists ${JSON.stringify(lines)}`,
    );
    await browser.screenshot("cloud-move-approval");
    await answer(browser, "Move with them");
    await browser.waitFor(
      "window.requests.filter((one) => 'workspaceMove' in one).length === 2",
      "the approved move",
    );
    expect(
      (await moves(browser))[1] ===
        '{"reference":"cloud-ws","to":"mac","approved":[".claude/settings.json","CLAUDE.md\\u001b[2J"]}',
      `the approved move sent ${(await moves(browser))[1]}`,
    );
  },
);

// Sessions waiting on the user: ask, then stop them.
await withBrowser(
  { port: 41826, page: "cloud-test.html", query: "moveAsk=busy" },
  async (browser) => {
    await ready(browser);
    await startMove(browser, "Plain local", "Move to cloud");
    const text = await answer(browser, "Stop them and move");
    expect(text.includes("s-local"), `the question reads "${text}"`);
    await browser.waitFor(
      "window.requests.filter((one) => 'workspaceMove' in one).length === 2",
      "the move that stops them",
    );
    expect(
      (await moves(browser))[1] ===
        '{"reference":"local-ws","to":"cloud","stopWorking":true}',
      `the second move sent ${(await moves(browser))[1]}`,
    );
  },
);

// Refusals are shown once and nothing is sent again.
for (const [port, ask, says] of [
  [41828, "stopped", "codex helper"],
  [41830, "big", "repos/app: 1.5 GB, at most 1 GB"],
] as const)
  await withBrowser(
    { port, page: "cloud-test.html", query: `moveAsk=${ask}` },
    async (browser) => {
      await ready(browser);
      await startMove(browser, "Plain local", "Move to cloud");
      const text = await answer(browser, "OK");
      expect(text.includes(says), `the ${ask} message reads "${text}"`);
      await Bun.sleep(300);
      expect(
        (await moves(browser)).length === 1,
        `a ${ask} refusal was sent again`,
      );
      await browser.screenshot(`cloud-move-${ask}`);
    },
  );

// A move the host refuses outright says why under the workspace.
await withBrowser(
  { port: 41832, page: "cloud-test.html", query: "moveAsk=fail" },
  async (browser) => {
    await ready(browser);
    await startMove(browser, "Plain local", "Move to cloud");
    await browser.waitFor(
      `${group("Plain local")}.querySelector('[data-testid="workspace-move"][data-phase="failed"]')`,
      "the failure under the workspace",
    );
    expect(
      (await browser.text("workspace-move-detail")).includes(
        "The gateway refused the move.",
      ),
      `the failure reads "${await browser.text("workspace-move-detail")}"`,
    );
    await browser.click("workspace-move-dismiss");
    await browser.waitFor(
      "!document.querySelector('[data-testid=\"workspace-move\"]')",
      "the failure to go after Dismiss",
    );
  },
);

// Waiting for turns: Cancel stops it.
await withBrowser(
  { port: 41834, page: "cloud-test.html", query: "wsmove=waiting" },
  async (browser) => {
    await ready(browser);
    expect(
      (await browser.text("workspace-move-detail")) ===
        "Waiting for 2 sessions to end their turns",
      "the waiting state does not say what it waits for",
    );
    await browser.screenshot("cloud-move-waiting");
    await browser.click("workspace-move-cancel");
    await browser.waitFor(
      "window.requests.some((one) => 'workspaceMoveCancel' in one)",
      "the cancel call",
    );
    expect(
      (await browser.requests()).some(
        (one) =>
          JSON.stringify(one) ===
          '{"workspaceMoveCancel":{"reference":"cloud-ws"}}',
      ),
      "Cancel sent the wrong call",
    );
  },
);

// A failed move from the host says so, and that nothing moved.
await withBrowser(
  { port: 41836, page: "cloud-test.html", query: "wsmove=failed" },
  async (browser) => {
    await ready(browser);
    expect(
      (await browser.attribute("workspace-move", "data-phase")) === "failed" &&
        (await browser.text("workspace-move-detail")).includes(
          "stays where it was",
        ),
      "the failed move does not say the workspace stayed",
    );
    await browser.screenshot("cloud-move-failed");
  },
);

// Back from its backup after the cloud copy was deleted.
await withBrowser(
  { port: 41838, page: "cloud-test.html", query: "notice=1" },
  async (browser) => {
    await ready(browser);
    expect(
      (await browser.text("workspace-cloud-notice")).includes("backup"),
      "the backup notice is missing",
    );
    await browser.click("workspace-cloud-notice-dismiss");
    await browser.waitFor(
      "!document.querySelector('[data-testid=\"workspace-cloud-notice\"]')",
      "the backup notice to go",
    );
    expect(
      (await browser.requests()).some(
        (one) =>
          JSON.stringify(one) ===
          '{"workspaceNoticeDismiss":{"reference":"sleepy-ws"}}',
      ),
      "Got it did not call workspaceNoticeDismiss",
    );
  },
);

// Signed out: only a workspace in the cloud has the action, and it is off.
await withBrowser(
  { port: 41840, page: "cloud-test.html", query: "signedIn=0" },
  async (browser) => {
    await ready(browser);
    expect(
      !(await browser.evaluate<boolean>(`Boolean(${action("Plain local")})`)) &&
        (await browser.evaluate<boolean>(
          `${action("Cloud project")}.disabled`,
        )),
      "signed out, the cloud action shows on this Mac's workspace or is on",
    );
  },
);

console.log("cloud move check passed");

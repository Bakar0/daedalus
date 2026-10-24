/**
 * Moving a whole workspace in a real browser, against `cloud-test.tsx`. The
 * workspace header has a cloud action: lit while the workspace is in the
 * cloud, where a click brings it home; on this Mac it shows when pinned and
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

const openSettings = async (browser: Browser, name: string) => {
  await browser.evaluate(
    `document.querySelector('summary[aria-label="Settings of ${name}"]').click()`,
  );
  await browser.waitFor(
    "document.querySelector('.menu-popover:popover-open [data-testid=\"menu-action-cloud\"]')",
    `the ${name} move item`,
  );
};

/** From the workspace's Settings; a move asks nothing first. */
const startMove = async (browser: Browser, name: string) => {
  await openSettings(browser, name);
  await browser.evaluate(
    "document.querySelector('.menu-popover:popover-open [data-testid=\"menu-action-cloud\"]').click()",
  );
  await browser.waitFor(
    "window.requests.some((one) => 'workspaceMove' in one)",
    "the move call",
  );
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

// The action, lit or pinned; a move to the cloud end to end, held midway.
await withBrowser(
  { port: 41820, page: "cloud-test.html", query: "holdMove=1" },
  async (browser) => {
    await ready(browser);
    const seen = await browser.evaluate<{
      cloudLit: boolean;
      cloudShown: boolean;
      local: boolean;
    }>(`({
      cloudLit: ${action("Cloud project")}.dataset.cloudLit === 'true',
      cloudShown: ${action("Cloud project")}.offsetParent !== null,
      local: Boolean(${action("Plain local")}),
    })`);
    expect(
      seen.cloudLit && seen.cloudShown,
      `a workspace in the cloud does not show a lit cloud action: ${JSON.stringify(seen)}`,
    );
    expect(
      !seen.local,
      "an unpinned cloud action is on the header of a workspace on this Mac",
    );
    const order = await browser.evaluate<string[]>(
      `[...${action("Cloud project")}.parentElement.children].map((one) => one.matches('.workspace-card-menu') ? 'settings' : one.matches('.workspace-session-create') ? 'new' : one.matches('.workspace-cloud-action') ? 'cloud' : 'other')`,
    );
    expect(
      order.slice(-3).join(",") === "cloud,new,settings",
      `the header reads ${JSON.stringify(order)}`,
    );
    await browser.screenshot("cloud-move-header");

    // Settings has the move with its icon, unpinned; a pin puts it on the
    // header like the others.
    await openSettings(browser, "Plain local");
    browser.scope = ".menu-popover:popover-open";
    expect(
      (await browser.evaluate<boolean>(
        "Boolean(document.querySelector('.menu-popover:popover-open [data-action=\"cloud\"] .menu-item-icon svg'))",
      )) &&
        (await browser.text("menu-action-cloud")) === "Move to cloud" &&
        (await browser.attribute("pin-cloud", "aria-pressed")) === "false",
      "Move to cloud is not in Settings with its icon, unpinned",
    );
    await browser.click("pin-cloud");
    browser.scope = "";
    await browser.evaluate(
      `document.querySelectorAll('details.menu[open]').forEach((one) => { one.open = false; })`,
    );
    await browser.waitFor(
      `${action("Plain local")}`,
      "the pinned cloud action",
    );
    expect(
      (await browser.evaluate<boolean>(
        `${action("Plain local")}.offsetParent !== null`,
      )) &&
        (await browser.evaluate<boolean>(
          `${action("Cloud project")}.offsetParent !== null`,
        )),
      "a pinned cloud action, or the lit one, hides until hover",
    );

    await startMove(browser, "Plain local");
    await browser.waitFor(
      `${group("Plain local")}.querySelector('[data-testid="workspace-move"][data-phase="copying"]')`,
      "the moving state",
    );
    expect(
      !(await browser.evaluate<boolean>(
        "Boolean(document.querySelector('.modal'))",
      )),
      "the move asked first",
    );
    const scene = await browser.evaluate<{
      to: string;
      dots: number;
      step: string;
      animated: boolean;
    }>(`(() => {
      const strip = ${group("Plain local")}.querySelector('[data-testid="workspace-move"]');
      const scene = strip.querySelector('[data-testid="workspace-move-scene"]');
      const dot = scene.querySelector('.workspace-move-track i');
      return {
        to: scene.dataset.to,
        dots: scene.querySelectorAll('.workspace-move-track i').length,
        step: strip.querySelector('[data-testid="workspace-move-step"]').textContent,
        animated: getComputedStyle(dot).animationName === 'workspace-move-flow' && getComputedStyle(dot).animationDuration === '1.5s',
      };
    })()`);
    expect(
      scene.to === "cloud" &&
        scene.dots === 3 &&
        scene.step === "Copying repos/app" &&
        scene.animated,
      `the moving picture reads ${JSON.stringify(scene)}`,
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
        detail: strip.querySelector('[data-testid="workspace-move-step"]').textContent,
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
    // It settles, the cloud lit, then goes.
    await browser.waitFor(
      `${group("Plain local")}.querySelector('[data-testid="workspace-move-scene"][data-settled]')`,
      "the settled picture",
    );
    await browser.screenshot("cloud-move-settled");
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

// Home: it settles on this Mac, unlit, and leaves no notice. Sessions
// resume as they were; there is no ask mode to announce.
await withBrowser({ port: 41822, page: "cloud-test.html" }, async (browser) => {
  await ready(browser);
  await startMove(browser, "Cloud project");
  await browser.waitFor(
    `${group("Cloud project")}.querySelector('[data-testid="workspace-move-scene"][data-settled][data-to="mac"]')`,
    "the settled picture on this Mac",
  );
  expect(
    (await browser.text("workspace-move-step")) === "On this Mac" &&
      !(await browser.evaluate<boolean>(
        `${action("Cloud project")}?.dataset.cloudLit === 'true'`,
      )),
    "home does not settle on this Mac, or the action stays lit",
  );
  await Bun.sleep(300);
  expect(
    !(await browser.has("workspace-move-notice")) &&
      !(await browser.evaluate<boolean>(
        "document.body.innerText.includes('ask mode')",
      )),
    "moving home left a notice or mentions ask mode",
  );
});

// A notice the host sends stays until Got it.
await withBrowser(
  { port: 41848, page: "cloud-test.html", query: "wsmove=moved" },
  async (browser) => {
    await ready(browser);
    expect(
      (await browser.text("workspace-move-notice")).includes("size cap"),
      "the host's notice is missing",
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
  },
);

// Files that steer agents: listed as plain lines, then sent back approved.
await withBrowser(
  { port: 41824, page: "cloud-test.html", query: "moveAsk=approval" },
  async (browser) => {
    await ready(browser);
    await startMove(browser, "Cloud project");
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
    await startMove(browser, "Plain local");
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
      await startMove(browser, "Plain local");
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
    await startMove(browser, "Plain local");
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

// The gateway's limit names the workspaces in the cloud, from this Mac.
await withBrowser(
  { port: 41846, page: "cloud-test.html", query: "moveAsk=limit" },
  async (browser) => {
    await ready(browser);
    await startMove(browser, "Plain local");
    await browser.waitFor(
      `${group("Plain local")}.querySelector('[data-testid="workspace-move"][data-phase="failed"]')`,
      "the limit under the workspace",
    );
    const text = await browser.text("workspace-move-detail");
    expect(
      text.startsWith(
        "3 workspaces are already in the cloud: Cloud project, Sleepy project, Other account. Move one home first.",
      ),
      `the limit reads "${text}"`,
    );
    await browser.screenshot("cloud-move-limit");
  },
);

// Waiting for turns: Cancel stops it.
await withBrowser(
  { port: 41834, page: "cloud-test.html", query: "wsmove=waiting" },
  async (browser) => {
    await ready(browser);
    expect(
      (await browser.text("workspace-move-step")) ===
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

// A terminal for a workspace in the cloud runs in its pod, as a terminal
// session; one on this Mac stays an integrated terminal.
await withBrowser({ port: 41842, page: "cloud-test.html" }, async (browser) => {
  await ready(browser);
  const openTerminal = async (name: string) => {
    await browser.evaluate(
      `document.querySelector('summary[aria-label="Settings of ${name}"]').click()`,
    );
    await browser.waitFor(
      "document.querySelector('.menu-popover:popover-open [data-testid=\"menu-action-terminal\"]')",
      `the ${name} terminal item`,
    );
    await browser.evaluate(
      "document.querySelector('.menu-popover:popover-open [data-testid=\"menu-action-terminal\"]').click()",
    );
  };
  await openTerminal("Cloud project");
  await browser.waitFor(
    "window.requests.some((one) => 'agentSpawn' in one)",
    "the pod terminal",
  );
  const spawned = (await browser.requests()).find(
    (one) => "agentSpawn" in one,
  )?.agentSpawn;
  expect(
    JSON.stringify(spawned) ===
      '{"workspace":"cloud-ws","name":"Cloud project","terminal":true}' &&
      !(await browser.requests()).some((one) => "terminalCreate" in one),
    `a cloud workspace's terminal sent ${JSON.stringify(await browser.requests())}`,
  );
  await openTerminal("Plain local");
  await browser.waitFor(
    "window.requests.some((one) => 'terminalCreate' in one)",
    "the integrated terminal on this Mac",
  );
  expect(
    (await browser.requests()).filter((one) => "agentSpawn" in one).length ===
      1,
    "a terminal on this Mac went to agentSpawn",
  );
});

// The explorer of an asleep cloud workspace says so instead of a tree.
await withBrowser({ port: 41844, page: "cloud-test.html" }, async (browser) => {
  await ready(browser);
  await browser.evaluate(
    `${group("Sleepy project")}.querySelector('.workspace-item').click()`,
  );
  await browser.waitFor(
    "document.querySelector('[aria-label=\"Files\"]')",
    "the Files tab",
  );
  await browser.evaluate(
    "document.querySelector('[aria-label=\"Files\"]').click()",
  );
  await browser.waitFor(
    "document.querySelector('[data-testid=\"file-tree-unavailable\"]')",
    "the asleep message in the explorer",
  );
  expect(
    (await browser.text("file-tree-unavailable")) ===
      "The cloud workspace is asleep; open a session to wake it",
    `the explorer reads "${await browser.text("file-tree-unavailable")}"`,
  );
  await browser.screenshot("cloud-explorer-asleep");
});

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

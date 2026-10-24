/**
 * Two ways in for a new user, in a real browser against `cloud-test.tsx`:
 * the sidebar with no workspaces offers 'Create workspace', which opens the
 * new workspace dialog, and a workspace's 'Add repository' in the center
 * brings the side panel's Repositories tab to the front, opening the panel
 * when it was folded.
 *
 *   bun run test:sidebar-ui
 */
import { expect, withBrowser } from "./lib/browser-check";

await withBrowser(
  { port: 41880, page: "cloud-test.html", query: "workspaces=none" },
  async (browser) => {
    await browser.waitFor(
      "document.querySelector('.workspace-list-empty button')",
      "the empty workspace list",
    );
    const empty = await browser.evaluate<{ icon: boolean; text: string }>(
      `(() => {
        const box = document.querySelector('.workspace-list-empty');
        return { icon: Boolean(box.querySelector('svg')), text: box.textContent };
      })()`,
    );
    expect(
      empty.icon && empty.text === "No workspaces yet.Create workspace",
      `the empty list reads ${JSON.stringify(empty)}`,
    );
    await browser.screenshot("sidebar-no-workspaces");
    await browser.evaluate(
      "document.querySelector('.workspace-list-empty button').click()",
    );
    await browser.waitFor(
      `document.querySelector('[role="dialog"][aria-label="Create workspace"]')`,
      "the new workspace dialog",
    );
  },
);

await withBrowser({ port: 41882, page: "cloud-test.html" }, async (browser) => {
  await browser.waitFor(
    "document.querySelector('.center-empty-actions')",
    "the center of a workspace with nothing open",
  );
  const tab = (label: string) =>
    `document.querySelector('.side-panel-tab[aria-label="${label}"]')`;
  // Files in front, then folded: clicking the tab in front folds the panel.
  await browser.evaluate(`${tab("Files")}.click()`);
  if (
    await browser.evaluate<boolean>(
      `${tab("Files")}.getAttribute('aria-selected') === 'true'`,
    )
  )
    await browser.evaluate(`${tab("Files")}.click()`);
  await browser.waitFor(
    `${tab("Files")}.getAttribute('aria-selected') === 'false'`,
    "the side panel to fold",
  );
  await browser.evaluate(
    `[...document.querySelectorAll('.center-empty-actions button')].find((one) => one.textContent === 'Add repository').click()`,
  );
  await browser.waitFor(
    `document.querySelector('[role="dialog"][aria-label="Add repositories"]')`,
    "the add repositories dialog",
  );
  expect(
    await browser.evaluate<boolean>(
      `${tab("Repositories")}.getAttribute('aria-selected') === 'true'`,
    ),
    "the Repositories tab is not in front of an open side panel",
  );
});

console.log("sidebar ui check passed");

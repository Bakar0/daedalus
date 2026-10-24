/**
 * A way in for a new user, in a real browser against `cloud-test.tsx`:
 * the sidebar with no workspaces offers 'Create workspace', which opens the
 * new workspace dialog.
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

console.log("sidebar ui check passed");

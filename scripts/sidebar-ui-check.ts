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

/** Types into the open dialog's Name field the way React hears it. */
const typeName = (name: string) => `(() => {
  const input = document.querySelector('[role="dialog"] input');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(input, ${JSON.stringify(name)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})();`;

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
    // A name the core refuses (here, a folder already on disk) is said under
    // the field. The window's banner is under the backdrop, where it looked
    // like nothing had happened.
    await browser.evaluate(`${typeName("Taken")}
      document.querySelector('[role="dialog"] button[type="submit"]').click();`);
    await browser.waitFor(
      `document.querySelector('[role="dialog"] .field-error')`,
      "the refusal under the name",
    );
    const shown = await browser.evaluate<{
      field: string;
      invalid: string | null;
      banner: boolean;
    }>(
      `({
        field: document.querySelector('#workspace-name-error').textContent,
        invalid: document.querySelector('[role="dialog"] input').getAttribute('aria-invalid'),
        banner: Boolean(document.querySelector('.error-banner')),
      })`,
    );
    expect(
      shown.field === "Workspace 'taken' already exists" &&
        shown.invalid === "true" &&
        !shown.banner,
      `the refusal reads ${JSON.stringify(shown)}`,
    );
    await browser.screenshot("create-workspace-refused");
    // Editing the name takes the refusal away.
    await browser.evaluate(typeName("Taken again"));
    await browser.waitFor(
      `!document.querySelector('#workspace-name-error')`,
      "the refusal to clear",
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

// What the form can tell for itself it says as the user types, and Create
// stays off until the name is one the core would take.
await withBrowser({ port: 41884, page: "cloud-test.html" }, async (browser) => {
  await browser.waitFor(
    `document.querySelector('[aria-label="Create workspace"]')`,
    "the sidebar's Create workspace button",
  );
  await browser.evaluate(
    `document.querySelector('[aria-label="Create workspace"]').click()`,
  );
  await browser.waitFor(
    `document.querySelector('[role="dialog"][aria-label="Create workspace"]')`,
    "the new workspace dialog",
  );
  const field = () =>
    browser.evaluate<{ error: string | null; submit: boolean }>(
      `({
        error: document.querySelector('#workspace-name-error')?.textContent ?? null,
        submit: !document.querySelector('[role="dialog"] button[type="submit"]').disabled,
      })`,
    );
  const cases: [string, string | null][] = [
    ["Local WS", 'A workspace named "Plain local" already exists'],
    ["!!!", "Use at least one letter or number"],
    ["   ", "Enter a name"],
    ["Fresh one", null],
  ];
  for (const [name, error] of cases) {
    await browser.evaluate(typeName(name));
    const shown = await field();
    expect(
      shown.error === error && shown.submit === (error === null),
      `${JSON.stringify(name)} shows ${JSON.stringify(shown)}`,
    );
    if (name === "Local WS") await browser.screenshot("create-workspace-taken");
  }
});

console.log("sidebar ui check passed");

/**
 * Settings > Cloud in a real browser, against `cloud-test.tsx`: signed out,
 * signing in, signed in, a refused sign-in, and sign out. The fixture's
 * replies carry a token and a runner key; none of it may reach the DOM.
 *
 *   bun run test:cloud-settings-ui
 */
import {
  expect,
  FIXTURE_SECRETS,
  fitsViewport,
  openSettingsCategory,
  withBrowser,
  type Browser,
} from "./lib/browser-check";

const noSecrets = async (browser: Browser, when: string) => {
  const html = await browser.evaluate<string>(
    "document.documentElement.outerHTML",
  );
  for (const secret of FIXTURE_SECRETS)
    expect(!html.includes(secret), `${secret} is in the DOM ${when}`);
};

const fits = async (browser: Browser, label: string) => {
  for (const height of [820, 560]) {
    await browser.resize(height);
    const seen = await browser.evaluate<{
      found: boolean;
      top: number;
      bottom: number;
      viewport: number;
      pageScrolls: boolean;
    }>(fitsViewport(".modal"));
    expect(seen.found, `no dialog at ${height}px (${label})`);
    expect(
      seen.top >= 0 && seen.bottom <= seen.viewport,
      `the dialog runs off the screen at ${height}px (${label}): ${seen.top}..${seen.bottom} of ${seen.viewport}`,
    );
    expect(!seen.pageScrolls, `the page scrolls at ${height}px (${label})`);
    const panel = await browser.evaluate<boolean>(
      `(() => { const rect = document.querySelector('[data-testid="cloud-panel"]').getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })()`,
    );
    expect(panel, `the Cloud panel has no size at ${height}px (${label})`);
  }
  await browser.resize(820);
};

const openCloud = async (browser: Browser) => {
  await browser.waitFor("document.querySelector('.settings-nav')", "Settings");
  expect(
    await browser.evaluate<boolean>(openSettingsCategory("Cloud")),
    "Settings has no Cloud category",
  );
  await browser.waitFor(
    "document.querySelector('[data-testid=\"cloud-panel\"]')",
    "the Cloud panel",
  );
};

// Signed out, then a sign-in that is still waiting, then signed in, then out.
await withBrowser(
  {
    port: 41760,
    page: "cloud-test.html",
    query: "modal=settings&signedIn=0&holdSignIn=1",
  },
  async (browser) => {
    await openCloud(browser);
    expect(
      await browser.has("cloud-sign-in"),
      "signed out, there is no sign-in button",
    );
    expect(
      !(await browser.has("cloud-account")) &&
        !(await browser.has("cloud-sign-out")),
      "signed out, the panel shows an account or a sign-out",
    );
    expect(
      await browser.evaluate<boolean>(
        `document.querySelector('[data-testid="cloud-sign-in"]').disabled`,
      ),
      "Sign in is enabled with both fields empty",
    );
    await fits(browser, "signed out");
    await browser.screenshot("cloud-settings-signed-out");

    await browser.type("cloud-gateway-url", "http://127.0.0.1:8080");
    await browser.type("cloud-email", "dev@example.com");
    expect(
      !(await browser.evaluate<boolean>(
        `document.querySelector('[data-testid="cloud-sign-in"]').disabled`,
      )),
      "Sign in stays disabled with both fields filled",
    );
    await browser.click("cloud-sign-in");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-sign-in\"]')?.textContent.includes('Signing in')",
      "the signing-in label",
    );
    expect(
      await browser.evaluate<boolean>(
        `document.querySelector('[data-testid="cloud-sign-in"]').disabled &&
         document.querySelector('[data-testid="cloud-email"]').disabled`,
      ),
      "the form is still editable while signing in",
    );
    await browser.screenshot("cloud-settings-signing-in");
    const sent = await browser.requests();
    expect(
      JSON.stringify(sent) ===
        JSON.stringify([
          {
            cloudSignIn: {
              gatewayUrl: "http://127.0.0.1:8080",
              email: "dev@example.com",
            },
          },
        ]),
      `Sign in sent ${JSON.stringify(sent)}`,
    );

    await browser.evaluate("window.cloudFixture.releaseSignIn()");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-account\"]')",
      "the signed-in account",
    );
    const account = await browser.text("cloud-account");
    expect(
      account.includes("dev@example.com") && account.includes("127.0.0.1:8080"),
      `the account block reads "${account}"`,
    );
    expect(
      (await browser.attribute("cloud-connection", "data-connection")) ===
        "online",
      "the connection is not online after signing in",
    );
    expect(
      !(await browser.has("cloud-sign-in")) &&
        !(await browser.has("cloud-error")),
      "the sign-in form or an error shows once signed in",
    );
    await noSecrets(browser, "after signing in");
    await fits(browser, "signed in");
    await browser.screenshot("cloud-settings-signed-in");

    // MCP servers: name and host only, each off until turned on.
    await browser.waitFor(
      "document.querySelectorAll('[data-testid=\"cloud-mcp-server\"]').length === 2",
      "the MCP servers",
    );
    const servers = await browser.evaluate<
      { name: string; text: string; on: boolean }[]
    >(`[...document.querySelectorAll('[data-testid="cloud-mcp-server"]')].map((row) => ({
      name: row.dataset.name,
      text: row.textContent,
      on: row.querySelector('input').checked,
    }))`);
    expect(
      servers.every((one) => !one.on) &&
        servers.some((one) => one.text.includes("actions.zapier.com")),
      `the MCP servers should all start off, with their hosts: ${JSON.stringify(servers)}`,
    );
    expect(
      !(await browser.evaluate<boolean>(
        "document.body.innerHTML.includes('zk-SECRET') || document.body.innerHTML.includes('/mcp/')",
      )),
      "an MCP server's URL reached the window",
    );
    expect(
      (await browser.text("cloud-mcp-left-out")).includes("files"),
      "the servers that cannot go are not listed",
    );
    await browser.evaluate(
      `document.querySelector('[data-testid="cloud-mcp-server"][data-name="context7"] input').click()`,
    );
    await browser.waitFor(
      `document.querySelector('[data-testid="cloud-mcp-server"][data-name="context7"] input').checked`,
      "context7 turned on",
    );
    expect(
      (await browser.requests()).some(
        (one) =>
          JSON.stringify(one) ===
          '{"cloudMcpServerSet":{"name":"context7","on":true}}',
      ),
      "turning a server on sent the wrong call",
    );
    await fits(browser, "with MCP servers");
    await browser.screenshot("cloud-settings-mcp");

    await browser.click("cloud-sign-out");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-sign-in\"]')",
      "the sign-in form after signing out",
    );
    expect(
      (await browser.requests()).some((one) => "cloudSignOut" in one),
      "Sign out did not call cloudSignOut",
    );
    await noSecrets(browser, "after signing out");
  },
);

// Signed in from the start, and a refused sign-in on a fresh form.
await withBrowser(
  { port: 41762, page: "cloud-test.html", query: "modal=settings" },
  async (browser) => {
    await openCloud(browser);
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-account\"]')",
      "the account when already signed in",
    );
    await noSecrets(browser, "when already signed in");
    await browser.click("cloud-sign-out");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-sign-in\"]')",
      "the form after signing out",
    );
    await browser.type("cloud-gateway-url", "http://127.0.0.1:8080");
    await browser.type("cloud-email", "bad@example.com");
    await browser.click("cloud-sign-in");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"cloud-error\"]')",
      "the sign-in error",
    );
    const message = await browser.text("cloud-error");
    expect(
      message === "The gateway refused that email.",
      `the error reads "${message}"`,
    );
    expect(
      (await browser.evaluate<string>(
        `document.querySelector('[data-testid="cloud-error"]').getAttribute('role')`,
      )) === "alert",
      "the error is not announced as an alert",
    );
    expect(
      await browser.has("cloud-sign-in"),
      "the form went away after a refused sign-in",
    );
    expect(
      (await browser.text("cloud-email")) === "" &&
        (await browser.evaluate<string>(
          `document.querySelector('[data-testid="cloud-email"]').value`,
        )) === "bad@example.com",
      "the email was cleared after a refused sign-in",
    );
    await noSecrets(browser, "after a refused sign-in");
    await fits(browser, "sign-in error");
    await browser.screenshot("cloud-settings-error");
  },
);

console.log("cloud settings check passed");

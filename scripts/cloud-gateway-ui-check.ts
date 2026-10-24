/**
 * Settings › Cloud › Your own gateway, in a real browser against
 * `cloud-test.tsx`. Contexts show by name and server host, none chosen. A
 * chosen one is checked, then previewed; the install stays off until the
 * user types the context's name, gives an email, and, with a public
 * address, acknowledges the open dev login. The start call carries exactly
 * that. Progress and the end show in place. Text from the cluster is plain.
 * With no contexts there is Try it locally and the AWS guide; a failed
 * check blocks the preview; missing tools say how to install them.
 *
 *   bun run test:cloud-gateway-ui
 */
import {
  expect,
  openSettingsCategory,
  withBrowser,
  type Browser,
} from "./lib/browser-check";

const openGateway = async (browser: Browser) => {
  await browser.waitFor("document.querySelector('.settings-nav')", "Settings");
  expect(
    await browser.evaluate<boolean>(openSettingsCategory("Cloud")),
    "Settings has no Cloud category",
  );
  await browser.waitFor(
    "document.querySelector('[data-testid=\"gateway-install\"]')",
    "the Your own gateway part",
  );
  await browser.evaluate(
    "document.querySelector('[data-testid=\"gateway-install\"] > summary').click()",
  );
  await browser.waitFor(
    "window.requests.some((one) => 'gatewayInstallContexts' in one)",
    "the contexts call",
  );
  await Bun.sleep(200);
};

const calls = async (browser: Browser, name: string) =>
  (await browser.requests())
    .filter((one) => name in one)
    .map((one) => one[name] as Record<string, unknown>);

const disabled = (browser: Browser, testId: string) =>
  browser.evaluate<boolean>(
    `document.querySelector('[data-testid="${testId}"]').disabled`,
  );

const fits = async (browser: Browser, label: string) => {
  for (const height of [820, 560]) {
    await browser.resize(height);
    const seen = await browser.evaluate<{ sideways: boolean }>(`(() => {
      const part = document.querySelector('[data-testid="gateway-install"]');
      return { sideways: part.scrollWidth > part.clientWidth + 1 };
    })()`);
    expect(!seen.sideways, `${label} spills sideways at ${height}px`);
  }
  await browser.resize(820);
};

const EKS = "arn:aws:eks:eu-west-1:123456789012:cluster/team";

// The whole road on a cluster, with a public address.
await withBrowser(
  {
    port: 41860,
    page: "cloud-test.html",
    query: "modal=settings&signedIn=0&holdInstall=1",
  },
  async (browser) => {
    await openGateway(browser);
    const contexts = await browser.evaluate<
      { name: string; host: string; checked: boolean }[]
    >(`[...document.querySelectorAll('[data-testid="gateway-install-context"]')].map((row) => ({
      name: row.dataset.context,
      host: row.querySelector('small').textContent,
      checked: row.querySelector('input').checked,
    }))`);
    expect(
      contexts.length === 2 &&
        contexts[0]!.host === "ABCD1234.gr7.eu-west-1.eks.amazonaws.com" &&
        contexts.every((one) => !one.checked),
      `the contexts read ${JSON.stringify(contexts)}`,
    );
    expect(
      !(await browser.has("gateway-install-check")),
      "a check is offered before a context is chosen",
    );
    await browser.screenshot("cloud-gateway-contexts");

    await browser.evaluate(
      `document.querySelector('[data-context="${EKS}"] input').click()`,
    );
    await browser.type(
      "gateway-install-registry",
      "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
    );
    await browser.type("gateway-install-tag", "0.31.0");
    await browser.click("gateway-install-check");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"gateway-install-checks\"]')",
      "the preflight",
    );
    expect(
      JSON.stringify((await calls(browser, "gatewayInstallPreflight"))[0]) ===
        JSON.stringify({
          context: EKS,
          namespace: "daedalus",
          images: {
            registry: "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
            tag: "0.31.0",
          },
        }),
      `the preflight sent ${JSON.stringify(await calls(browser, "gatewayInstallPreflight"))}`,
    );
    await browser.click("gateway-install-preview");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"gateway-install-objects\"]')",
      "the dry run",
    );
    const text = await browser.text("gateway-install-dry-run");
    expect(
      text.includes("daedalus-gateway") && !text.includes("\u0007"),
      "the dry run does not list the objects, or keeps a control character",
    );

    // Off until email, the exact name, and the acknowledgement.
    expect(
      await disabled(browser, "gateway-install-start"),
      "install is on before anything is typed",
    );
    await browser.type("gateway-install-email", "me@example.com");
    await browser.type("gateway-install-confirm", "kind-daedalus");
    expect(
      await disabled(browser, "gateway-install-start"),
      "install is on with another context's name typed",
    );
    await browser.type("gateway-install-confirm", EKS);
    expect(
      !(await disabled(browser, "gateway-install-start")),
      "install stays off with the name typed",
    );
    await browser.type(
      "gateway-install-public-url",
      "https://daedalus.example.com",
    );
    expect(
      (await browser.has("gateway-install-acknowledge")) &&
        (await disabled(browser, "gateway-install-start")),
      "a public address does not ask for the acknowledgement",
    );
    await browser.click("gateway-install-acknowledge");
    expect(
      !(await disabled(browser, "gateway-install-start")),
      "install stays off after the acknowledgement",
    );
    await fits(browser, "the install form");
    await browser.evaluate(
      "(() => { const pane = document.querySelector('.settings-pane'); pane.scrollTop = pane.scrollHeight; })()",
    );
    await Bun.sleep(300);
    await browser.screenshot("cloud-gateway-ready");

    await browser.click("gateway-install-start");
    await browser.waitFor(
      'document.querySelector(\'[data-testid="gateway-install-progress"][data-phase="installing"]\')',
      "the progress",
    );
    expect(
      JSON.stringify((await calls(browser, "gatewayInstallStart"))[0]) ===
        JSON.stringify({
          context: EKS,
          namespace: "daedalus",
          images: {
            registry: "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
            tag: "0.31.0",
          },
          dryRunId: "dry-1",
          confirm: EKS,
          email: "me@example.com",
          publicUrl: "https://daedalus.example.com",
          acknowledgeDevLogin: true,
        }),
      `the start sent ${JSON.stringify(await calls(browser, "gatewayInstallStart"))}`,
    );
    await browser.evaluate(
      "(() => { const pane = document.querySelector('.settings-pane'); pane.scrollTop = pane.scrollHeight; })()",
    );
    await Bun.sleep(300);
    await browser.screenshot("cloud-gateway-installing");
    await browser.evaluate("window.cloudFixture.releaseInstall()");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"gateway-install-done\"]')",
      "the done line",
    );
    expect(
      (await browser.text("gateway-install-done")).includes(
        "http://127.0.0.1:58080",
      ) &&
        !(await browser.text("gateway-install-done")).includes("Only this Mac"),
      "the done line does not name the gateway, or says port-forward",
    );
    await browser.click("gateway-install-dismiss");
    await browser.waitFor(
      "window.requests.some((one) => 'gatewayInstallDismiss' in one)",
      "the dismiss call",
    );
  },
);

// A change after the preview takes it away; no public address needs no
// acknowledgement.
await withBrowser(
  { port: 41862, page: "cloud-test.html", query: "modal=settings&signedIn=0" },
  async (browser) => {
    await openGateway(browser);
    await browser.evaluate(
      `document.querySelector('[data-context="kind-daedalus"] input').click()`,
    );
    await browser.click("gateway-install-check");
    await browser.click("gateway-install-preview");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"gateway-install-dry-run\"]')",
      "the dry run",
    );
    await browser.type("gateway-install-namespace", "other");
    expect(
      !(await browser.has("gateway-install-dry-run")) &&
        !(await browser.has("gateway-install-checks")),
      "a new namespace keeps the old check and preview",
    );
    await browser.click("gateway-install-check");
    await browser.click("gateway-install-preview");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"gateway-install-dry-run\"]')",
      "the dry run again",
    );
    await browser.type("gateway-install-email", "me@example.com");
    await browser.type("gateway-install-confirm", "kind-daedalus");
    expect(
      !(await browser.has("gateway-install-acknowledge")) &&
        !(await disabled(browser, "gateway-install-start")),
      "with no public address the install still asks to acknowledge",
    );
  },
);

// No contexts: Try it locally and the guide.
await withBrowser(
  {
    port: 41864,
    page: "cloud-test.html",
    query: "modal=settings&signedIn=0&contexts=none",
  },
  async (browser) => {
    await openGateway(browser);
    expect(
      (await browser.has("gateway-install-empty")) &&
        (await disabled(browser, "gateway-install-try-local")),
      "no contexts shows no hint, or Try it locally runs with no email",
    );
    await browser.type("gateway-install-email", "me@example.com");
    await browser.screenshot("cloud-gateway-empty");
    await browser.click("gateway-install-aws-guide");
    await browser.waitFor(
      "window.requests.some((one) => 'gatewayInstallGuideOpen' in one)",
      "the guide call",
    );
    expect(
      !(await calls(browser, "openExternal")).length,
      "the AWS guide went to the web, where it is not published yet",
    );
    await browser.click("gateway-install-try-local");
    await browser.waitFor(
      'document.querySelector(\'[data-testid="gateway-install-progress"][data-phase="cluster"]\')',
      "the local progress",
    );
    expect(
      JSON.stringify(await calls(browser, "gatewayInstallLocal")) ===
        JSON.stringify([{ email: "me@example.com" }]),
      "Try it locally sent the wrong call",
    );
  },
);

// A failed check blocks the preview, and its detail is plain.
await withBrowser(
  {
    port: 41866,
    page: "cloud-test.html",
    query: "modal=settings&signedIn=0&preflight=fail",
  },
  async (browser) => {
    await openGateway(browser);
    await browser.evaluate(
      `document.querySelector('[data-context="kind-daedalus"] input').click()`,
    );
    await browser.click("gateway-install-check");
    await browser.waitFor(
      "document.querySelector('[data-testid=\"gateway-install-blocked\"]')",
      "the blocked note",
    );
    const checks = await browser.text("gateway-install-checks");
    expect(
      !(await browser.has("gateway-install-preview")) &&
        checks.includes("create clusterroles") &&
        !checks.includes("\u001b"),
      "a failed check offers the preview, or its detail is not plain",
    );
    await browser.evaluate(
      "(() => { const pane = document.querySelector('.settings-pane'); pane.scrollTop = pane.scrollHeight; })()",
    );
    await Bun.sleep(300);
    await browser.screenshot("cloud-gateway-blocked");
  },
);

// Missing tools say how to get them, and nothing can start.
await withBrowser(
  {
    port: 41868,
    page: "cloud-test.html",
    query: "modal=settings&signedIn=0&tools=missing",
  },
  async (browser) => {
    await openGateway(browser);
    const tools = await browser.text("gateway-install-tools");
    expect(
      tools.includes("helm is not installed") &&
        tools.includes("brew install helm") &&
        tools.includes("docker is not running"),
      `the tools read "${tools}"`,
    );
    expect(
      (await browser.evaluate<boolean>(
        "[...document.querySelectorAll('[data-testid=\"gateway-install-context\"] input')].every((one) => one.disabled)",
      )) && (await disabled(browser, "gateway-install-try-local")),
      "with helm missing a context or Try it locally can still be chosen",
    );
  },
);

console.log("cloud gateway check passed");

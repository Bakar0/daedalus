import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { GatewayInstallProgress } from "./GatewayInstall";

const noToken = async () => null;

describe("GatewayInstallProgress", () => {
  test("shows the log as plain lines, newest last", () => {
    const markup = renderToStaticMarkup(
      <GatewayInstallProgress
        install={{
          target: { kind: "cluster", context: "team", namespace: "daedalus" },
          phase: "installing",
          log: ["<b>helm</b> upgrade", "pulling\u001b[2J image"],
        }}
        onDismiss={() => {}}
        onRevealToken={noToken}
      />,
    );
    expect(markup).toContain('data-phase="installing"');
    expect(markup).toContain("&lt;b&gt;helm&lt;/b&gt; upgrade");
    expect(markup).not.toContain("\u001b");
    expect(markup).not.toContain("gateway-install-dismiss");
  });

  test("says only this Mac can reach a port-forwarded gateway", () => {
    const markup = renderToStaticMarkup(
      <GatewayInstallProgress
        install={{
          target: { kind: "local" },
          phase: "done",
          log: [],
          gatewayUrl: "http://127.0.0.1:58080",
          portForward: true,
        }}
        onDismiss={() => {}}
        onRevealToken={noToken}
      />,
    );
    expect(markup).toContain("http://127.0.0.1:58080");
    expect(markup).toContain("Only this Mac can reach it");
    expect(markup).toContain('data-testid="gateway-install-dismiss"');
  });

  test("a failure says why", () => {
    const markup = renderToStaticMarkup(
      <GatewayInstallProgress
        install={{
          target: { kind: "cluster", context: "team", namespace: "daedalus" },
          phase: "failed",
          log: [],
          message: "helm is not installed",
        }}
        onDismiss={() => {}}
        onRevealToken={noToken}
      />,
    );
    expect(markup).toContain("helm is not installed");
    expect(markup).toContain("Dismiss");
  });

  test("dev login off: installed, not signed in", () => {
    const markup = renderToStaticMarkup(
      <GatewayInstallProgress
        install={{
          target: { kind: "cluster", context: "team", namespace: "daedalus" },
          phase: "done",
          log: [],
          gatewayUrl: "https://daedalus.example.com",
          signedIn: false,
        }}
        onDismiss={() => {}}
        onRevealToken={noToken}
      />,
    );
    expect(markup).toContain("Dev login is off, so this Mac did not sign in");
    expect(markup).not.toContain("Signed in to");
  });

  test("lists the egress check, a failure marked", () => {
    const markup = renderToStaticMarkup(
      <GatewayInstallProgress
        install={{
          target: { kind: "cluster", context: "team", namespace: "daedalus" },
          phase: "done",
          log: [],
          gatewayUrl: "http://127.0.0.1:58080",
          egress: [
            {
              target: "169.254.169.254:80",
              want: "blocked",
              got: "open",
              result: "fail",
            },
            {
              target: "1.1.1.1:443",
              want: "open",
              got: "blocked",
              result: "warn",
            },
          ],
        }}
        onDismiss={() => {}}
        onRevealToken={noToken}
      />,
    );
    expect(markup).toContain('data-testid="gateway-install-egress"');
    expect(markup).toContain('data-status="fail"');
    expect(markup).toContain("workspaces are not fenced in");
    expect(markup).toContain('data-status="warn"');
    expect(markup).toContain("which is not a failure");
  });

  test("a token the Keychain refused waits behind a button", () => {
    const markup = renderToStaticMarkup(
      <GatewayInstallProgress
        install={{
          target: { kind: "cluster", context: "team", namespace: "daedalus" },
          phase: "done",
          log: [],
          gatewayUrl: "http://127.0.0.1:58080",
          adminTokenWaiting: true,
        }}
        onDismiss={() => {}}
        onRevealToken={noToken}
      />,
    );
    expect(markup).toContain("The Keychain did not take the admin token");
    expect(markup).toContain('data-testid="gateway-install-token-show"');
    expect(markup).not.toContain("gateway-install-token-value");
  });
});

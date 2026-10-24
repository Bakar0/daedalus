import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { GatewayInstallProgress } from "./GatewayInstall";

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
      />,
    );
    expect(markup).toContain("helm is not installed");
    expect(markup).toContain("Dismiss");
  });
});

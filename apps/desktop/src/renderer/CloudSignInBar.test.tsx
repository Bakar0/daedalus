import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CloudSignInDto } from "@daedalus/protocol";
import { CloudSignInPanel } from "./CloudSignInBar";

const render = (signIn: Partial<CloudSignInDto>) =>
  renderToStaticMarkup(
    <CloudSignInPanel
      busy={false}
      onDismiss={() => {}}
      onOpen={() => {}}
      signIn={{
        sessionId: "s1",
        kind: "claude",
        phase: "waiting",
        expiresAt: 0,
        ...signIn,
      }}
    />,
  );

describe("CloudSignInPanel", () => {
  test("a waiting page names its host and asks before opening it", () => {
    const markup = render({
      kind: "aws",
      requestId: "r1",
      host: "d-9a672d87aa.awsapps.com",
    });
    expect(markup).toContain('data-testid="cloud-signin-bar"');
    expect(markup).toContain("Sign in to AWS");
    expect(markup).toContain("d-9a672d87aa.awsapps.com");
    expect(markup).toContain('data-testid="cloud-signin-open"');
    expect(markup).toContain('data-testid="cloud-signin-dismiss"');
  });

  test("shows what is happening before and after the page", () => {
    expect(render({ phase: "starting" })).toContain("Signing in to Claude");
    expect(render({ phase: "starting" })).toContain(
      'data-testid="cloud-signin-progress"',
    );
    expect(render({ phase: "browser", host: "claude.com" })).toContain(
      "Finish signing in in your browser",
    );
    expect(render({ phase: "failed", message: "Type /login." })).toContain(
      "Type /login.",
    );
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CloudSignInBar } from "./CloudSignInBar";

describe("CloudSignInBar", () => {
  test("names the page's host and asks before opening it", () => {
    const markup = renderToStaticMarkup(
      <CloudSignInBar
        busy={false}
        color={null}
        offer={{
          requestId: "r1",
          sessionId: "s1",
          host: "d-9a672d87aa.awsapps.com",
          kind: "aws",
          expiresAt: 0,
        }}
        onDismiss={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(markup).toContain('data-testid="cloud-signin-bar"');
    expect(markup).toContain("AWS sign-in page");
    expect(markup).toContain("d-9a672d87aa.awsapps.com");
    expect(markup).toContain('data-testid="cloud-signin-open"');
    expect(markup).toContain('data-testid="cloud-signin-dismiss"');
  });
});

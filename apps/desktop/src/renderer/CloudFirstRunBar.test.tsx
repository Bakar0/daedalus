import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CloudFirstRunBar } from "./CloudFirstRunBar";

describe("CloudFirstRunBar", () => {
  test("tells a new cloud Claude session to sign in once in its terminal", () => {
    const markup = renderToStaticMarkup(
      <CloudFirstRunBar color={null} hostId="ws:c1" kind="default" />,
    );
    expect(markup).toContain('data-testid="cloud-first-run-note"');
    expect(markup).toContain("/login");
    expect(markup).toContain("ANTHROPIC_API_KEY");
    expect(markup).toContain('data-testid="cloud-first-run-dismiss"');
  });

  test("matches the account: AWS SSO for Bedrock, nothing for an API key", () => {
    expect(
      renderToStaticMarkup(
        <CloudFirstRunBar color={null} hostId="ws:c1" kind="bedrock" />,
      ),
    ).toContain("AWS SSO");
    expect(
      renderToStaticMarkup(
        <CloudFirstRunBar color={null} hostId="ws:c1" kind="api-key" />,
      ),
    ).toBe("");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CloudFirstRunBar } from "./CloudFirstRunBar";

describe("CloudFirstRunBar", () => {
  test("tells a new cloud Claude session to sign in once in its terminal", () => {
    const markup = renderToStaticMarkup(
      <CloudFirstRunBar color={null} hostId="ws:c1" />,
    );
    expect(markup).toContain('data-testid="cloud-first-run-note"');
    expect(markup).toContain("Sign in to Claude once");
    expect(markup).toContain('data-testid="cloud-first-run-dismiss"');
  });
});

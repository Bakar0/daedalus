import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SessionOpening } from "./SessionOpening";

const launch = {
  key: "k",
  workspaceId: "w",
  name: "n",
  tool: "claude" as const,
  startedAt: "2026-10-22T00:00:00.000Z",
  status: "starting" as const,
};

describe("SessionOpening", () => {
  test("a local session just starts", () => {
    const markup = renderToStaticMarkup(<SessionOpening launch={launch} />);
    expect(markup).toContain("Starting Claude…");
    expect(markup).not.toContain("cloud-preparing");
  });

  test("a cloud session shows how far its cloud workspace got", () => {
    const creating = renderToStaticMarkup(
      <SessionOpening
        launch={{ ...launch, cloud: true }}
        preparing={{ workspaceId: "w", phase: "creating" }}
      />,
    );
    expect(creating).toContain("Preparing the cloud workspace…");
    expect(creating).toContain("Making the workspace&#x27;s cloud copy");
    expect(creating).toContain('data-phase="creating"');
    const starting = renderToStaticMarkup(
      <SessionOpening
        launch={{ ...launch, cloud: true }}
        preparing={{ workspaceId: "w", phase: "starting" }}
      />,
    );
    expect(starting).toContain('data-state="done"');
    expect(starting).toContain("Starting its pod");
    const ready = renderToStaticMarkup(
      <SessionOpening launch={{ ...launch, cloud: true }} />,
    );
    expect(ready).toContain("Starting Claude…");
  });
});

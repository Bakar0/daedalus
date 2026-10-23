import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { COLOR_GRID, WorkspaceCloudSection } from "./SessionMenu";

describe("COLOR_GRID", () => {
  test("is five rows of ten distinct #rrggbb colors", () => {
    expect(COLOR_GRID).toHaveLength(50);
    expect(new Set(COLOR_GRID).size).toBe(50);
    for (const hex of COLOR_GRID) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    // The first row starts at red, the last row is grey.
    expect(COLOR_GRID[0]).toBe("#8c2121");
    for (const grey of COLOR_GRID.slice(40))
      expect(grey.slice(1, 3)).toBe(grey.slice(3, 5));
  });
});

describe("WorkspaceCloudSection", () => {
  const workspace = {
    workspaceId: "w1",
    cloudId: "c1",
    status: "running" as const,
    runnerOnline: true,
    reason: null,
    createdAt: "2026-10-20T10:00:00.000Z",
  };
  const cloud = { workspace };

  test("says how the cloud copy stands, with nothing to do", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCloudSection cloud={cloud} />,
    );
    expect(markup).toContain('data-status="running"');
    expect(markup).toContain("Cloud copy made");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Remove cloud copy");
  });

  test("a failed copy says why", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCloudSection
        cloud={{
          workspace: {
            ...workspace,
            status: "failed",
            reason: "The image could not be pulled",
          },
        }}
      />,
    );
    expect(markup).toContain("The image could not be pulled");
  });
});

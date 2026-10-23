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
  const cloud = { workspace, pending: false, onRemove() {} };

  test("says how the cloud copy stands and offers only Remove", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCloudSection cloud={cloud} />,
    );
    expect(markup).toContain('data-status="running"');
    expect(markup).toContain("Cloud copy made");
    expect(markup).toContain('data-testid="cloud-delete"');
    expect(markup).toContain("Remove cloud copy");
    expect(markup).not.toContain('data-testid="cloud-sleep"');
    expect(markup).not.toContain('data-testid="cloud-wake"');
  });

  test("a failed copy says why, and a failed removal too", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCloudSection
        cloud={{
          ...cloud,
          workspace: {
            ...workspace,
            status: "failed",
            reason: "The image could not be pulled",
          },
          error: "You may have at most 5 workspaces",
        }}
      />,
    );
    expect(markup).toContain("The image could not be pulled");
    expect(markup).toContain('data-testid="cloud-menu-error"');
  });
});

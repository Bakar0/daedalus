import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { COLOR_GRID, WorkspaceCloudItems } from "./SessionMenu";

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

describe("WorkspaceCloudItems", () => {
  const actions = {
    pending: false,
    onSleep() {},
    onWake() {},
    onDelete() {},
  };
  const workspace = {
    workspaceId: "w1",
    cloudId: "c1",
    status: "running" as const,
    runnerOnline: true,
    reason: null,
  };

  test("offers nothing until the workspace has a cloud workspace", () => {
    expect(renderToStaticMarkup(<WorkspaceCloudItems cloud={actions} />)).toBe(
      "",
    );
  });

  test("a running one shows its status, Sleep and Delete", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCloudItems cloud={{ ...actions, workspace }} />,
    );
    expect(markup).toContain('data-status="running"');
    expect(markup).toContain('data-testid="cloud-sleep"');
    expect(markup).not.toContain('data-testid="cloud-wake"');
    expect(markup).toContain('data-testid="cloud-delete"');
  });

  test("a sleeping one offers Wake instead of Sleep", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCloudItems
        cloud={{
          ...actions,
          workspace: { ...workspace, status: "sleeping", runnerOnline: false },
        }}
      />,
    );
    expect(markup).toContain("sleeping");
    expect(markup).toContain('data-testid="cloud-wake"');
    expect(markup).not.toContain('data-testid="cloud-sleep"');
  });

  test("a failed action's reason shows in the menu", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceCloudItems
        cloud={{
          ...actions,
          workspace,
          error: "You may have at most 5 workspaces",
        }}
      />,
    );
    expect(markup).toContain('data-testid="cloud-menu-error"');
    expect(markup).toContain("You may have at most 5 workspaces");
    expect(markup).not.toContain('role="menuitem"');
  });
});

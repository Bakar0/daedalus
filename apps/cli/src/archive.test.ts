import { describe, expect, test } from "vitest";
import type { Workspace } from "@daedalus/core";
import { approvedPaths, workspaceArchivedOrExplain } from "./archive";

describe("archiving from the CLI", () => {
  test("--approve takes a comma list", () => {
    expect(approvedPaths("app/CLAUDE.md, app/.mcp.json,")).toEqual([
      "app/CLAUDE.md",
      "app/.mcp.json",
    ]);
    expect(approvedPaths(undefined)).toBeUndefined();
    expect(approvedPaths(",")).toBeUndefined();
  });

  test("an archived workspace comes back as it is", () => {
    const workspace = { id: "w1" } as Workspace;
    expect(
      workspaceArchivedOrExplain({ status: "archived", workspace }, "w1"),
    ).toBe(workspace);
  });

  test("what the app would ask names the flag that answers it", () => {
    expect(() =>
      workspaceArchivedOrExplain(
        { status: "needsApproval", paths: ["CLAUDE.md", "repos/app/.envrc"] },
        "ops",
      ),
    ).toThrow(
      "Look at them, then run 'daedal workspace archive ops --approve CLAUDE.md,repos/app/.envrc'",
    );
    expect(() =>
      workspaceArchivedOrExplain(
        {
          status: "needsSmaller",
          items: [
            { what: "app", bytes: 2048 * 1048576, maxBytes: 1024 * 1048576 },
          ],
        },
        "ops",
      ),
    ).toThrow("app is 2048 MB, over 1024 MB");
  });
});

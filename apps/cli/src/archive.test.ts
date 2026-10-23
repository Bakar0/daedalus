import { describe, expect, test } from "vitest";
import type { AgentSession, Workspace } from "@daedalus/core";
import {
  approvedPaths,
  archivedOrExplain,
  workspaceArchivedOrExplain,
} from "./archive";

describe("archiving from the CLI", () => {
  test("--approve takes a comma list", () => {
    expect(approvedPaths("app/CLAUDE.md, app/.mcp.json,")).toEqual([
      "app/CLAUDE.md",
      "app/.mcp.json",
    ]);
    expect(approvedPaths(undefined)).toBeUndefined();
    expect(approvedPaths(",")).toBeUndefined();
  });

  test("an archived session or workspace comes back as it is", () => {
    const session = { id: "s1" } as AgentSession;
    expect(archivedOrExplain({ status: "archived", session }, "s1")).toBe(
      session,
    );
    const workspace = { id: "w1" } as Workspace;
    expect(
      workspaceArchivedOrExplain({ status: "archived", workspace }, "w1"),
    ).toBe(workspace);
  });

  test("what the app would ask names the flag that answers it", () => {
    expect(() =>
      archivedOrExplain(
        { status: "needsApproval", paths: ["app/CLAUDE.md", "app/.envrc"] },
        "s1",
      ),
    ).toThrow(
      "Look at them, then run 'daedal agent archive s1 --approve app/CLAUDE.md,app/.envrc'",
    );
    expect(() =>
      archivedOrExplain(
        { status: "needsConfirmation", reason: "The runner is offline" },
        "s1",
      ),
    ).toThrow(
      "This session cannot come home from the cloud: The runner is offline. To archive it with only what this Mac has, leaving the cloud's changes behind, run 'daedal agent archive s1 --without-cloud-changes'",
    );
    expect(() =>
      workspaceArchivedOrExplain(
        { status: "needsApproval", sessionId: "s2", paths: ["app/CLAUDE.md"] },
        "ops",
      ),
    ).toThrow("'daedal agent archive s2 --approve app/CLAUDE.md'");
    expect(() =>
      workspaceArchivedOrExplain(
        { status: "needsConfirmation", sessionId: "s2", reason: "gone" },
        "ops",
      ),
    ).toThrow("'daedal workspace archive ops --without-cloud-changes'");
  });
});

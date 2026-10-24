import { describe, expect, test } from "vitest";
import type { Workspace } from "@daedalus/core";
import { workspaceArchivedOrExplain } from "./archive";

describe("archiving from the CLI", () => {
  test("an archived workspace comes back as it is", () => {
    const workspace = { id: "w1" } as Workspace;
    expect(
      workspaceArchivedOrExplain({ status: "archived", workspace }, "w1"),
    ).toBe(workspace);
  });

  test("one too big to come home says what is over the cap", () => {
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

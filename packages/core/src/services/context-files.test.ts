import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentSession, Workspace } from "../domain";
import {
  JOURNAL_COMPACT_BYTES,
  largeFiles,
  TEAM_COMPACT_BYTES,
} from "./context-files";

describe("largeFiles", () => {
  test("lists only journals and team files past their compact size", async () => {
    const root = await mkdtemp(join(tmpdir(), "daedalus-large-files-"));
    try {
      const big = join(root, "big");
      const small = join(root, "small");
      const lead = join(root, "lead");
      for (const path of [big, small, lead]) await mkdir(path);
      await writeFile(
        join(big, "JOURNAL.md"),
        "x".repeat(JOURNAL_COMPACT_BYTES + 1),
      );
      await writeFile(join(small, "JOURNAL.md"), "x".repeat(10));
      await writeFile(
        join(lead, "TEAM.md"),
        "x".repeat(TEAM_COMPACT_BYTES + 1),
      );
      const workspace = (id: string, path: string) =>
        ({ id, path, archivedAt: null }) as Workspace;
      const found = largeFiles(
        [
          workspace("w-big", big),
          workspace("w-small", small),
          // No journal at all is not an error.
          workspace("w-none", join(root, "missing")),
          { ...workspace("w-archived", big), archivedAt: "then" },
        ],
        [
          {
            id: "s-lead",
            workspaceId: "w-big",
            workingDirectory: lead,
            archivedAt: null,
          } as AgentSession,
        ],
      );
      expect(found).toEqual([
        {
          kind: "journal",
          workspaceId: "w-big",
          sessionId: null,
          bytes: JOURNAL_COMPACT_BYTES + 1,
        },
        {
          kind: "team",
          workspaceId: "w-big",
          sessionId: "s-lead",
          bytes: TEAM_COMPACT_BYTES + 1,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "vitest";
import type { Workspace } from "../domain";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import { SessionArchive } from "./session-archive";
import type { WorkspaceMoveResult, WorkspaceMoves } from "./workspace-move";
import type { WorkspaceService } from "./workspaces";

function setup(options: {
  place?: "cloud";
  linked?: boolean;
  move?: () => Promise<WorkspaceMoveResult>;
}) {
  const calls: string[] = [];
  let workspace = {
    id: "w1",
    name: "Shop",
    slug: "shop",
    archivedAt: null,
    ...(options.place ? { place: options.place } : {}),
  } as unknown as Workspace;
  const workspaceMoves = {
    move: async (input: {
      to: string;
      stopWorking?: boolean;
      approved?: string[];
    }) => {
      calls.push(
        `move ${input.to} stop=${input.stopWorking} approved=${input.approved?.join(",") ?? ""}`,
      );
      const result = await options.move!();
      if (result.status === "moved") {
        const { place: _place, ...home } = workspace;
        workspace = home as Workspace;
      }
      return result;
    },
    dismiss: () => calls.push("dismiss"),
  } as unknown as WorkspaceMoves;
  const archive = new SessionArchive({
    repositories: {
      cloudWorkspaceId: () => (options.linked ? "c1" : undefined),
    } as unknown as SqliteRepositories,
    agents: {
      archive: async (id: string) => {
        calls.push(`archive session ${id}`);
        return { id };
      },
    } as unknown as AgentService,
    workspaces: {
      get: async () => workspace,
      archive: async () => {
        calls.push(`archive workspace place=${workspace.place ?? "mac"}`);
        workspace = { ...workspace, archivedAt: "now" };
        return workspace;
      },
    } as unknown as WorkspaceService,
    workspaceMoves,
    cloud: {
      delete: async () => {
        calls.push("delete cloud copy");
      },
    },
  });
  return { archive, calls };
}

describe("archiving where the cloud is involved", () => {
  test("a workspace in the cloud comes home, its copy is deleted, then it is archived", async () => {
    const s = setup({
      place: "cloud",
      linked: true,
      move: async () => ({
        status: "moved",
        workspace: {} as Workspace,
        notice: "Back on this Mac.",
      }),
    });
    expect((await s.archive.archiveWorkspace({ reference: "w1" })).status).toBe(
      "archived",
    );
    expect(s.calls).toEqual([
      "move mac stop=true approved=",
      "dismiss",
      "delete cloud copy",
      "archive workspace place=mac",
    ]);
  });

  test("steering files are asked about, and nothing is archived or deleted", async () => {
    const s = setup({
      place: "cloud",
      linked: true,
      move: async () => ({ status: "needsApproval", paths: ["CLAUDE.md"] }),
    });
    expect(await s.archive.archiveWorkspace({ reference: "w1" })).toEqual({
      status: "needsApproval",
      paths: ["CLAUDE.md"],
    });
    expect(s.calls).toEqual(["move mac stop=true approved="]);

    const t = setup({
      place: "cloud",
      linked: true,
      move: async () => ({ status: "moved", workspace: {} as Workspace }),
    });
    await t.archive.archiveWorkspace({
      reference: "w1",
      approved: ["CLAUDE.md"],
    });
    expect(t.calls[0]).toBe("move mac stop=true approved=CLAUDE.md");
  });

  test("a workspace that cannot come home is not archived, and its copy stays", async () => {
    const s = setup({
      place: "cloud",
      linked: true,
      move: async () => {
        throw new Error("The runner is offline");
      },
    });
    await expect(
      s.archive.archiveWorkspace({ reference: "w1" }),
    ).rejects.toThrow(
      "Shop could not come home from the cloud, so it is not archived: The runner is offline",
    );
    expect(s.calls).toEqual(["move mac stop=true approved="]);
  });

  test("a workspace on this Mac with a cloud copy asleep has it deleted, unasked", async () => {
    const s = setup({ linked: true });
    await s.archive.archiveWorkspace({ reference: "w1" });
    expect(s.calls).toEqual([
      "delete cloud copy",
      "archive workspace place=mac",
    ]);
  });

  test("a session archives where it runs", async () => {
    const s = setup({});
    await s.archive.archiveSession({ sessionId: "s1" });
    expect(s.calls).toEqual(["archive session s1"]);
  });
});

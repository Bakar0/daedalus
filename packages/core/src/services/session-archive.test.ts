import { describe, expect, test } from "vitest";
import type { AgentSession } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import { cloudHostId } from "./cloud-launch";
import { SessionArchive } from "./session-archive";
import type { SessionMoveResult, SessionMoves } from "./session-move";
import type { WorkspaceService } from "./workspaces";

const CLOUD = "11111111-1111-4111-8111-111111111111";
const MAC_FOLDER = "/w/worktrees/unassigned/claude-1";

function setup(move: () => Promise<SessionMoveResult>) {
  let row = {
    id: "s1",
    workspaceId: "w1",
    hostId: cloudHostId(CLOUD),
    status: "running",
    workingDirectory: "worktrees/unassigned/claude-1",
    archivedAt: null,
  } as unknown as AgentSession;
  const calls: string[] = [];
  const agents = {
    get: async () => row,
    archive: async (id: string, force?: boolean) => {
      calls.push(`archive ${id} force=${force} host=${row.hostId}`);
      row = { ...row, archivedAt: "now" };
      return row;
    },
  } as unknown as AgentService;
  const moves = {
    move: async (input: { approved?: string[] }) => {
      calls.push(`move ${input.approved?.join(",") ?? ""}`);
      const result = await move();
      if (result.status === "moved") row = { ...result.session };
      return result;
    },
    dismiss: () => calls.push("dismiss"),
    movedFrom: async () => MAC_FOLDER,
    forget: async () => {
      calls.push("forget");
    },
  } as unknown as SessionMoves;
  const archive = new SessionArchive({
    repositories: {
      updateAgent: (agent: AgentSession) => {
        row = agent;
      },
    } as unknown as SqliteRepositories,
    agents,
    workspaces: {} as WorkspaceService,
    moves,
    cloud: { delete: async () => {} },
  });
  return { archive, calls, row: () => row };
}

describe("archiving a cloud session", () => {
  test("moves it home first, then archives it as this Mac's", async () => {
    const s = setup(async () => ({
      status: "moved",
      session: {
        id: "s1",
        hostId: null,
        workingDirectory: MAC_FOLDER,
      } as unknown as AgentSession,
    }));
    const result = await s.archive.archiveSession({ sessionId: "s1" });
    expect(result.status).toBe("archived");
    expect(s.calls).toEqual([
      "move ",
      "dismiss",
      "archive s1 force=undefined host=null",
    ]);
  });

  test("files that steer an agent are asked about, and nothing is archived", async () => {
    const s = setup(async () => ({
      status: "needsApproval",
      paths: ["app/CLAUDE.md"],
    }));
    expect(await s.archive.archiveSession({ sessionId: "s1" })).toEqual({
      status: "needsApproval",
      paths: ["app/CLAUDE.md"],
    });
    expect(s.row().archivedAt).toBeNull();
  });

  test("a pod that cannot be reached asks, then archives what this Mac has", async () => {
    const s = setup(async () => {
      throw new DaedalusError(
        "DEPENDENCY",
        "The cloud workspace started, but its runner did not connect in time",
      );
    });
    expect(await s.archive.archiveSession({ sessionId: "s1" })).toEqual({
      status: "needsConfirmation",
      reason:
        "The cloud workspace started, but its runner did not connect in time",
    });
    expect(s.row().archivedAt).toBeNull();

    const result = await s.archive.archiveSession({
      sessionId: "s1",
      withoutCloudChanges: true,
    });
    expect(result.status).toBe("archived");
    expect(s.calls.slice(-2)).toEqual([
      "forget",
      "archive s1 force=true host=null",
    ]);
    expect(s.row()).toMatchObject({
      hostId: null,
      workingDirectory: MAC_FOLDER,
      status: "lost",
    });
  });
});

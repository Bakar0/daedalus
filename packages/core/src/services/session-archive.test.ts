import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@daedalus/platform";
import type { AgentSession } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import { cloudHostId } from "./cloud-launch";
import { SessionArchive } from "./session-archive";
import type { SessionHosts } from "./session-hosts";
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
      // As the database does: host and folder change only through
      // setAgentPlace.
      updateAgent: (agent: AgentSession) => {
        row = {
          ...agent,
          hostId: row.hostId,
          workingDirectory: row.workingDirectory,
        };
      },
      setAgentPlace: (
        _id: string,
        place: { hostId: string | null; workingDirectory: string },
      ) => {
        row = { ...row, ...place };
      },
    } as unknown as SqliteRepositories,
    agents,
    workspaces: {} as WorkspaceService,
    moves,
    cloud: {
      delete: async () => {},
      prepareForSession: async () => cloudHostId(CLOUD),
      sleep: async () => {},
      get: async () => ({}),
    },
    hosts: {} as SessionHosts,
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

describe("archiving a workspace with a cloud copy", () => {
  let pod: string;
  beforeEach(async () => {
    pod = await mkdtemp(join(tmpdir(), "daedalus-archive-pod-"));
  });
  afterEach(async () => {
    await rm(pod, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
    });

  async function repository(name: string, cameHome: boolean) {
    const dir = join(pod, name);
    await mkdir(dir, { recursive: true });
    await git(dir, "init", "-q");
    await writeFile(join(dir, "f.txt"), "x\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "x");
    if (cameHome)
      await git(dir, "update-ref", `refs/daedalus/moves/${CLOUD}/last`, "HEAD");
  }

  function setup(options: { gone?: boolean } = {}) {
    const calls: string[] = [];
    let linked = true;
    let archivedAt: string | null = null;
    const archive = new SessionArchive({
      repositories: {
        cloudWorkspaceId: () => (linked ? CLOUD : undefined),
        listAgents: () => [
          {
            id: "s9",
            name: "Old\u0007\u0085\u202e one",
            hostId: cloudHostId(CLOUD),
            archivedAt: "earlier",
          },
        ],
      } as unknown as SqliteRepositories,
      agents: {} as AgentService,
      workspaces: {
        get: async () => ({ id: "w1", archivedAt }),
        archive: async () => {
          calls.push("archive workspace");
          archivedAt = "now";
          return { id: "w1", archivedAt };
        },
      } as unknown as WorkspaceService,
      moves: {} as SessionMoves,
      cloud: {
        delete: async () => {
          calls.push("delete copy");
          linked = false;
        },
        prepareForSession: async () => cloudHostId(CLOUD),
        sleep: async () => {
          calls.push("sleep copy");
        },
        get: async () => {
          if (options.gone)
            throw new DaedalusError("NOT_FOUND", "gone", {
              gatewayCode: "NOT_FOUND",
            });
          return {};
        },
      },
      hosts: {
        get: () => ({
          run: async ({
            executable,
            args,
          }: {
            executable: string;
            args: string[];
          }) => runCommand(executable, args, { cwd: pod }),
          readFile: async () => undefined,
          writeFiles: async () => {},
        }),
      } as unknown as SessionHosts,
    });
    return { archive, calls };
  }

  test("asks before deleting work nothing brought home, naming it", async () => {
    await repository("app", true);
    await repository("scratch", false);
    await writeFile(join(pod, "notes.txt"), "loose\n");
    await mkdir(join(pod, ".home"));
    await mkdir(join(pod, "worktrees"));
    const s = setup();
    const asked = await s.archive.archiveWorkspace({ reference: "w1" });
    expect(asked).toEqual({
      status: "needsCloudDecision",
      lost: [
        'the conversation of "Old??? one", archived without coming home',
        "the repository scratch, which did not come home",
        "notes.txt outside git in the cloud workspace",
      ],
    });
    expect(s.calls).toEqual([]);

    const kept = await s.archive.archiveWorkspace({
      reference: "w1",
      cloudCopy: "keep",
    });
    expect(kept.status).toBe("archived");
    expect(s.calls).toEqual(["sleep copy", "archive workspace"]);
  });

  test("deletes at once when everything came home, or the copy is gone", async () => {
    await repository("app", true);
    const s = setup({ gone: false });
    // Only the conversation of the session archived without coming home.
    const asked = await s.archive.archiveWorkspace({ reference: "w1" });
    expect(asked.status).toBe("needsCloudDecision");
    const deleted = await s.archive.archiveWorkspace({
      reference: "w1",
      cloudCopy: "delete",
    });
    expect(deleted.status).toBe("archived");
    expect(s.calls).toEqual(["delete copy", "archive workspace"]);

    const gone = setup({ gone: true });
    expect(
      (await gone.archive.archiveWorkspace({ reference: "w1" })).status,
    ).toBe("archived");
    expect(gone.calls).toEqual(["delete copy", "archive workspace"]);
  });
});

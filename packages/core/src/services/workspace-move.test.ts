import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type {
  AgentSession,
  SessionWorktree,
  WorkspaceRepository,
} from "../domain";
import type { SqliteRepositories, WorkspacePlace } from "../repositories";
import type { AgentService } from "./agents";
import { cloudHostId } from "./cloud-launch";
import { claudeProjectKey, LocalMoveSide, type PodAccess } from "./move-side";
import { podSessionInstructions } from "./cloud-folder";
import { sessionInstructionsTemplate } from "./workspace-content";
import { unpackFromPod } from "./workspace-move-files";
import { MOVED_HOME_NOTICE, WorkspaceMoves } from "./workspace-move";
import type { SessionHosts } from "./session-hosts";
import type { WorkspaceService } from "./workspaces";

const SESSION = "5e55a0c1-0000-4000-8000-000000000001";
const CODEX = "5e55a0c1-0000-4000-8000-000000000002";
const CLOUD = "c10d0000-0000-4000-8000-000000000002";
const HOST = cloudHostId(CLOUD);
const FOLDER = "worktrees/unassigned/claude-1";

let root: string;

const git = async (cwd: string, ...args: string[]) => {
  const result = await runCommand(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd },
  );
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A pod whose workspace root is a folder, its commands run on this Mac. */
const fakePod = (podRoot: string): PodAccess => ({
  run: async ({ cwd, executable, args, env }) => {
    const result = await runCommand(executable, args, {
      cwd: join(podRoot, cwd),
      ...(env ? { env } : {}),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
  readFile: async (path) => {
    try {
      return new Uint8Array(await readFile(join(podRoot, path)));
    } catch {
      return undefined;
    }
  },
  writeFiles: async (files) => {
    for (const file of files) {
      await mkdir(dirname(join(podRoot, file.path)), { recursive: true });
      await writeFile(join(podRoot, file.path), file.contents);
    }
  },
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function setup() {
  const base = await mkdtemp(join(root, "setup-"));
  const workspacePath = join(base, "workspace");
  const library = join(base, "library", "app.git");
  const podRoot = join(base, "pod");
  const macProjects = join(base, "claude", "projects");
  const macFolder = join(workspacePath, FOLDER);
  const macTree = join(macFolder, "app");
  const reference = join(workspacePath, "repos", "app");
  await mkdir(podRoot, { recursive: true });
  await mkdir(macFolder, { recursive: true });

  // A library with one commit on main, as the repository library clones.
  const seed = join(base, "seed");
  await mkdir(seed, { recursive: true });
  await git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, ".gitignore"), "ignored.txt\n");
  await writeFile(join(seed, "a.txt"), "one\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "first");
  await git(base, "clone", "-q", "--bare", seed, library);
  await git(library, "worktree", "add", "-q", "--detach", reference, "main");
  await git(library, "worktree", "add", "-q", "-b", "feature", macTree, "main");
  // Work in progress of every kind.
  await writeFile(join(macTree, "a.txt"), "one\nstaged\n");
  await git(macTree, "add", "a.txt");
  await writeFile(join(macTree, "a.txt"), "one\nstaged\nunstaged\n");
  await writeFile(join(macTree, "new.txt"), "untracked\n");
  await writeFile(join(macTree, "ignored.txt"), "stays on the Mac\n");

  // Files outside git.
  await writeFile(join(workspacePath, "BRIEF.md"), "the brief\n");
  await writeFile(join(workspacePath, "CLAUDE.md"), "instructions\n");
  await mkdir(join(workspacePath, "artifacts"));
  await writeFile(join(workspacePath, "artifacts", "notes.md"), "notes\n");
  await writeFile(join(macFolder, "AGENTS.md"), "session instructions\n");
  await mkdir(join(workspacePath, ".daedalus"));
  await writeFile(join(workspacePath, ".daedalus", "workspace.json"), "{}\n");

  const project = join(macProjects, claudeProjectKey(macFolder));
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, `${SESSION}.jsonl`),
    [
      JSON.stringify({ type: "permission-mode", permissionMode: "plan" }),
      JSON.stringify({ type: "user", cwd: macFolder, message: "hello" }),
    ].join("\n") + "\n",
  );

  const repository = {
    id: "r1",
    workspaceId: "w1",
    name: "app",
    canonicalPath: library,
    access: "write",
    libraryRepositoryId: "lib1",
    referencePath: reference,
    baseBranch: "main",
    baseCommit: null,
    status: "ready",
  } as unknown as WorkspaceRepository;
  const worktree: SessionWorktree = {
    sessionId: SESSION,
    repositoryId: "r1",
    path: macTree,
    branchName: "feature",
    createdAt: new Date().toISOString(),
  };
  const sessions = new Map<string, AgentSession>();
  sessions.set(SESSION, {
    id: SESSION,
    name: "Claude one",
    workspaceId: "w1",
    kind: "agent",
    provider: "claude",
    status: "running",
    hostId: null,
    workingDirectory: macFolder,
    providerSessionId: SESSION,
    archivedAt: null,
    tmuxSession: "daedalus_x",
  } as unknown as AgentSession);
  let place: WorkspacePlace = { place: "mac", notice: null };
  const starts: {
    id: string;
    hostId: string | null;
    cwd: string;
    mode?: string;
  }[] = [];
  const activity: Record<string, string> = {};
  const pod = fakePod(podRoot);
  const agents = {
    stopForMove: async (id: string) => {
      const stopped = { ...sessions.get(id)!, status: "exited" as const };
      sessions.set(id, stopped);
      return stopped;
    },
    resumeAfterMove: async (agent: AgentSession, mode?: string) => {
      starts.push({
        id: agent.id,
        hostId: agent.hostId ?? null,
        cwd: agent.workingDirectory,
        ...(mode ? { mode } : {}),
      });
      const running = { ...agent, status: "running" as const };
      sessions.set(agent.id, running);
      return running;
    },
    claudeProjectsDirectory: () => macProjects,
  } as unknown as AgentService;
  const slept: string[] = [];
  const moves = new WorkspaceMoves({
    config: {
      home: join(base, "home"),
      agents: {},
    } as unknown as DaedalusConfig,
    repositories: {
      workspacePlace: () => place,
      setWorkspacePlace: (
        _id: string,
        next: WorkspacePlace,
        moved: {
          id: string;
          hostId: string | null;
          workingDirectory: string;
        }[],
      ) => {
        place = next;
        for (const item of moved)
          sessions.set(item.id, {
            ...sessions.get(item.id)!,
            hostId: item.hostId,
            workingDirectory: item.workingDirectory,
          });
      },
      listAgents: () => [...sessions.values()],
      findAgent: (id: string) => sessions.get(id),
      listWorkspaceRepositories: () => [repository],
      listSessionWorktrees: () => [worktree],
      cloudWorkspaceId: () => CLOUD,
    } as unknown as SqliteRepositories,
    workspaces: {
      getActive: async () => ({ id: "w1", path: workspacePath }),
    } as unknown as WorkspaceService,
    agents,
    hosts: { get: () => pod } as unknown as SessionHosts,
    cloud: {
      prepareForSession: async () => HOST,
      sleep: async (id: string) => slept.push(id),
    },
    terminals: { closeInside: async () => undefined },
    activity: async (id) => activity[id] as never,
    pollMs: 5,
    turnTimeoutMs: 2_000,
    podRoot,
  });
  return {
    moves,
    sessions,
    starts,
    activity,
    slept,
    place: () => place,
    workspacePath,
    podRoot,
    macTree,
    macFolder,
    macProjects,
    library,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "daedalus-workspace-move-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("moving a workspace", () => {
  test("carries worktrees, files and conversations to the cloud and home again", async () => {
    const s = await setup();
    const result = await s.moves.move({ workspace: "w1", to: "cloud" });
    expect(result.status).toBe("moved");
    expect(s.place().place).toBe("cloud");
    expect(s.sessions.get(SESSION)).toMatchObject({
      hostId: HOST,
      workingDirectory: FOLDER,
      status: "running",
    });
    expect(s.starts).toEqual([
      { id: SESSION, hostId: HOST, cwd: FOLDER, mode: "plan" },
    ]);

    // Git: the session's worktree with its work, the reference detached.
    const podTree = join(s.podRoot, FOLDER, "app");
    expect(await git(podTree, "branch", "--show-current")).toBe("feature");
    expect(await readFile(join(podTree, "a.txt"), "utf8")).toBe(
      "one\nstaged\nunstaged\n",
    );
    expect(await git(podTree, "show", ":a.txt")).toBe("one\nstaged");
    expect(await readFile(join(podTree, "new.txt"), "utf8")).toBe(
      "untracked\n",
    );
    expect(await exists(join(podTree, "ignored.txt"))).toBe(false);
    const podReference = join(s.podRoot, "repos", "app");
    expect(await git(podReference, "branch", "--show-current")).toBe("");
    expect(await readFile(join(podReference, "a.txt"), "utf8")).toBe("one\n");
    expect(
      await git(
        podTree,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ),
    ).toBe(await realpath(join(s.podRoot, ".daedalus", "library", "r1.git")));

    // Files outside git, and the workspace's metadata.
    expect(await readFile(join(s.podRoot, "BRIEF.md"), "utf8")).toBe(
      "the brief\n",
    );
    expect(
      await readFile(join(s.podRoot, "artifacts", "notes.md"), "utf8"),
    ).toBe("notes\n");
    expect(await readFile(join(s.podRoot, FOLDER, "AGENTS.md"), "utf8")).toBe(
      "session instructions\n",
    );
    expect(await exists(join(s.podRoot, ".daedalus", "workspace.json"))).toBe(
      true,
    );

    // The conversation, its folder rewritten for the pod.
    const podFolder = join("/workspace", FOLDER);
    const podTranscript = await readFile(
      join(
        s.podRoot,
        ".home/.claude/projects",
        claudeProjectKey(podFolder),
        `${SESSION}.jsonl`,
      ),
      "utf8",
    );
    expect(podTranscript).toContain(`"cwd":"${podFolder}"`);

    // Work in the cloud: a commit, a change, a deleted and a new file.
    await writeFile(join(podTree, "a.txt"), "cloud\n");
    await git(podTree, "commit", "-q", "-am", "from the cloud");
    await writeFile(join(podTree, "cloud.txt"), "made in the cloud\n");
    await writeFile(join(s.podRoot, "BRIEF.md"), "the brief, edited\n");
    await rm(join(s.podRoot, "artifacts", "notes.md"));
    await writeFile(join(s.podRoot, "artifacts", "new.md"), "new\n");
    await writeFile(
      join(
        s.podRoot,
        ".home/.claude/projects",
        claudeProjectKey(podFolder),
        `${SESSION}.jsonl`,
      ),
      podTranscript +
        JSON.stringify({ type: "user", cwd: podFolder, message: "later" }) +
        "\n",
    );
    s.starts.length = 0;

    const home = await s.moves.move({ workspace: "w1", to: "mac" });
    expect(home).toMatchObject({ status: "moved", notice: MOVED_HOME_NOTICE });
    expect(s.place().place).toBe("mac");
    expect(s.sessions.get(SESSION)).toMatchObject({
      hostId: null,
      workingDirectory: s.macFolder,
    });
    expect(s.starts).toEqual([
      { id: SESSION, hostId: null, cwd: s.macFolder, mode: "default" },
    ]);
    expect(s.slept).toEqual(["w1"]);
    expect(await git(s.macTree, "log", "-1", "--format=%s")).toBe(
      "from the cloud",
    );
    expect(await readFile(join(s.macTree, "cloud.txt"), "utf8")).toBe(
      "made in the cloud\n",
    );
    expect(await readFile(join(s.macTree, "ignored.txt"), "utf8")).toBe(
      "stays on the Mac\n",
    );
    expect(await readFile(join(s.workspacePath, "BRIEF.md"), "utf8")).toBe(
      "the brief, edited\n",
    );
    expect(await exists(join(s.workspacePath, "artifacts", "notes.md"))).toBe(
      false,
    );
    expect(
      await readFile(join(s.workspacePath, "artifacts", "new.md"), "utf8"),
    ).toBe("new\n");
    expect(
      await exists(join(s.workspacePath, ".daedalus", "workspace.json")),
    ).toBe(true);
    const macTranscript = await readFile(
      join(s.macProjects, claudeProjectKey(s.macFolder), `${SESSION}.jsonl`),
      "utf8",
    );
    expect(macTranscript).toContain(`"cwd":"${s.macFolder}"`);
    expect(macTranscript).toContain('"message":"later"');
    expect(macTranscript).not.toContain('"cwd":"/workspace/');

    // And again: the second trip sends what is new.
    s.starts.length = 0;
    await writeFile(join(s.macTree, "second.txt"), "second\n");
    expect((await s.moves.move({ workspace: "w1", to: "cloud" })).status).toBe(
      "moved",
    );
    expect(await readFile(join(podTree, "second.txt"), "utf8")).toBe(
      "second\n",
    );
    expect(await exists(join(s.podRoot, "artifacts", "notes.md"))).toBe(false);
  });

  test("Daedalus's own session instructions name each side's paths, unasked", async () => {
    const s = await setup();
    await writeFile(
      join(s.macFolder, "AGENTS.md"),
      sessionInstructionsTemplate(s.workspacePath),
    );
    await s.moves.move({ workspace: "w1", to: "cloud" });
    expect(await readFile(join(s.podRoot, FOLDER, "AGENTS.md"), "utf8")).toBe(
      podSessionInstructions(),
    );
    expect(
      await readFile(join(s.podRoot, ".daedalus", "workspace.json"), "utf8"),
    ).toBe("{}\n");
    const home = await s.moves.move({ workspace: "w1", to: "mac" });
    expect(home.status).toBe("moved");
    expect(await readFile(join(s.macFolder, "AGENTS.md"), "utf8")).toBe(
      sessionInstructionsTemplate(s.workspacePath),
    );
  });

  test("asks before steering files from the cloud come home", async () => {
    const s = await setup();
    await s.moves.move({ workspace: "w1", to: "cloud" });
    await writeFile(join(s.podRoot, "CLAUDE.md"), "do something else\n");
    const podTree = join(s.podRoot, FOLDER, "app");
    await mkdir(join(podTree, ".claude"));
    await writeFile(join(podTree, ".claude", "settings.json"), "{}\n");
    s.starts.length = 0;

    const asked = await s.moves.move({ workspace: "w1", to: "mac" });
    expect(asked).toEqual({
      status: "needsApproval",
      paths: ["CLAUDE.md", `${FOLDER}/app/.claude/settings.json`],
    });
    // Nothing stopped, nothing moved.
    expect(s.starts).toEqual([]);
    expect(s.place().place).toBe("cloud");
    expect(s.moves.list()).toEqual([]);

    const moved = await s.moves.move({
      workspace: "w1",
      to: "mac",
      approved: ["CLAUDE.md", `${FOLDER}/app/.claude/settings.json`],
    });
    expect(moved.status).toBe("moved");
    expect(await readFile(join(s.workspacePath, "CLAUDE.md"), "utf8")).toBe(
      "do something else\n",
    );
  });

  test("a conversation the pod rewrote does not come home, and the workspace stays", async () => {
    const s = await setup();
    await s.moves.move({ workspace: "w1", to: "cloud" });
    const podFolder = join("/workspace", FOLDER);
    await writeFile(
      join(
        s.podRoot,
        ".home/.claude/projects",
        claudeProjectKey(podFolder),
        `${SESSION}.jsonl`,
      ),
      JSON.stringify({ type: "user", cwd: podFolder, message: "forged" }) +
        "\n",
    );
    s.starts.length = 0;
    await expect(s.moves.move({ workspace: "w1", to: "mac" })).rejects.toThrow(
      "changed, not only added to",
    );
    expect(s.place().place).toBe("cloud");
    expect(s.starts).toEqual([{ id: SESSION, hostId: HOST, cwd: FOLDER }]);
    const macTranscript = await readFile(
      join(s.macProjects, claudeProjectKey(s.macFolder), `${SESSION}.jsonl`),
      "utf8",
    );
    expect(macTranscript).not.toContain("forged");
  });

  test("a new symbolic link in a worktree is asked about, whatever its name", async () => {
    const s = await setup();
    await s.moves.move({ workspace: "w1", to: "cloud" });
    await symlink("/etc", join(s.podRoot, FOLDER, "app", "notes"));
    expect(await s.moves.move({ workspace: "w1", to: "mac" })).toEqual({
      status: "needsApproval",
      paths: [`${FOLDER}/app/notes (symbolic link)`],
    });
  });

  test("a session waiting on the user is asked about, and a live Codex session blocks", async () => {
    const s = await setup();
    s.activity[SESSION] = "needs_permission";
    expect(await s.moves.move({ workspace: "w1", to: "cloud" })).toEqual({
      status: "busy",
      sessions: [{ id: SESSION, name: "Claude one" }],
    });
    expect(s.place().place).toBe("mac");
    expect(
      (await s.moves.move({ workspace: "w1", to: "cloud", stopWorking: true }))
        .status,
    ).toBe("moved");

    const t = await setup();
    t.sessions.set(CODEX, {
      ...t.sessions.get(SESSION)!,
      id: CODEX,
      name: "Codex one",
      provider: "codex",
    });
    expect(await t.moves.move({ workspace: "w1", to: "cloud" })).toEqual({
      status: "needsStopped",
      sessions: [{ id: CODEX, name: "Codex one" }],
    });
  });

  test("waits for a working session's turn, and can be cancelled", async () => {
    const s = await setup();
    s.activity[SESSION] = "working";
    const moving = s.moves.move({ workspace: "w1", to: "cloud" });
    await Bun.sleep(30);
    expect(s.moves.list()[0]).toMatchObject({ phase: "waiting" });
    s.moves.cancel("w1");
    await expect(moving).rejects.toThrow("cancelled");
    expect(s.place().place).toBe("mac");
    expect(s.sessions.get(SESSION)!.status).toBe("running");
  });

  test("a failure before the switch leaves the workspace and resumes its sessions", async () => {
    const s = await setup();
    // A transcript the pod cannot take.
    await rm(s.podRoot, { recursive: true });
    await writeFile(s.podRoot, "not a folder\n");
    await expect(
      s.moves.move({ workspace: "w1", to: "cloud" }),
    ).rejects.toThrow();
    expect(s.place().place).toBe("mac");
    expect(s.sessions.get(SESSION)).toMatchObject({
      status: "running",
      hostId: null,
      workingDirectory: s.macFolder,
    });
  });
});

describe("files from the pod", () => {
  test("an archive with anything but plain files is refused before it is unpacked", async () => {
    const made = join(root, "made");
    await mkdir(made, { recursive: true });
    await writeFile(join(made, "ok.md"), "ok\n");
    await symlink("/etc/passwd", join(made, "link"));
    const archive = join(root, "files.tar");
    await runCommand("tar", ["-c", "-f", archive, "ok.md", "link"], {
      cwd: made,
    });
    const scratch = join(root, "scratch");
    await mkdir(scratch);
    await expect(
      unpackFromPod(new LocalMoveSide(), archive, scratch),
    ).rejects.toThrow("not a plain file");
    expect(await exists(join(scratch, "ok.md"))).toBe(false);
  });
});

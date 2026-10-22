import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { AgentSession, SessionWorktree } from "../domain";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import { cloudHostId } from "./cloud-launch";
import { steersAgent } from "./move-git";
import { claudeProjectKey, type PodAccess } from "./move-side";
import {
  lastPermissionMode,
  rewriteTranscript,
  safeTranscriptPath,
} from "./move-transcript";
import { SessionMoves } from "./session-move";
import type { SessionHosts } from "./session-hosts";
import type { WorkspaceService } from "./workspaces";

const SESSION = "5e55a0c1-0000-4000-8000-000000000001";
const CLOUD = "c10d0000-0000-4000-8000-000000000002";
const POD_FOLDER = "/workspace/worktrees/unassigned/claude-1";

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

interface Setup {
  moves: SessionMoves;
  session: () => AgentSession;
  starts: { hostId: string | null; cwd: string; mode?: string }[];
  failNextStart: { value: boolean };
  turn: { activity: "working" | "idle" };
  macRepo: string;
  podRoot: string;
  macProjects: string;
  macFolder: string;
}

async function setup(options: { big?: boolean } = {}): Promise<Setup> {
  const workspacePath = join(root, "workspace");
  const macFolder = join(workspacePath, "worktrees", "unassigned", "claude-1");
  const macRepo = join(macFolder, "app");
  const podRoot = join(root, "pod");
  const macProjects = join(root, "claude", "projects");
  await mkdir(macRepo, { recursive: true });
  await mkdir(podRoot, { recursive: true });
  await git(macRepo, "init", "-q", "-b", "feature");
  await writeFile(join(macRepo, ".gitignore"), "ignored.txt\n");
  await writeFile(join(macRepo, "a.txt"), "one\n");
  await writeFile(join(macRepo, "gone.txt"), "tracked, deleted later\n");
  await git(macRepo, "add", "-A");
  await git(macRepo, "commit", "-q", "-m", "first");
  // Work in progress of every kind.
  await writeFile(join(macRepo, "a.txt"), "one\nstaged\n");
  await git(macRepo, "add", "a.txt");
  await writeFile(join(macRepo, "a.txt"), "one\nstaged\nunstaged\n");
  await rm(join(macRepo, "gone.txt"));
  await writeFile(join(macRepo, "new.txt"), "untracked\n");
  await writeFile(join(macRepo, "ignored.txt"), "stays on the Mac\n");
  await writeFile(
    join(macRepo, "big.bin"),
    crypto.getRandomValues(new Uint8Array(65_536)).map((_, i) => i % 251),
  );
  // Larger than one piece through the relay, and incompressible.
  if (options.big) {
    const big = new Uint8Array(5 * 1024 * 1024);
    for (let offset = 0; offset < big.length; offset += 65_536)
      big.set(crypto.getRandomValues(new Uint8Array(65_536)), offset);
    await writeFile(join(macRepo, "random.bin"), big);
  }

  const project = join(macProjects, claudeProjectKey(macFolder));
  await mkdir(join(project, SESSION, "subagents"), { recursive: true });
  await writeFile(
    join(project, `${SESSION}.jsonl`),
    [
      JSON.stringify({
        type: "permission-mode",
        permissionMode: "acceptEdits",
      }),
      JSON.stringify({ type: "user", cwd: macFolder, message: "hello" }),
      JSON.stringify({
        type: "user",
        cwd: `${macFolder}/app`,
        message: "in app",
      }),
    ].join("\n") + "\n",
  );
  await writeFile(
    join(project, SESSION, "subagents", "agent-1.jsonl"),
    JSON.stringify({ type: "user", cwd: macFolder }) + "\n",
  );

  const worktree: SessionWorktree = {
    sessionId: SESSION,
    repositoryId: "r1",
    path: macRepo,
    branchName: "feature",
    createdAt: new Date().toISOString(),
  };
  let current = {
    id: SESSION,
    workspaceId: "w1",
    kind: "agent",
    provider: "claude",
    status: "running",
    hostId: null,
    workingDirectory: macFolder,
    providerSessionId: SESSION,
    archivedAt: null,
    tmuxSession: "daedalus_x",
  } as unknown as AgentSession;
  const starts: Setup["starts"] = [];
  const failNextStart = { value: false };
  const turn: Setup["turn"] = { activity: "idle" };
  const pod = fakePod(podRoot);
  const agents = {
    get: async () => current,
    stopForMove: async () => (current = { ...current, status: "exited" }),
    resumeAfterMove: async (agent: AgentSession, mode?: string) => {
      starts.push({
        hostId: agent.hostId ?? null,
        cwd: agent.workingDirectory,
        ...(mode ? { mode } : {}),
      });
      if (failNextStart.value) {
        failNextStart.value = false;
        throw new Error("the provider did not start");
      }
      current = { ...agent, status: "running" };
      return current;
    },
    claudeProjectsDirectory: () => macProjects,
  } as unknown as AgentService;
  const moves = new SessionMoves({
    config: {
      home: join(root, "home"),
      agents: {},
    } as unknown as DaedalusConfig,
    repositories: {
      listSessionWorktrees: () => [worktree],
      cloudWorkspaceId: () => CLOUD,
      findAgent: () => current,
    } as unknown as SqliteRepositories,
    workspaces: {
      getActive: async () => ({ id: "w1", path: workspacePath }),
    } as unknown as WorkspaceService,
    agents,
    hosts: { get: () => pod } as unknown as SessionHosts,
    cloud: {
      create: async () => ({ workspaceId: CLOUD }),
      wakeForSessions: async () => undefined,
    },
    activity: async () => turn.activity,
    pollMs: 5,
    turnTimeoutMs: 2_000,
    podRoot,
  });
  return {
    moves,
    session: () => current,
    starts,
    failNextStart,
    turn,
    macRepo,
    podRoot,
    macProjects,
    macFolder,
  };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "daedalus-move-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("moving a session", () => {
  test("carries commits, staged, unstaged and untracked changes and the conversation both ways", async () => {
    const s = await setup({ big: true });
    const result = await s.moves.move({ sessionId: SESSION, to: "cloud" });
    expect(result.status).toBe("moved");
    expect(s.session().hostId).toBe(cloudHostId(CLOUD));
    expect(s.session().workingDirectory).toBe("worktrees/unassigned/claude-1");
    expect(s.starts).toEqual([
      {
        hostId: cloudHostId(CLOUD),
        cwd: "worktrees/unassigned/claude-1",
        mode: "acceptEdits",
      },
    ]);

    const podRepo = join(s.podRoot, "worktrees/unassigned/claude-1/app");
    expect(await git(podRepo, "branch", "--show-current")).toBe("feature");
    expect(await readFile(join(podRepo, "a.txt"), "utf8")).toBe(
      "one\nstaged\nunstaged\n",
    );
    expect(await git(podRepo, "show", ":a.txt")).toBe("one\nstaged");
    expect(await exists(join(podRepo, "gone.txt"))).toBe(false);
    expect(await readFile(join(podRepo, "new.txt"), "utf8")).toBe(
      "untracked\n",
    );
    expect(await git(podRepo, "status", "--porcelain")).toContain("?? new.txt");
    expect(await exists(join(podRepo, "ignored.txt"))).toBe(false);
    expect(await readFile(join(podRepo, "random.bin"))).toEqual(
      await readFile(join(s.macRepo, "random.bin")),
    );

    const podProject = join(
      s.podRoot,
      ".home/.claude/projects",
      claudeProjectKey(POD_FOLDER),
    );
    const podTranscript = await readFile(
      join(podProject, `${SESSION}.jsonl`),
      "utf8",
    );
    expect(podTranscript).toContain(`"cwd":"${POD_FOLDER}"`);
    expect(podTranscript).toContain(`"cwd":"${POD_FOLDER}/app"`);
    expect(
      await exists(join(podProject, SESSION, "subagents", "agent-1.jsonl")),
    ).toBe(true);
    expect(await exists(join(s.podRoot, ".daedalus-move", SESSION))).toBe(
      false,
    );

    // Work in the pod: a commit, more changes, an untracked file removed.
    await writeFile(join(podRepo, "a.txt"), "cloud commit\n");
    await git(podRepo, "commit", "-q", "-am", "from the cloud");
    await writeFile(join(podRepo, "b.txt"), "cloud untracked\n");
    await rm(join(podRepo, "new.txt"));
    await writeFile(
      join(podProject, `${SESSION}.jsonl`),
      podTranscript +
        JSON.stringify({
          type: "permission-mode",
          permissionMode: "bypassPermissions",
        }) +
        "\n" +
        JSON.stringify({
          type: "user",
          cwd: POD_FOLDER,
          message: "in the cloud",
        }) +
        "\n",
    );

    const back = await s.moves.move({ sessionId: SESSION, to: "local" });
    expect(back.status).toBe("moved");
    expect(s.session().hostId).toBeNull();
    expect(s.session().workingDirectory).toBe(s.macFolder);
    // The Mac's own mode, never the one the pod wrote.
    expect(s.starts.at(-1)).toEqual({
      hostId: null,
      cwd: s.macFolder,
      mode: "acceptEdits",
    });
    expect(await git(s.macRepo, "log", "-1", "--format=%s")).toBe(
      "from the cloud",
    );
    expect(await readFile(join(s.macRepo, "b.txt"), "utf8")).toBe(
      "cloud untracked\n",
    );
    expect(await exists(join(s.macRepo, "new.txt"))).toBe(false);
    expect(await readFile(join(s.macRepo, "ignored.txt"), "utf8")).toBe(
      "stays on the Mac\n",
    );
    const macTranscript = await readFile(
      join(s.macProjects, claudeProjectKey(s.macFolder), `${SESSION}.jsonl`),
      "utf8",
    );
    expect(macTranscript).toContain("in the cloud");
    expect(macTranscript).not.toContain("bypassPermissions");
    expect(macTranscript).not.toContain(`"cwd":"${POD_FOLDER}`);
    expect(s.moves.list()).toEqual([]);

    // And out again: only what is new travels, onto the pod's copy.
    await writeFile(join(s.macRepo, "c.txt"), "third trip\n");
    expect(
      (await s.moves.move({ sessionId: SESSION, to: "cloud" })).status,
    ).toBe("moved");
    expect(await readFile(join(podRepo, "c.txt"), "utf8")).toBe("third trip\n");
    expect(await readFile(join(podRepo, "b.txt"), "utf8")).toBe(
      "cloud untracked\n",
    );
  });

  test("asks before taking files that steer an agent, and stops nothing until approved", async () => {
    const s = await setup();
    await s.moves.move({ sessionId: SESSION, to: "cloud" });
    const podRepo = join(s.podRoot, "worktrees/unassigned/claude-1/app");
    await mkdir(join(podRepo, ".claude"), { recursive: true });
    await writeFile(join(podRepo, ".claude/settings.json"), '{"hooks":{}}');
    await writeFile(join(podRepo, "CLAUDE.md"), "obey the pod\n");
    const starts = s.starts.length;

    const asked = await s.moves.move({ sessionId: SESSION, to: "local" });
    expect(asked).toEqual({
      status: "needsApproval",
      paths: ["app/.claude/settings.json", "app/CLAUDE.md"],
    });
    expect(s.session().status).toBe("running");
    expect(s.session().hostId).toBe(cloudHostId(CLOUD));
    expect(s.starts.length).toBe(starts);

    const moved = await s.moves.move({
      sessionId: SESSION,
      to: "local",
      approved: ["app/.claude/settings.json", "app/CLAUDE.md"],
    });
    expect(moved.status).toBe("moved");
    expect(await readFile(join(s.macRepo, "CLAUDE.md"), "utf8")).toBe(
      "obey the pod\n",
    );
  });

  test("a failed start resumes the session where it was, and the Mac copy is untouched", async () => {
    const s = await setup();
    await s.moves.move({ sessionId: SESSION, to: "cloud" });
    const podRepo = join(s.podRoot, "worktrees/unassigned/claude-1/app");
    await writeFile(join(podRepo, "a.txt"), "cloud\n");
    s.failNextStart.value = true;
    await expect(
      s.moves.move({ sessionId: SESSION, to: "local" }),
    ).rejects.toThrow("the provider did not start");
    expect(s.session().hostId).toBe(cloudHostId(CLOUD));
    expect(s.session().status).toBe("running");
    expect(s.starts.at(-1)?.hostId).toBe(cloudHostId(CLOUD));
    expect(s.moves.list()).toMatchObject([
      { sessionId: SESSION, phase: "failed" },
    ]);
  });

  test("refuses to move back over a Mac copy that changed meanwhile", async () => {
    const s = await setup();
    await s.moves.move({ sessionId: SESSION, to: "cloud" });
    await writeFile(join(s.macRepo, "a.txt"), "edited on the Mac\n");
    await expect(
      s.moves.move({ sessionId: SESSION, to: "local" }),
    ).rejects.toThrow("This Mac's copy of app changed");
    expect(s.session().status).toBe("running");
    expect(await readFile(join(s.macRepo, "a.txt"), "utf8")).toBe(
      "edited on the Mac\n",
    );
  });

  test("waits for the turn to end, and can be cancelled while it waits", async () => {
    const s = await setup();
    s.turn.activity = "working";
    const moving = s.moves.move({ sessionId: SESSION, to: "cloud" });
    for (
      let i = 0;
      i < 100 && s.moves.list()[0]?.detail !== "Waiting for the turn to end";
      i++
    )
      await Bun.sleep(10);
    expect(s.moves.list()).toMatchObject([{ phase: "waiting", to: "cloud" }]);
    s.moves.cancel(SESSION);
    await expect(moving).rejects.toThrow("cancelled");
    expect(s.session().status).toBe("running");
    expect(s.session().hostId).toBeNull();
  });

  test("a transcript from the pod that is not JSON fails the move back", async () => {
    const s = await setup();
    await s.moves.move({ sessionId: SESSION, to: "cloud" });
    const podProject = join(
      s.podRoot,
      ".home/.claude/projects",
      claudeProjectKey(POD_FOLDER),
    );
    await writeFile(join(podProject, `${SESSION}.jsonl`), "not json\n");
    await expect(
      s.moves.move({ sessionId: SESSION, to: "local" }),
    ).rejects.toThrow("not a Claude transcript");
    expect(s.session().hostId).toBe(cloudHostId(CLOUD));
  });

  test("a link in the pod's transcript folder is not followed", async () => {
    const s = await setup();
    await s.moves.move({ sessionId: SESSION, to: "cloud" });
    const podProject = join(
      s.podRoot,
      ".home/.claude/projects",
      claudeProjectKey(POD_FOLDER),
    );
    await writeFile(join(root, "secret.txt"), "outside\n");
    await symlink(
      join(root, "secret.txt"),
      join(podProject, SESSION, "subagents", "leak.jsonl"),
    );
    await s.moves.move({ sessionId: SESSION, to: "local" });
    expect(
      await exists(
        join(
          s.macProjects,
          claudeProjectKey(s.macFolder),
          SESSION,
          "subagents",
          "leak.jsonl",
        ),
      ),
    ).toBe(false);
  });
});

describe("move rules", () => {
  test("names what steers an agent or runs on open", () => {
    for (const path of [
      ".claude/settings.json",
      ".claude/commands/x.md",
      "pkg/.claude/skills/a/SKILL.md",
      "CLAUDE.md",
      "docs/AGENTS.md",
      ".mcp.json",
      ".envrc",
      ".husky/pre-commit",
      ".githooks/post-checkout",
      ".vscode/tasks.json",
      ".devcontainer/devcontainer.json",
    ])
      expect(steersAgent(path)).toBe(true);
    for (const path of ["src/claude.ts", "README.md", "claude/notes.md"])
      expect(steersAgent(path)).toBe(false);
  });

  test("rewrites cwd and the permission mode, and reads the last mode", () => {
    const text = [
      JSON.stringify({ type: "permission-mode", permissionMode: "plan" }),
      JSON.stringify({ cwd: "/a/b", permissionMode: "plan" }),
      JSON.stringify({ cwd: "/a/bc" }),
      "",
    ].join("\n");
    expect(lastPermissionMode(text)).toBe("plan");
    const out = rewriteTranscript(text, {
      from: "/a/b",
      to: "/workspace/x",
      permissionMode: "auto",
      strict: true,
    });
    expect(out).toContain('"cwd":"/workspace/x"');
    expect(out).toContain('"cwd":"/a/bc"');
    expect(out).not.toContain('"plan"');
    expect(() =>
      rewriteTranscript("[1]\n", { from: "/a", to: "/b", strict: true }),
    ).toThrow();
    expect(safeTranscriptPath("subagents/a.jsonl")).toBe(true);
    expect(safeTranscriptPath("../x")).toBe(false);
    expect(safeTranscriptPath("a/b/c/d")).toBe(false);
  });
});

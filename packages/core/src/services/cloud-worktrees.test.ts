import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
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
import type { SqliteRepositories } from "../repositories";
import { CloudWorktrees } from "./cloud-worktrees";
import type { PodAccess } from "./move-side";
import type { SessionHosts } from "./session-hosts";
import type { WorkspaceService } from "./workspaces";

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

async function setup() {
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const library = join(root, "library", "app.git");
  const podRoot = join(root, "pod");
  const workspacePath = join(root, "workspace");
  await mkdir(seed, { recursive: true });
  await mkdir(join(podRoot, FOLDER), { recursive: true });
  await git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, "a.txt"), "one\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "first");
  await git(root, "clone", "-q", "--bare", seed, origin);
  await git(root, "clone", "-q", "--bare", origin, library);
  const repository = {
    id: "r1",
    workspaceId: "w1",
    name: "app",
    canonicalPath: library,
    access: "write",
    libraryRepositoryId: "lib1",
    referencePath: null,
    baseBranch: "main",
    baseCommit: null,
    status: "ready",
  } as unknown as WorkspaceRepository;
  const session = {
    id: "5e55a0c1-0000-4000-8000-000000000001",
    workspaceId: "w1",
    kind: "agent",
    hostId: "ws:c1",
    workingDirectory: FOLDER,
  } as unknown as AgentSession;
  const worktrees: SessionWorktree[] = [];
  const cloud = new CloudWorktrees({
    config: { home: join(root, "home") } as unknown as DaedalusConfig,
    repositories: {
      createSessionWorktree: (worktree: SessionWorktree) =>
        worktrees.push(worktree),
      deleteSessionWorktree: () => worktrees.splice(0),
    } as unknown as SqliteRepositories,
    workspaces: {
      getActive: async () => ({ id: "w1", path: workspacePath }),
    } as unknown as WorkspaceService,
    hosts: { get: () => fakePod(podRoot) } as unknown as SessionHosts,
    podRoot,
  });
  return {
    cloud,
    repository,
    session,
    worktrees,
    origin,
    podRoot,
    workspacePath,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "daedalus-cloud-worktrees-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("worktrees of a workspace in the cloud", () => {
  test("are made in the pod, pushed from this Mac, and removed in the pod", async () => {
    const s = await setup();
    const made = await s.cloud.create({
      session: s.session,
      repository: s.repository,
      branch: "fix/x",
    });
    expect(made).toMatchObject({
      path: join(s.workspacePath, FOLDER, "app"),
      branchName: "fix/x",
    });
    expect(s.worktrees).toEqual([made]);
    const podTree = join(s.podRoot, FOLDER, "app");
    expect(await git(podTree, "branch", "--show-current")).toBe("fix/x");
    expect(await readFile(join(podTree, "a.txt"), "utf8")).toBe("one\n");

    await writeFile(join(podTree, "a.txt"), "two\n");
    await git(podTree, "commit", "-q", "-am", "in the cloud");
    const pushed = await s.cloud.push({
      session: s.session,
      repository: s.repository,
      worktree: made,
    });
    expect(pushed.alreadyUpToDate).toBe(false);
    expect(await git(s.origin, "log", "-1", "--format=%s", "fix/x")).toBe(
      "in the cloud",
    );
    // A second push with nothing new sends nothing.
    expect(
      (
        await s.cloud.push({
          session: s.session,
          repository: s.repository,
          worktree: made,
        })
      ).alreadyUpToDate,
    ).toBe(true);

    await s.cloud.remove({
      session: s.session,
      repository: s.repository,
      worktree: made,
    });
    expect(s.worktrees).toEqual([]);
    expect(
      await stat(podTree).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("a name taken or the base branch is refused", async () => {
    const s = await setup();
    await expect(
      s.cloud.create({
        session: s.session,
        repository: s.repository,
        branch: "main",
      }),
    ).rejects.toThrow();
    await s.cloud.create({
      session: s.session,
      repository: s.repository,
      branch: "fix/x",
    });
    const other = { ...s.session, workingDirectory: "worktrees/unassigned/b" };
    await expect(
      s.cloud.create({
        session: other,
        repository: s.repository,
        branch: "fix/x",
      }),
    ).rejects.toThrow("already exists");
  });
});

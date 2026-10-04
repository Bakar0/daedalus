import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AgentSession, ApplicationContext } from "@daedalus/core";
import { callerSession } from "./caller";

let root: string;
const session = (
  id: string,
  workingDirectory: string,
  extra: Partial<AgentSession> = {},
) =>
  ({
    id,
    name: id,
    workingDirectory,
    status: "running",
    archivedAt: null,
    ...extra,
  }) as AgentSession;

const contextWith = (sessions: AgentSession[]) =>
  ({
    repositories: {
      listAgents: () => sessions,
      findAgent: (id: string) => sessions.find((item) => item.id === id),
    },
  }) as unknown as ApplicationContext;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "daedalus-caller-"));
  await mkdir(join(root, "workspace", "worktrees", "a", "repo"), {
    recursive: true,
  });
  await mkdir(join(root, "workspace", "worktrees", "b"), { recursive: true });
  await mkdir(join(root, "elsewhere"), { recursive: true });
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("the calling session", () => {
  const sessions = () => [
    session("root", join(root, "workspace")),
    session("a", join(root, "workspace", "worktrees", "a")),
    session("b", join(root, "workspace", "worktrees", "b")),
  ];

  test("is the session whose folder holds the current directory, whatever the environment says", async () => {
    const context = contextWith(sessions());
    const found = await callerSession(context, {
      directory: join(root, "workspace", "worktrees", "a", "repo"),
      environmentId: "b",
    });
    expect(found?.id).toBe("a");
    // The closest folder wins over the workspace root that also holds it.
    expect(
      (
        await callerSession(context, {
          directory: join(root, "workspace"),
          environmentId: "b",
        })
      )?.id,
    ).toBe("root");
  });

  test("falls back to the environment only outside every session's folder", async () => {
    const context = contextWith(sessions());
    expect(
      (
        await callerSession(context, {
          directory: join(root, "elsewhere"),
          environmentId: "b",
        })
      )?.id,
    ).toBe("b");
    expect(
      await callerSession(context, {
        directory: join(root, "elsewhere"),
        environmentId: undefined,
      }),
    ).toBeUndefined();
  });

  test("lets the environment break a tie, and refuses to guess one", async () => {
    const folder = join(root, "workspace", "worktrees", "b");
    const context = contextWith([
      ...sessions(),
      session("b2", folder),
      session("gone", folder, { archivedAt: "2026-10-04T00:00:00Z" }),
    ]);
    expect(
      (await callerSession(context, { directory: folder, environmentId: "b2" }))
        ?.id,
    ).toBe("b2");
    await expect(
      callerSession(context, { directory: folder, environmentId: "x" }),
    ).rejects.toThrow("2 running sessions work in");
  });
});

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { runCommand } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function cli(home: string, args: string[]): Promise<CliResult> {
  const child = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "index.ts"), ...args],
    {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, DAEDALUS_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function createRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  expect(
    (await runCommand("git", ["init", "-q", "-b", "main", path])).exitCode,
  ).toBe(0);
  await Bun.write(join(path, "README.md"), "# Source\n");
  expect(
    (await runCommand("git", ["-C", path, "add", "README.md"])).exitCode,
  ).toBe(0);
  expect(
    (
      await runCommand("git", [
        "-C",
        path,
        "-c",
        "user.name=Daedalus Test",
        "-c",
        "user.email=test@daedalus.local",
        "commit",
        "-qm",
        "initial",
      ])
    ).exitCode,
  ).toBe(0);
}

describe("daedal CLI contract", () => {
  test("supports workspace and task lifecycle with JSON envelopes", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const created = await cli(home, [
        "workspace",
        "create",
        "CLI Demo",
        "--json",
      ]);
      expect(created).toMatchObject({ exitCode: 0, stderr: "" });
      const workspace = JSON.parse(created.stdout).data as {
        id: string;
        slug: string;
      };
      expect(workspace.slug).toBe("cli-demo");

      const taskCreated = await cli(home, [
        "task",
        "create",
        "--workspace",
        workspace.id,
        "--title",
        "Contract",
        "--json",
      ]);
      expect(taskCreated.exitCode).toBe(0);
      const task = JSON.parse(taskCreated.stdout).data as { id: string };
      const updated = await cli(home, [
        "task",
        "status",
        task.id,
        "done",
        "--json",
      ]);
      expect(JSON.parse(updated.stdout).data.status).toBe("done");
      const listed = await cli(home, [
        "task",
        "list",
        "--status",
        "done",
        "--json",
      ]);
      expect(JSON.parse(listed.stdout).data).toHaveLength(1);
      const archived = await cli(home, [
        "workspace",
        "archive",
        workspace.id,
        "--json",
      ]);
      expect(JSON.parse(archived.stdout).data.archivedAt).not.toBeNull();
      expect(
        JSON.parse((await cli(home, ["workspace", "list", "--json"])).stdout)
          .data,
      ).toEqual([]);
      expect(
        JSON.parse(
          (await cli(home, ["workspace", "list", "--archived", "--json"]))
            .stdout,
        ).data,
      ).toHaveLength(1);
      const restored = await cli(home, [
        "workspace",
        "restore",
        workspace.id,
        "--json",
      ]);
      expect(JSON.parse(restored.stdout).data.archivedAt).toBeNull();
    });
  });

  test("uses stable validation, not-found, and conflict exit codes", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const usage = await cli(home, ["task", "create", "--json"]);
      expect(usage.exitCode).toBe(2);
      expect(JSON.parse(usage.stderr).error.code).toBe("VALIDATION");
      const missing = await cli(home, [
        "workspace",
        "get",
        "missing",
        "--json",
      ]);
      expect(missing.exitCode).toBe(3);
      const first = await cli(home, ["workspace", "create", "Same", "--json"]);
      expect(first.exitCode).toBe(0);
      const collision = await cli(home, [
        "workspace",
        "create",
        "Same",
        "--json",
      ]);
      expect(collision.exitCode).toBe(4);
      expect(JSON.parse(collision.stderr).ok).toBe(false);
    });
  });

  test("reports unavailable agent executables as dependency failures", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: {
            missing: {
              executable: "definitely-not-a-daedalus-executable",
              args: [],
            },
          },
        }),
      );
      const workspace = await cli(home, [
        "workspace",
        "create",
        "Agent Dependency",
        "--json",
      ]);
      expect(workspace.exitCode).toBe(0);
      const failed = await cli(home, [
        "agent",
        "spawn",
        "--workspace",
        "agent-dependency",
        "--command",
        "missing",
        "--json",
      ]);
      expect(failed.exitCode).toBe(5);
      expect(JSON.parse(failed.stderr).error.code).toBe("DEPENDENCY");
    });
  });

  test("adds, attaches, syncs, and detaches repository library entries", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const source = join(home, "source");
      await createRepository(source);
      const workspace = JSON.parse(
        (await cli(home, ["workspace", "create", "Repo CLI", "--json"])).stdout,
      ).data as { id: string };
      const added = await cli(home, [
        "repo",
        "library",
        "add",
        source,
        "--json",
      ]);
      expect(added).toMatchObject({ exitCode: 0, stderr: "" });
      const libraryRepository = JSON.parse(added.stdout).data as {
        id: string;
        name: string;
      };
      expect(libraryRepository.name).toBe("source");

      const attached = await cli(home, [
        "repo",
        "attach",
        "--workspace",
        workspace.id,
        "--repository",
        libraryRepository.id,
        "--json",
      ]);
      expect(attached.exitCode).toBe(0);
      const attachment = JSON.parse(attached.stdout).data as { id: string };
      expect(
        JSON.parse(
          (
            await cli(home, [
              "repo",
              "list",
              "--workspace",
              workspace.id,
              "--json",
            ])
          ).stdout,
        ).data,
      ).toHaveLength(1);

      expect(
        (await cli(home, ["repo", "sync", attachment.id, "--json"])).exitCode,
      ).toBe(0);
      expect(
        (await cli(home, ["repo", "detach", attachment.id, "--json"])).exitCode,
      ).toBe(0);
    });
  });
});

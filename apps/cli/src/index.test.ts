import { join } from "node:path";
import { describe, expect, test } from "vitest";
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
});

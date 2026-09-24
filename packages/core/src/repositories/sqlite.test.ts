import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { runMigrations } from "./migrations";
import { SqliteRepositories } from "./sqlite";

describe("SqliteRepositories", () => {
  test("persists workspace, task, and agent records and rolls back transactions", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const databasePath = join(home, "state.db");
      await runMigrations(
        databasePath,
        join(import.meta.dir, "../../../../migrations"),
      );
      const repositories = new SqliteRepositories(databasePath);
      const now = new Date().toISOString();
      repositories.createWorkspace({
        id: "workspace-id",
        slug: "demo",
        name: "Demo",
        path: join(home, "demo"),
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        position: 1,
        startSetsInProgress: true,
        autoHandoffPercent: null,
        defaultProvider: null,
        defaultModel: null,
      });
      repositories.createTask({
        id: "task-id",
        workspaceId: "workspace-id",
        number: 1,
        title: "Task",
        description: "Description",
        status: "todo",
        priority: "normal",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        briefUpdatedAt: null,
      });
      repositories.createAgent({
        id: "agent-id",
        workspaceId: "workspace-id",
        taskId: "task-id",
        name: "Task",
        provider: "custom",
        kind: "agent",
        tmuxSession: "daedalus_agentid",
        command: "sh",
        args: ["-l"],
        workingDirectory: join(home, "demo"),
        status: "running",
        exitCode: null,
        startedAt: now,
        endedAt: null,
        providerSessionId: null,
        archivedAt: null,
        resumeCount: 0,
        lostReason: null,
        handoffRequestedAt: null,
        resumeOnStart: false,
        position: 1,
      });
      repositories.createIntegratedTerminal({
        id: "terminal-id",
        name: "Demo terminal",
        tmuxSession: "daedalus_terminalid",
        command: "sh",
        args: ["-l"],
        workingDirectory: join(home, "demo"),
        status: "running",
        exitCode: null,
        startedAt: now,
        endedAt: null,
        revivedAt: null,
      });
      expect(repositories.findWorkspace("demo")?.id).toBe("workspace-id");
      expect(repositories.listTasks({ status: "todo" })[0]).toMatchObject({
        id: "task-id",
        number: 1,
      });
      expect(repositories.findAgent("agent-id")?.args).toEqual(["-l"]);
      expect(repositories.findAgent("agent-id")?.name).toBe("Task");
      expect(repositories.findIntegratedTerminal("terminal-id")).toMatchObject({
        name: "Demo terminal",
        args: ["-l"],
      });
      expect(() =>
        repositories.transaction(() => {
          repositories.deleteTask("task-id");
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(repositories.findTask("task-id")).toBeDefined();
      repositories.close();
    });
  });
});

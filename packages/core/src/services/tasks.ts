import type { Task, TaskPriority, TaskStatus } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { WorkspaceService } from "./workspaces";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];
export const TASK_PRIORITIES: readonly TaskPriority[] = [
  "low",
  "normal",
  "high",
];

function title(value: string): string {
  const result = value.trim();
  if (!result || result.length > 240)
    throw new DaedalusError(
      "VALIDATION",
      "Task title must contain 1–240 characters",
    );
  return result;
}

function description(value: string): string {
  if (value.length > 20_000)
    throw new DaedalusError(
      "VALIDATION",
      "Task description must contain at most 20,000 characters",
    );
  return value;
}

export function taskStatus(value: string): TaskStatus {
  if (!TASK_STATUSES.includes(value as TaskStatus))
    throw new DaedalusError(
      "VALIDATION",
      `Task status must be one of: ${TASK_STATUSES.join(", ")}`,
    );
  return value as TaskStatus;
}

export function taskPriority(value: string): TaskPriority {
  if (!TASK_PRIORITIES.includes(value as TaskPriority))
    throw new DaedalusError(
      "VALIDATION",
      `Task priority must be one of: ${TASK_PRIORITIES.join(", ")}`,
    );
  return value as TaskPriority;
}

export class TaskService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly hasLiveAgents: (taskId: string) => Promise<boolean>,
  ) {}

  async create(input: {
    workspace: string;
    title: string;
    description?: string;
    priority?: string;
  }): Promise<Task> {
    const workspace = await this.workspaces.getActive(input.workspace);
    const now = new Date().toISOString();
    const task = this.repositories.createNumberedTask({
      workspaceId: workspace.id,
      title: title(input.title),
      description: description(input.description ?? ""),
      status: "todo",
      priority: taskPriority(input.priority ?? "normal"),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      briefUpdatedAt: null,
    });
    return task;
  }

  async list(filters: {
    workspace?: string;
    status?: string;
  }): Promise<Task[]> {
    const workspaceId = filters.workspace
      ? (await this.workspaces.get(filters.workspace)).id
      : undefined;
    return this.repositories.listTasks({
      workspaceId,
      status: filters.status ? taskStatus(filters.status) : undefined,
    });
  }

  get(id: string): Task {
    const task = this.repositories.findTask(id);
    if (!task)
      throw new DaedalusError("NOT_FOUND", `Task '${id}' was not found`);
    return task;
  }

  getByNumber(workspaceId: string, number: number): Task {
    const task = this.repositories.findTaskByNumber(workspaceId, number);
    if (!task)
      throw new DaedalusError(
        "NOT_FOUND",
        `Task '#${number}' was not found in workspace '${workspaceId}'`,
      );
    return task;
  }

  update(
    id: string,
    changes: { title?: string; description?: string; priority?: string },
  ): Task {
    const task = this.get(id);
    if (
      changes.title === undefined &&
      changes.description === undefined &&
      changes.priority === undefined
    )
      throw new DaedalusError(
        "VALIDATION",
        "At least one task field is required",
      );
    const now = new Date().toISOString();
    const nextTitle =
      changes.title === undefined ? task.title : title(changes.title);
    const nextDescription =
      changes.description === undefined
        ? task.description
        : description(changes.description);
    const updated: Task = {
      ...task,
      title: nextTitle,
      description: nextDescription,
      priority:
        changes.priority === undefined
          ? task.priority
          : taskPriority(changes.priority),
      updatedAt: now,
      // Only a real change counts. The editor saves title and brief together,
      // so a save that touched neither must not claim the brief was edited.
      briefUpdatedAt:
        nextTitle !== task.title || nextDescription !== task.description
          ? now
          : task.briefUpdatedAt,
    };
    this.repositories.updateTask(updated);
    return updated;
  }

  setStatus(id: string, statusValue: string): Task {
    const task = this.get(id);
    const status = taskStatus(statusValue);
    const now = new Date().toISOString();
    const updated: Task = {
      ...task,
      status,
      updatedAt: now,
      completedAt: status === "done" ? now : null,
    };
    this.repositories.updateTask(updated);
    return updated;
  }

  async remove(id: string, force: boolean): Promise<Task> {
    if (!force)
      throw new DaedalusError("VALIDATION", "Task removal requires --force");
    const task = this.get(id);
    if (await this.hasLiveAgents(task.id))
      throw new DaedalusError(
        "CONFLICT",
        "Task has live agent sessions; stop them before removal",
      );
    this.repositories.deleteTask(task.id);
    return task;
  }
}

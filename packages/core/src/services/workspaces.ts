import { dirname, join, resolve } from "node:path";
import {
  canonicalPath,
  createDirectoryExclusive,
  ensureDirectory,
  isDirectory,
  isRootLikePath,
  isSymbolicLink,
  pathExists,
  readTextFile,
  removeDirectory,
  writeTextFile,
} from "@daedalus/platform";
import type { Workspace } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { applyManualOrder } from "./ordering";
import { ensureWorkspaceContentFiles } from "./workspace-content";

const MARKER_DIRECTORY = ".daedalus";
const MARKER_FILE = "workspace.json";

export function workspaceSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (
    !slug ||
    slug.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)
  ) {
    throw new DaedalusError(
      "VALIDATION",
      "Workspace slug must contain 1–63 lowercase letters, numbers, or hyphens",
    );
  }
  return slug;
}

function requiredName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120)
    throw new DaedalusError(
      "VALIDATION",
      "Workspace name must contain 1–120 characters",
    );
  return name;
}

function workspaceConflict(error: unknown, slug: string, path: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "EEXIST" || message.includes("UNIQUE constraint failed"))
    return new DaedalusError(
      "CONFLICT",
      `Workspace '${slug}' or path '${path}' already exists`,
    );
  return error instanceof Error ? error : new Error(String(error));
}

function boardProvider(value: string | null): "claude" | "codex" | null {
  if (value === null || value === "" || value === "none") return null;
  if (value === "claude" || value === "codex") return value;
  throw new DaedalusError(
    "VALIDATION",
    "Default provider must be 'claude', 'codex' or 'none'",
  );
}

export class WorkspaceService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaceRoot: string,
    private readonly hasLiveAgents: (workspaceId: string) => Promise<boolean>,
    private readonly archiveAgents: (workspaceId: string) => Promise<void>,
    private readonly daedalusHome: string,
    private readonly instructionFilesEnabled: () => boolean = () => true,
  ) {}

  async create(input: {
    name: string;
    slug?: string;
    path?: string;
  }): Promise<Workspace> {
    const name = requiredName(input.name);
    const slug = workspaceSlug(input.slug ?? name);
    const path = resolve(input.path ?? join(this.workspaceRoot, slug));
    if (this.repositories.findWorkspace(slug))
      throw new DaedalusError("CONFLICT", `Workspace '${slug}' already exists`);
    if (this.repositories.listWorkspaces().some((item) => item.path === path))
      throw new DaedalusError(
        "CONFLICT",
        `Workspace path '${path}' is already registered`,
      );
    if (await pathExists(path))
      throw new DaedalusError(
        "CONFLICT",
        `Workspace path '${path}' already exists`,
      );

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: slug,
      slug,
      name,
      path,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      // Top of the list. The thing you just made is the thing you are looking
      // for, and a manual order the user has set is never disturbed to do it.
      position: this.repositories.nextWorkspacePosition(),
      startSetsInProgress: true,
      defaultProvider: null,
      defaultModel: null,
    };
    let created = false;
    try {
      await ensureDirectory(dirname(path));
      await createDirectoryExclusive(path);
      created = true;
      await ensureDirectory(join(path, MARKER_DIRECTORY));
      await writeTextFile(
        join(path, MARKER_DIRECTORY, MARKER_FILE),
        `${JSON.stringify({ id: workspace.id }, null, 2)}\n`,
      );
      await ensureWorkspaceContentFiles(
        path,
        this.daedalusHome,
        this.instructionFilesEnabled(),
      );
      this.repositories.createWorkspace(workspace);
      return workspace;
    } catch (error) {
      if (created && (await pathExists(path))) await removeDirectory(path);
      throw workspaceConflict(error, slug, path);
    }
  }

  async list(): Promise<Workspace[]> {
    return (await this.listWithHealth())
      .filter((item) => item.available && !item.workspace.archivedAt)
      .map((item) => item.workspace);
  }

  /**
   * Puts the named workspaces in the order given. References may be slugs or
   * ids, and naming a subset rearranges only that subset — see
   * `applyManualOrder`.
   */
  async reorder(references: string[]): Promise<Workspace[]> {
    const current = this.repositories.listWorkspaces();
    const resolved = references.map((reference) => {
      const workspace = this.repositories.findWorkspace(reference);
      if (!workspace)
        throw new DaedalusError(
          "NOT_FOUND",
          `Workspace '${reference}' was not found`,
        );
      return workspace.id;
    });
    this.repositories.reorderWorkspaces(
      applyManualOrder(
        current.map((item) => item.id),
        resolved,
        "Workspace",
      ),
    );
    return this.repositories.listWorkspaces();
  }

  async listWithHealth(): Promise<
    Array<{ workspace: Workspace; available: boolean }>
  > {
    return Promise.all(
      this.repositories.listWorkspaces().map(async (workspace) => ({
        workspace,
        available: await this.isAuthoritativeWorkspace(workspace),
      })),
    );
  }

  async get(reference: string): Promise<Workspace> {
    const workspace = this.repositories.findWorkspace(reference);
    if (!workspace)
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace '${reference}' was not found`,
      );
    if (!(await this.isAuthoritativeWorkspace(workspace)))
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace folder '${workspace.path}' or its identity marker is missing`,
        { workspaceId: workspace.id },
      );
    await ensureWorkspaceContentFiles(
      workspace.path,
      this.daedalusHome,
      this.instructionFilesEnabled(),
    );
    return workspace;
  }

  async getActive(reference: string): Promise<Workspace> {
    const workspace = await this.get(reference);
    if (workspace.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        `Workspace '${workspace.slug}' is archived`,
      );
    return workspace;
  }

  async update(
    reference: string,
    changes: {
      name?: string;
      slug?: string;
      startSetsInProgress?: boolean;
      /** `null` clears it back to "no preference". */
      defaultProvider?: string | null;
      defaultModel?: string | null;
    },
  ): Promise<Workspace> {
    const workspace = await this.get(reference);
    if (Object.values(changes).every((value) => value === undefined))
      throw new DaedalusError(
        "VALIDATION",
        "At least one workspace field is required",
      );
    const defaultProvider =
      changes.defaultProvider === undefined
        ? workspace.defaultProvider
        : boardProvider(changes.defaultProvider);
    const defaultModel =
      changes.defaultModel === undefined
        ? workspace.defaultModel
        : changes.defaultModel?.trim() || null;
    const slug =
      changes.slug === undefined ? workspace.slug : workspaceSlug(changes.slug);
    const collision = this.repositories.findWorkspace(slug);
    if (collision && collision.id !== workspace.id)
      throw new DaedalusError("CONFLICT", `Workspace '${slug}' already exists`);
    const updated: Workspace = {
      ...workspace,
      name:
        changes.name === undefined
          ? workspace.name
          : requiredName(changes.name),
      slug,
      startSetsInProgress:
        changes.startSetsInProgress ?? workspace.startSetsInProgress,
      defaultProvider,
      // A model belongs to a provider. Changing the provider without naming a
      // model drops the old one rather than launching Codex with a Claude id.
      defaultModel:
        changes.defaultProvider !== undefined &&
        changes.defaultModel === undefined &&
        defaultProvider !== workspace.defaultProvider
          ? null
          : defaultModel,
      updatedAt: new Date().toISOString(),
    };
    try {
      this.repositories.updateWorkspace(updated);
    } catch (error) {
      throw workspaceConflict(error, slug, workspace.path);
    }
    return updated;
  }

  async remove(
    reference: string,
    options: { deleteFiles?: boolean; force?: boolean },
  ): Promise<{ workspace: Workspace; filesDeleted: boolean }> {
    if (!options.force)
      throw new DaedalusError(
        "VALIDATION",
        "Workspace removal requires --force",
      );
    const workspace = await this.get(reference);
    if (await this.hasLiveAgents(workspace.id))
      throw new DaedalusError(
        "CONFLICT",
        "Workspace has live agent sessions; stop them before removal",
      );
    if (
      this.repositories.listSessionWorktrees({ workspaceId: workspace.id })
        .length > 0
    )
      throw new DaedalusError(
        "CONFLICT",
        "Workspace has repository worktrees; preserve or clean them up before removal",
      );
    if (options.deleteFiles) await this.verifyDeletionTarget(workspace);
    if (options.deleteFiles) await removeDirectory(workspace.path);
    this.repositories.transaction(() =>
      this.repositories.deleteWorkspace(workspace.id),
    );
    return { workspace, filesDeleted: Boolean(options.deleteFiles) };
  }

  async archive(reference: string): Promise<Workspace> {
    const workspace = await this.get(reference);
    if (workspace.archivedAt) return workspace;
    await this.archiveAgents(workspace.id);
    const archived = {
      ...workspace,
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.repositories.updateWorkspace(archived);
    return archived;
  }

  async restore(reference: string): Promise<Workspace> {
    const workspace = await this.get(reference);
    if (!workspace.archivedAt)
      throw new DaedalusError("CONFLICT", "Workspace is not archived");
    const restored = {
      ...workspace,
      archivedAt: null,
      updatedAt: new Date().toISOString(),
    };
    this.repositories.updateWorkspace(restored);
    return restored;
  }

  private async verifyDeletionTarget(workspace: Workspace): Promise<void> {
    if (
      isRootLikePath(workspace.path) ||
      resolve(workspace.path) === resolve(this.workspaceRoot)
    )
      throw new DaedalusError(
        "VALIDATION",
        "Refusing to delete a root-like workspace path",
      );
    if (await isSymbolicLink(workspace.path))
      throw new DaedalusError(
        "VALIDATION",
        "Refusing to delete a symbolic-link workspace",
      );
    const canonical = await canonicalPath(workspace.path);
    const markerDirectory = join(canonical, MARKER_DIRECTORY);
    const markerPath = join(markerDirectory, MARKER_FILE);
    if (
      (await isSymbolicLink(markerDirectory)) ||
      (await isSymbolicLink(markerPath))
    )
      throw new DaedalusError(
        "VALIDATION",
        "Workspace identity marker must not be a symbolic link",
      );
    let marker: { id?: string };
    try {
      marker = JSON.parse(await readTextFile(markerPath)) as { id?: string };
    } catch {
      throw new DaedalusError(
        "VALIDATION",
        "Workspace identity marker is missing or invalid",
      );
    }
    if (marker.id !== workspace.id)
      throw new DaedalusError(
        "VALIDATION",
        "Workspace identity marker does not match",
      );
  }

  private async isAuthoritativeWorkspace(
    workspace: Workspace,
  ): Promise<boolean> {
    if (
      !(await isDirectory(workspace.path)) ||
      (await isSymbolicLink(workspace.path))
    )
      return false;
    try {
      const marker = JSON.parse(
        await readTextFile(join(workspace.path, MARKER_DIRECTORY, MARKER_FILE)),
      ) as { id?: string };
      return marker.id === workspace.id;
    } catch {
      return false;
    }
  }
}

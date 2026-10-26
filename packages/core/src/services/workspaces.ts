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
import {
  accountModelKey,
  derivedDefaultModel,
  workspaceDefaultAccount,
  type AutoRebirth,
  type Workspace,
} from "../domain";
import {
  normalizeWorkspaceSlug,
  WORKSPACE_NAME_MAX,
  WORKSPACE_SLUG_MAX,
} from "@daedalus/protocol";
import { DaedalusError } from "../errors";
import { isValidModelName } from "./providers";
import type { SqliteRepositories } from "../repositories";
import { applyManualOrder } from "./ordering";
import { ensureWorkspaceContentFiles } from "./workspace-content";

const MARKER_DIRECTORY = ".daedalus";
const MARKER_FILE = "workspace.json";

export function workspaceSlug(value: string): string {
  const slug = normalizeWorkspaceSlug(value);
  if (!slug || slug.length > WORKSPACE_SLUG_MAX) {
    throw new DaedalusError(
      "VALIDATION",
      "Workspace slug must contain 1–63 lowercase letters, numbers, or hyphens",
    );
  }
  return slug;
}

function requiredName(value: string): string {
  const name = value.trim();
  if (!name || name.length > WORKSPACE_NAME_MAX)
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

/**
 * Below 10 a session would be reborn before it had read the brief; the check
 * constraint on the column says the same thing.
 */
export function autoRebirthPercent<T extends AutoRebirth>(value: T): T {
  if (value === null || value === "off") return value;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 10 ||
    value > 100
  )
    throw new DaedalusError(
      "VALIDATION",
      "Automatic rebirth percent must be a whole number from 10 to 100, or off",
    );
  return value;
}

export class WorkspaceService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaceRoot: string,
    private readonly hasLiveAgents: (workspaceId: string) => Promise<boolean>,
    private readonly archiveAgents: (workspaceId: string) => Promise<void>,
    private readonly daedalusHome: string,
    private readonly instructionFilesEnabled: () => boolean = () => true,
    /** Whether workflows are on, which adds a step to the instruction files. */
    private readonly workflowsEnabled: () => boolean = () => false,
    private readonly discardCheckouts: (
      workspaceId: string,
    ) => Promise<void> = async () => {},
    /**
     * The profile id a reference names, null for the default account. Throws
     * for a name with no profile behind it.
     */
    private readonly resolveAccount: (
      provider: "claude" | "codex",
      reference: string | null,
    ) => string | null = (_provider, reference) => {
      if (reference === null || reference.toLowerCase() === "default")
        return null;
      throw new DaedalusError("NOT_FOUND", `No account named '${reference}'`);
    },
    /** Deletes a workspace's secrets from the Keychain before its rows go. */
    private readonly forgetSecrets: (
      workspaceId: string,
    ) => Promise<void> = async () => {},
  ) {}

  async create(input: {
    name: string;
    slug?: string;
    path?: string;
    /** A profile id or name per provider; omitted or `default` is the default. */
    defaultClaudeAccount?: string | null;
    defaultCodexAccount?: string | null;
  }): Promise<Workspace> {
    const name = requiredName(input.name);
    // Resolved before anything is made, so a name with no profile behind it
    // refuses without leaving a folder.
    const defaultClaudeAccount = this.resolveAccount(
      "claude",
      input.defaultClaudeAccount ?? null,
    );
    const defaultCodexAccount = this.resolveAccount(
      "codex",
      input.defaultCodexAccount ?? null,
    );
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
      autoRebirthPercent: null,
      defaultProvider: null,
      defaultModel: null,
      accountModels: {},
      defaultClaudeAccount,
      defaultCodexAccount,
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
        this.workflowsEnabled(),
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
    // A cloud workspace's folder here is a backup nothing writes.
    if (workspace.place !== "cloud")
      await ensureWorkspaceContentFiles(
        workspace.path,
        this.daedalusHome,
        this.instructionFilesEnabled(),
        this.workflowsEnabled(),
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
      /** 10 to 100, `"off"`, or `null` for the global default. */
      autoRebirthPercent?: AutoRebirth;
      /** `null` clears it back to "no preference". */
      defaultProvider?: string | null;
      /**
       * The model of the default provider on its default account (after
       * this change's provider and accounts apply); `null` clears it.
       */
      defaultModel?: string | null;
      /** A profile id or name; `null` or `default` is the default account. */
      defaultClaudeAccount?: string | null;
      defaultCodexAccount?: string | null;
      /**
       * The model one provider account starts with; `null` clears it, so the
       * account starts on the provider's own default.
       */
      accountModel?: {
        provider: string;
        account: string | null;
        model: string | null;
      };
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
    const model = (value: string | null | undefined): string | null => {
      const trimmed = value?.trim() || null;
      if (trimmed !== null && !isValidModelName(trimmed))
        throw new DaedalusError("VALIDATION", "Default model name is invalid");
      return trimmed;
    };
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
      autoRebirthPercent:
        changes.autoRebirthPercent === undefined
          ? workspace.autoRebirthPercent
          : autoRebirthPercent(changes.autoRebirthPercent),
      defaultProvider,
      accountModels: { ...workspace.accountModels },
      defaultClaudeAccount:
        changes.defaultClaudeAccount === undefined
          ? workspace.defaultClaudeAccount
          : this.resolveAccount("claude", changes.defaultClaudeAccount),
      defaultCodexAccount:
        changes.defaultCodexAccount === undefined
          ? workspace.defaultCodexAccount
          : this.resolveAccount("codex", changes.defaultCodexAccount),
      updatedAt: new Date().toISOString(),
    };
    // A model belongs to one provider account, so each is kept under its
    // own key. Changing the provider or account changes which one applies;
    // it never carries a Claude id over to Codex, or a subscription's id to
    // a Bedrock account.
    const setModel = (key: string, value: string | null) => {
      if (value === null) delete updated.accountModels[key];
      else updated.accountModels[key] = value;
    };
    if (changes.defaultModel !== undefined) {
      // A model with no provider to belong to would apply to whichever
      // provider happened to be installed first.
      if (!defaultProvider)
        throw new DaedalusError(
          "VALIDATION",
          "A default model belongs to a provider; set the default provider as well",
        );
      setModel(
        accountModelKey(
          defaultProvider,
          workspaceDefaultAccount(updated, defaultProvider),
        ),
        model(changes.defaultModel),
      );
    }
    if (changes.accountModel) {
      const provider = boardProvider(changes.accountModel.provider);
      if (!provider)
        throw new DaedalusError(
          "VALIDATION",
          "A remembered model needs its provider",
        );
      const account = this.resolveAccount(
        provider,
        changes.accountModel.account,
      );
      setModel(
        accountModelKey(provider, account),
        model(changes.accountModel.model),
      );
    }
    updated.defaultModel = derivedDefaultModel(updated);
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
    await this.forgetSecrets(workspace.id);
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

  // The one way to destroy everything an archived workspace still holds:
  // session worktrees with their branches (unpushed commits included),
  // repository checkouts, the folder and every file in it, and its tasks and
  // sessions. Only an archived workspace qualifies, so it is always a second,
  // deliberate step after archiving.
  async deletePermanently(reference: string): Promise<Workspace> {
    const workspace = await this.get(reference);
    if (!workspace.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        `Workspace '${workspace.slug}' is not archived; archive it before deleting it`,
      );
    if (await this.hasLiveAgents(workspace.id))
      throw new DaedalusError(
        "CONFLICT",
        "Workspace has live agent sessions; stop them before deleting it",
      );
    const folderExists = await pathExists(workspace.path);
    if (folderExists) await this.verifyDeletionTarget(workspace);
    await this.discardCheckouts(workspace.id);
    if (folderExists) await removeDirectory(workspace.path);
    await this.forgetSecrets(workspace.id);
    this.repositories.transaction(() =>
      this.repositories.deleteWorkspace(workspace.id),
    );
    return workspace;
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

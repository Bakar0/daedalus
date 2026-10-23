import { cp, lstat, readdir, rename, rm, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  canonicalPath,
  createDirectoryExclusive,
  ensureDirectory,
  isPathInside,
  pathExists,
  readTextFile,
  writeTextFile,
} from "@daedalus/platform";
import type {
  FileLinkTarget,
  Workspace,
  WorkspaceFile,
  WorkspaceFileEntry,
  WorkspaceImage,
} from "../domain";
import type { DaedalusConfig } from "../config";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { IN_CLOUD_MESSAGE } from "./cloud-launch";
import type { PodMoveSide } from "./move-side";
import { PodFiles } from "./pod-files";
import type { WorkspaceService } from "./workspaces";

export const MAX_VIEWABLE_FILE_BYTES = 1024 * 1024;
export const MAX_VIEWABLE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORTED_FILE_BYTES = 50 * 1024 * 1024;
/** The image types the viewer shows, by extension. */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

/** Whether `readFile` or `readImage` would show the file, by their limits. */
async function isViewableFile(path: string): Promise<boolean> {
  const info = await lstat(path);
  if (IMAGE_MIME_TYPES[extname(path).toLowerCase()])
    return info.size <= MAX_VIEWABLE_IMAGE_BYTES;
  if (info.size > MAX_VIEWABLE_FILE_BYTES) return false;
  const head = new Uint8Array(
    await Bun.file(path).slice(0, 8192).arrayBuffer(),
  );
  return !head.includes(0);
}

/**
 * Top-level folders Daedalus creates and keeps pointing at.
 * `ensureWorkspaceContentFiles` recreates them, so losing one is survivable,
 * but `repos/` and `worktrees/` hold checkouts and session working trees that
 * database rows name by path — renaming either orphans those rows silently.
 */
/**
 * A greyed-out menu item with no explanation reads as a broken one — that is
 * exactly how the first version of this was reported, as "delete does
 * nothing". The reason travels with the entry so the menu can say it.
 */
export function immutableEntryFields(
  refusal: { code: "VALIDATION" | "CONFLICT"; message: string } | undefined,
): { mutable: boolean; immutableReason?: string } {
  return refusal
    ? { mutable: false, immutableReason: refusal.message }
    : { mutable: true };
}

const MANAGED_WORKSPACE_DIRECTORIES = ["repos", "worktrees", "artifacts"];

/**
 * Entries at the workspace root that `ensureWorkspaceContentFiles` recreates.
 *
 * Removing one appeared to do nothing, and that was worse than a refusal: the
 * delete succeeded, and the very next `workspaceContentGet` — which the
 * desktop fires after every mutation — put the file straight back, so from the
 * tree the menu item looked broken. Renaming was worse still, because the
 * rename also succeeded and the original then regenerated beside it, silently
 * leaving two files.
 *
 * Only at the root: a `BRIEF.md` inside a folder is an ordinary file.
 */
const REGENERATED_WORKSPACE_ENTRIES = [
  "BRIEF.md",
  "JOURNAL.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".agents",
  ".claude",
];

/**
 * Top-level folders Daedalus creates and keeps pointing at.
 * `ensureWorkspaceContentFiles` recreates them, so losing one is survivable,
 * but `repos/` and `worktrees/` hold checkouts and session working trees that
 * database rows name by path — renaming either orphans those rows silently.
 */

export function immutableReason(
  repositories: Pick<SqliteRepositories, "listSessionWorktrees">,
  input: {
    workspaceId: string;
    relativePath: string;
    target: string;
  },
): { code: "VALIDATION" | "CONFLICT"; message: string } | undefined {
  const { relativePath } = input;
  if (relativePath === "")
    return {
      code: "VALIDATION",
      message: "The workspace root itself cannot be changed",
    };
  if (relativePath.split(/[\\/]/)[0] === "repos")
    return {
      code: "CONFLICT",
      message: "Reference checkouts are read-only",
    };
  if (MANAGED_WORKSPACE_DIRECTORIES.includes(relativePath))
    return {
      code: "CONFLICT",
      message: `Daedalus manages ${relativePath}/`,
    };
  if (REGENERATED_WORKSPACE_ENTRIES.includes(relativePath))
    return {
      code: "CONFLICT",
      message:
        relativePath.startsWith(".") ||
        relativePath === "AGENTS.md" ||
        relativePath === "CLAUDE.md"
          ? `Daedalus generates ${relativePath} — turn off instruction files in Settings to remove it`
          : `Daedalus regenerates ${relativePath}, so removing it would not stick`,
    };
  const worktree = repositories
    .listSessionWorktrees({ workspaceId: input.workspaceId })
    .find((candidate) => resolve(candidate.path) === input.target);
  if (worktree)
    return {
      code: "CONFLICT",
      message: "A session working tree — remove it from its session",
    };
  return undefined;
}

/** One valid path segment, shared by every verb that takes a new name. */
export function assertEntryName(value: string): string {
  const name = value.trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.length > 255 ||
    /[\\/\0]/.test(name)
  )
    throw new DaedalusError(
      "VALIDATION",
      "File and folder names must be one valid path segment",
    );
  return name;
}

/** How long a removed entry can still be restored. */
export const TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const TRASH_ORIGIN = "origin.json";
const TRASH_ENTRY = "entry";

interface TrashOrigin {
  workspaceId: string;
  /** Relative to the workspace root. */
  path: string;
  removedAt: string;
}

/**
 * `rename`, or a copy and delete when the two paths are on different volumes
 * (a workspace outside the Daedalus home can be).
 */
async function moveAcrossVolumes(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * The files under a workspace root, as the workspace browser shows and edits
 * them. Every path is resolved inside the workspace, and the entries Daedalus
 * keeps pointing at (`repos/`, session worktrees, generated files) are
 * refused here rather than trusted to the renderer.
 */
export class WorkspaceFiles {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly config: DaedalusConfig,
  ) {
    this.podFiles = new PodFiles(repositories);
  }

  private readonly podFiles: PodFiles;
  private podFor: ((workspace: Workspace) => Promise<PodMoveSide>) | undefined;

  /**
   * Set by the context: how to reach the pod of a workspace in the cloud,
   * whose files are there rather than in this Mac's folder.
   */
  usePod(podFor: (workspace: Workspace) => Promise<PodMoveSide>): void {
    this.podFor = podFor;
  }

  /** The pod holding a workspace's files, or undefined while it is here. */
  private async pod(workspace: Workspace): Promise<PodMoveSide | undefined> {
    if (workspace.place !== "cloud") return undefined;
    if (!this.podFor) throw new DaedalusError("CONFLICT", IN_CLOUD_MESSAGE);
    return this.podFor(workspace);
  }

  /**
   * A cloud workspace's brief, journal and top folder, read in its pod, or
   * undefined while the workspace is on this Mac. A pod asleep gives them
   * empty, so the rest of the workspace view still shows.
   */
  async podContent(
    workspace: Workspace,
  ): Promise<
    { brief: string; journal: string; files: WorkspaceFileEntry[] } | undefined
  > {
    if (workspace.place !== "cloud") return undefined;
    let pod: PodMoveSide;
    try {
      pod = (await this.pod(workspace))!;
    } catch (error) {
      if (error instanceof DaedalusError && error.code === "CONFLICT")
        return { brief: "", journal: "", files: [] };
      throw error;
    }
    const text = (path: string) =>
      this.podFiles.readFile(pod, path).then(
        (file) => file.content,
        (error: unknown) => {
          if (error instanceof DaedalusError && error.code === "NOT_FOUND")
            return "";
          throw error;
        },
      );
    return {
      brief: await text("BRIEF.md"),
      journal: await text("JOURNAL.md"),
      files: await this.podFiles.listDirectory(workspace, pod, ""),
    };
  }

  async listDirectory(
    workspaceReference: string,
    requestedPath = "",
  ): Promise<WorkspaceFileEntry[]> {
    const workspace = await this.workspaces.get(workspaceReference);
    const pod = await this.pod(workspace);
    if (pod) return this.podFiles.listDirectory(workspace, pod, requestedPath);
    const { target, relativePath } = await this.resolveVisiblePath(
      workspace,
      requestedPath,
    );
    const targetStat = await lstat(target);
    if (!targetStat.isDirectory())
      throw new DaedalusError(
        "VALIDATION",
        `'${requestedPath}' is not a directory`,
      );
    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.name !== ".git" && (relativePath || entry.name !== ".daedalus"),
      )
      .map((entry) => {
        const path = join(relativePath, entry.name);
        return {
          name: entry.name,
          path,
          kind: entry.isSymbolicLink()
            ? ("symlink" as const)
            : entry.isDirectory()
              ? ("directory" as const)
              : ("file" as const),
          // Carried per row so the renderer never needs a second copy of the
          // rule. A symlink is never offered either: the viewer refuses to
          // open one, and following it out of the workspace is the escape
          // every guard here exists to prevent.
          ...immutableEntryFields(
            entry.isSymbolicLink()
              ? {
                  code: "VALIDATION",
                  message: "Symbolic links cannot be changed here",
                }
              : this.immutableReason({
                  workspaceId: workspace.id,
                  relativePath: path,
                  target: join(target, entry.name),
                }),
          ),
        };
      })
      .sort((left, right) => {
        const rank = (kind: WorkspaceFileEntry["kind"]) =>
          kind === "directory" ? 0 : kind === "file" ? 1 : 2;
        return (
          rank(left.kind) - rank(right.kind) ||
          left.name.localeCompare(right.name)
        );
      });
  }

  async readFile(
    workspaceReference: string,
    requestedPath: string,
  ): Promise<WorkspaceFile> {
    const workspace = await this.workspaces.get(workspaceReference);
    const pod = isAbsolute(requestedPath)
      ? undefined
      : await this.pod(workspace);
    if (pod) return this.podFiles.readFile(pod, requestedPath);
    const { target, relativePath } = await this.resolveOpenablePath(
      workspace,
      requestedPath,
    );
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink())
      throw new DaedalusError(
        "VALIDATION",
        "Symbolic links cannot be opened in the workspace viewer",
      );
    if (!targetStat.isFile())
      throw new DaedalusError("VALIDATION", `'${requestedPath}' is not a file`);
    if (targetStat.size > MAX_VIEWABLE_FILE_BYTES)
      throw new DaedalusError(
        "VALIDATION",
        "Files larger than 1 MB cannot be opened in the workspace viewer",
      );
    const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());
    if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0))
      throw new DaedalusError(
        "VALIDATION",
        "Binary files cannot be opened in the workspace viewer",
      );
    return {
      name: basename(relativePath),
      path: relativePath,
      content: new TextDecoder().decode(bytes),
      format: [".md", ".mdx", ".markdown"].includes(
        extname(relativePath).toLowerCase(),
      )
        ? "markdown"
        : "text",
    };
  }

  /** An image's bytes for the viewer, under the same path rules as a file. */
  async readImage(
    workspaceReference: string,
    requestedPath: string,
  ): Promise<WorkspaceImage> {
    const workspace = await this.workspaces.get(workspaceReference);
    const pod = isAbsolute(requestedPath)
      ? undefined
      : await this.pod(workspace);
    if (pod) return this.podFiles.readImage(pod, requestedPath);
    const { target, relativePath } = await this.resolveOpenablePath(
      workspace,
      requestedPath,
    );
    const mimeType = IMAGE_MIME_TYPES[extname(relativePath).toLowerCase()];
    if (!mimeType)
      throw new DaedalusError(
        "VALIDATION",
        `'${requestedPath}' is not an image the viewer shows`,
      );
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink())
      throw new DaedalusError(
        "VALIDATION",
        "Symbolic links cannot be opened in the workspace viewer",
      );
    if (!targetStat.isFile())
      throw new DaedalusError("VALIDATION", `'${requestedPath}' is not a file`);
    if (targetStat.size > MAX_VIEWABLE_IMAGE_BYTES)
      throw new DaedalusError(
        "VALIDATION",
        "Images larger than 20 MB cannot be opened in the workspace viewer",
      );
    const bytes = Buffer.from(await Bun.file(target).arrayBuffer());
    return {
      name: basename(relativePath),
      path: relativePath,
      mimeType,
      base64: bytes.toString("base64"),
    };
  }

  async writeFile(input: {
    workspace: string;
    path: string;
    content: string;
    expectedContent: string;
  }): Promise<WorkspaceFile> {
    const workspace = await this.workspaces.getActive(input.workspace);
    const pod = isAbsolute(input.path) ? undefined : await this.pod(workspace);
    if (pod) return this.podFiles.writeFile(pod, input);
    const { target, relativePath } = await this.resolveOpenablePath(
      workspace,
      input.path,
    );
    if (relativePath.split(/[\\/]/)[0] === "repos")
      throw new DaedalusError(
        "CONFLICT",
        "Workspace repository references are read-only; edit a session worktree instead",
      );
    const targetStat = await lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink())
      throw new DaedalusError(
        "VALIDATION",
        "Only regular workspace files can be edited",
      );
    if (
      new TextEncoder().encode(input.content).byteLength >
      MAX_VIEWABLE_FILE_BYTES
    )
      throw new DaedalusError(
        "VALIDATION",
        "Files larger than 1 MB cannot be saved in the workspace editor",
      );
    const current = await readTextFile(target);
    if (current !== input.expectedContent)
      throw new DaedalusError(
        "CONFLICT",
        `Workspace file '${input.path}' changed outside the editor; reopen it before saving`,
      );
    const temporaryPath = join(
      dirname(target),
      `.${basename(target)}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, input.content, {
        flag: "wx",
        mode: targetStat.mode,
      });
      await rename(temporaryPath, target);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return this.readFile(workspace.id, input.path);
  }

  async createEntry(input: {
    workspace: string;
    parentPath?: string;
    name: string;
    kind: "file" | "directory";
  }): Promise<WorkspaceFileEntry> {
    const workspace = await this.workspaces.getActive(input.workspace);
    const pod = await this.pod(workspace);
    if (pod) return this.podFiles.createEntry(workspace, pod, input);
    const name = assertEntryName(input.name);
    const parent = await this.resolveVisiblePath(
      workspace,
      input.parentPath ?? "",
    );
    this.assertWritable(parent.relativePath);
    if (!(await lstat(parent.target)).isDirectory())
      throw new DaedalusError("VALIDATION", "New entries require a folder");
    const path = join(parent.relativePath, name);
    if (parent.relativePath === "" && name === ".daedalus")
      throw new DaedalusError(
        "VALIDATION",
        "The .daedalus directory is reserved",
      );
    const target = join(parent.target, name);
    try {
      if (input.kind === "directory") await createDirectoryExclusive(target);
      else await writeTextFile(target, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new DaedalusError(
          "CONFLICT",
          `Workspace path '${path}' already exists`,
        );
      throw error;
    }
    return this.describeEntry(workspace.id, target, path);
  }

  /**
   * Copies a file in from outside the workspace, such as one dropped from
   * Finder: any bytes, text or not, under the same rules as a new entry. An
   * existing name is a conflict, never an overwrite.
   */
  async importFile(input: {
    workspace: string;
    parentPath?: string;
    name: string;
    base64: string;
  }): Promise<WorkspaceFileEntry> {
    const placed = await this.workspaces.getActive(input.workspace);
    const pod = await this.pod(placed);
    if (pod) return this.podFiles.importFile(placed, pod, input);
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.byteLength > MAX_IMPORTED_FILE_BYTES)
      throw new DaedalusError(
        "VALIDATION",
        "Files larger than 50 MB cannot be copied into the workspace",
      );
    const entry = await this.createEntry({
      workspace: input.workspace,
      parentPath: input.parentPath,
      name: input.name,
      kind: "file",
    });
    const workspace = await this.workspaces.getActive(input.workspace);
    const { target } = await this.resolveMutablePath(workspace, entry.path);
    await Bun.write(target, bytes);
    return this.describeEntry(workspace.id, target, entry.path);
  }

  /**
   * Renames one entry in place. The name is a single path segment, exactly as
   * `createEntry` takes one; moving between folders is `moveEntry`.
   */
  async renameEntry(input: {
    workspace: string;
    path: string;
    name: string;
  }): Promise<WorkspaceFileEntry> {
    const workspace = await this.workspaces.getActive(input.workspace);
    const pod = await this.pod(workspace);
    if (pod) return this.podFiles.renameEntry(workspace, pod, input);
    const name = assertEntryName(input.name);
    const source = await this.resolveMutablePath(workspace, input.path);
    const destinationPath = join(dirname(source.relativePath), name);
    const destination = await this.resolveDestination(
      workspace,
      destinationPath,
    );
    await this.assertVacant(destination.target, source.target, destinationPath);
    await rename(source.target, destination.target);
    return this.describeEntry(
      workspace.id,
      destination.target,
      destinationPath,
    );
  }

  /**
   * Moves an entry into another folder, keeping its name. The destination is a
   * folder path, or `""` for the workspace root.
   */
  async moveEntry(input: {
    workspace: string;
    path: string;
    destinationPath: string;
  }): Promise<WorkspaceFileEntry> {
    const workspace = await this.workspaces.getActive(input.workspace);
    const pod = await this.pod(workspace);
    if (pod) return this.podFiles.moveEntry(workspace, pod, input);
    const source = await this.resolveMutablePath(workspace, input.path);
    const folder = await this.resolveVisiblePath(
      workspace,
      input.destinationPath,
    );
    this.assertWritable(folder.relativePath);
    if (!(await lstat(folder.target)).isDirectory())
      throw new DaedalusError(
        "VALIDATION",
        `'${input.destinationPath}' is not a folder`,
      );
    // `rename` answers this with EINVAL, which reaches the user as a bare
    // errno. A folder cannot contain itself, and saying so is cheap.
    if (
      folder.target === source.target ||
      isPathInside(source.target, folder.target)
    )
      throw new DaedalusError(
        "VALIDATION",
        "A folder cannot be moved inside itself",
      );
    const name = basename(source.relativePath);
    const destinationPath = join(folder.relativePath, name);
    if (destinationPath === source.relativePath)
      return this.describeEntry(
        workspace.id,
        source.target,
        source.relativePath,
      );
    const destination = await this.resolveDestination(
      workspace,
      destinationPath,
    );
    await this.assertVacant(destination.target, source.target, destinationPath);
    await rename(source.target, destination.target);
    return this.describeEntry(
      workspace.id,
      destination.target,
      destinationPath,
    );
  }

  /**
   * Removes an entry, and everything under it when it is a folder, by moving
   * it into Daedalus's trash so `restoreEntry` can put it back. The returned
   * `trashId` names it there. Anything in the trash longer than
   * `TRASH_KEEP_MS` is deleted for good on the next remove.
   */
  async removeEntry(input: {
    workspace: string;
    path: string;
  }): Promise<WorkspaceFileEntry & { trashId: string }> {
    const workspace = await this.workspaces.getActive(input.workspace);
    const pod = await this.pod(workspace);
    if (pod) return this.podFiles.removeEntry(workspace, pod, input);
    const source = await this.resolveMutablePath(workspace, input.path);
    const entry = await this.describeEntry(
      workspace.id,
      source.target,
      source.relativePath,
    );
    const trashId = crypto.randomUUID();
    const holder = join(this.trashRoot, trashId);
    await ensureDirectory(holder);
    const origin: TrashOrigin = {
      workspaceId: workspace.id,
      path: source.relativePath,
      removedAt: new Date().toISOString(),
    };
    try {
      await writeFile(join(holder, TRASH_ORIGIN), JSON.stringify(origin));
      await moveAcrossVolumes(source.target, join(holder, TRASH_ENTRY));
    } catch (error) {
      await rm(holder, { recursive: true, force: true });
      throw error;
    }
    void this.emptyTrash().catch(() => {});
    return { ...entry, trashId };
  }

  /** Puts a removed entry back where it was, if nothing has taken its place. */
  async restoreEntry(input: {
    workspace: string;
    trashId: string;
  }): Promise<WorkspaceFileEntry> {
    const workspace = await this.workspaces.getActive(input.workspace);
    const pod = await this.pod(workspace);
    if (pod) return this.podFiles.restoreEntry(workspace, pod, input);
    if (!/^[0-9a-f-]{36}$/.test(input.trashId))
      throw new DaedalusError("VALIDATION", "Not a trash id");
    const holder = join(this.trashRoot, input.trashId);
    let origin: TrashOrigin;
    try {
      origin = JSON.parse(
        await readTextFile(join(holder, TRASH_ORIGIN)),
      ) as TrashOrigin;
    } catch {
      throw new DaedalusError(
        "NOT_FOUND",
        "That entry is no longer in the trash",
      );
    }
    if (origin.workspaceId !== workspace.id)
      throw new DaedalusError(
        "VALIDATION",
        "That entry was removed from another workspace",
      );
    const destination = await this.resolveDestination(workspace, origin.path);
    if (await pathExists(destination.target))
      throw new DaedalusError(
        "CONFLICT",
        `Workspace path '${origin.path}' already exists`,
      );
    await moveAcrossVolumes(join(holder, TRASH_ENTRY), destination.target);
    await rm(holder, { recursive: true, force: true });
    return this.describeEntry(
      workspace.id,
      destination.target,
      destination.relativePath,
    );
  }

  private get trashRoot(): string {
    return join(this.config.home, "trash");
  }

  /** Deletes for good whatever has been in the trash past `TRASH_KEEP_MS`. */
  private async emptyTrash(): Promise<void> {
    const cutoff = Date.now() - TRASH_KEEP_MS;
    const holders = await readdir(this.trashRoot).catch(() => []);
    await Promise.all(
      holders.map(async (name) => {
        const holder = join(this.trashRoot, name);
        const info = await lstat(holder).catch(() => undefined);
        if (info && info.mtimeMs < cutoff)
          await rm(holder, { recursive: true, force: true });
      }),
    );
  }

  /**
   * Where a path printed in a terminal points. A relative path is tried
   * against each base directory in turn (the session's folder, then its
   * worktrees), then against the root of the workspace each one is in, since
   * agents also name workspace files like `artifacts/notes.md` from a
   * worktree; the first existing file wins. A file outside every active
   * workspace is still a link, by its real absolute path, which the editor
   * opens where it is (see `resolveOpenablePath`). Git and Daedalus internals
   * inside a workspace are not links.
   */
  async resolveFileLink(input: {
    path: string;
    baseDirectories: readonly string[];
  }): Promise<FileLinkTarget | null> {
    const home = Bun.env.HOME ?? "";
    const expanded = input.path.startsWith("~/")
      ? join(home, input.path.slice(2))
      : input.path;
    const workspaces = await this.workspaces.list();
    const roots = await Promise.all(
      workspaces.map(async (workspace) => ({
        workspace,
        canonical: await canonicalPath(workspace.path).catch(() => null),
      })),
    );
    const bases = input.baseDirectories.filter((directory) =>
      isAbsolute(directory),
    );
    const baseRoots = await Promise.all(
      bases.map(async (directory) => {
        const real = await canonicalPath(directory).catch(() => null);
        return (
          (real &&
            roots.find(
              (root) =>
                root.canonical &&
                (root.canonical === real || isPathInside(root.canonical, real)),
            )?.canonical) ??
          null
        );
      }),
    );
    const candidates = isAbsolute(expanded)
      ? [expanded]
      : [
          ...new Set(
            [
              ...bases,
              ...baseRoots.filter((root): root is string => root !== null),
            ].map((directory) => resolve(directory, expanded)),
          ),
        ];
    for (const candidate of candidates) {
      if (!(await pathExists(candidate))) continue;
      if (!(await lstat(candidate)).isFile()) continue;
      const real = await canonicalPath(candidate);
      const owner = roots.find(
        (root) => root.canonical && isPathInside(root.canonical, real),
      );
      if (!owner?.canonical)
        return {
          workspaceId: null,
          path: real,
          viewable: await isViewableFile(real),
        };
      const path = relative(owner.canonical, real);
      if (
        path
          .split(/[\\/]/)
          .some((part) => part === ".daedalus" || part === ".git")
      )
        continue;
      return { workspaceId: owner.workspace.id, path };
    }
    return null;
  }

  /**
   * Copies files or folders into a workspace folder: entries of this
   * workspace, or anything on disk the user copied in Finder. Sources are
   * absolute paths, because a paste from Finder has no workspace to be
   * relative to. A name that is taken gets VS Code's suffix, `name copy.ext`
   * then `name copy 2.ext`, so a paste never overwrites.
   */
  async copyEntries(input: {
    workspace: string;
    sources: readonly string[];
    destinationPath: string;
  }): Promise<WorkspaceFileEntry[]> {
    const workspace = await this.workspaces.getActive(input.workspace);
    // Pasting from Finder into the pod is not offered yet.
    if (workspace.place === "cloud")
      throw new DaedalusError("CONFLICT", IN_CLOUD_MESSAGE);
    const folder = await this.resolveVisiblePath(
      workspace,
      input.destinationPath,
    );
    this.assertWritable(folder.relativePath);
    if (!(await lstat(folder.target)).isDirectory())
      throw new DaedalusError(
        "VALIDATION",
        `'${input.destinationPath}' is not a folder`,
      );
    const copied: WorkspaceFileEntry[] = [];
    for (const source of input.sources) {
      if (!isAbsolute(source))
        throw new DaedalusError("VALIDATION", "Copy sources must be absolute");
      if (!(await pathExists(source)))
        throw new DaedalusError("NOT_FOUND", `'${source}' was not found`);
      const sourceReal = await canonicalPath(source);
      const folderReal = await canonicalPath(folder.target);
      if (folderReal === sourceReal || isPathInside(sourceReal, folderReal))
        throw new DaedalusError(
          "VALIDATION",
          "A folder cannot be copied inside itself",
        );
      const name = await this.vacantCopyName(folder.target, basename(source));
      const relativePath = join(folder.relativePath, name);
      if (folder.relativePath === "" && name === ".daedalus")
        throw new DaedalusError(
          "VALIDATION",
          "The .daedalus directory is reserved",
        );
      const target = join(folder.target, name);
      await cp(source, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
      copied.push(await this.describeEntry(workspace.id, target, relativePath));
    }
    return copied;
  }

  private async vacantCopyName(folder: string, name: string): Promise<string> {
    if (!(await pathExists(join(folder, name)))) return name;
    const extension = extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let attempt = 1; attempt < 1000; attempt += 1) {
      const candidate = `${stem} copy${attempt === 1 ? "" : ` ${attempt}`}${extension}`;
      if (!(await pathExists(join(folder, candidate)))) return candidate;
    }
    throw new DaedalusError("CONFLICT", `No free name for a copy of '${name}'`);
  }

  /**
   * Why an entry cannot be renamed, moved or removed, or `undefined` when it
   * can be.
   *
   * The single source for both the refusal below and the `mutable` flag every
   * listing carries. Keeping those apart is exactly what let the menu offer a
   * delete that the service would quietly undo.
   */
  private immutableReason(input: {
    workspaceId: string;
    relativePath: string;
    target: string;
  }): { code: "VALIDATION" | "CONFLICT"; message: string } | undefined {
    return immutableReason(this.repositories, input);
  }

  private async describeEntry(
    workspaceId: string,
    target: string,
    relativePath: string,
  ): Promise<WorkspaceFileEntry> {
    const entry = await lstat(target);
    return {
      name: basename(relativePath),
      path: relativePath,
      kind: entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : "file",
      ...immutableEntryFields(
        this.immutableReason({ workspaceId, relativePath, target }),
      ),
    };
  }

  /**
   * `repos/` holds pinned read-only checkouts the repository library owns, and
   * the renderer already disables the actions that would write there. It is
   * checked again here because a service that trusts its caller is not a
   * guard — the RPC surface is reachable without the UI.
   */
  private assertWritable(relativePath: string): void {
    if (relativePath.split(/[\\/]/)[0] === "repos")
      throw new DaedalusError(
        "CONFLICT",
        "Workspace repository references are managed and read-only",
      );
  }

  /**
   * Resolves an existing path that is about to be renamed, moved or removed.
   *
   * Beyond the escape guard this refuses the entries Daedalus itself keeps
   * pointing at: the workspace root, the managed top-level folders, and any
   * registered session worktree. Every one of those has a database row naming
   * its path, and renaming it would not fail — it would quietly orphan the
   * row and leave an agent's working tree unreachable.
   */
  private async resolveMutablePath(
    workspace: Workspace,
    requestedPath: string,
  ): Promise<{ target: string; relativePath: string }> {
    const resolved = await this.resolveVisiblePath(workspace, requestedPath);
    const refusal = this.immutableReason({
      workspaceId: workspace.id,
      relativePath: resolved.relativePath,
      target: resolved.target,
    });
    if (refusal) throw new DaedalusError(refusal.code, refusal.message);
    return resolved;
  }

  /**
   * Resolves a path that is not supposed to exist yet. `resolveVisiblePath`
   * cannot do this — it requires the target to exist — so the parent is
   * resolved through it and the new segment joined on, which is how
   * `createEntry` reaches the same guarantee.
   */
  private async resolveDestination(
    workspace: Workspace,
    requestedPath: string,
  ): Promise<{ target: string; relativePath: string }> {
    const parent = await this.resolveVisiblePath(
      workspace,
      dirname(requestedPath) === "." ? "" : dirname(requestedPath),
    );
    this.assertWritable(parent.relativePath);
    const name = basename(requestedPath);
    if (parent.relativePath === "" && name === ".daedalus")
      throw new DaedalusError(
        "VALIDATION",
        "The .daedalus directory is reserved",
      );
    return {
      target: join(parent.target, name),
      relativePath: join(parent.relativePath, name),
    };
  }

  /**
   * Refuses to land on something that is already there.
   *
   * This is not politeness: `rename` overwrites an existing file silently and
   * reports success, so without this check renaming `notes.md` onto
   * `README.md` destroys `README.md` and says nothing.
   *
   * The exception is the one this filesystem makes. macOS is case-insensitive
   * but case-preserving, so `README.md` "already exists" when the file on disk
   * is `Readme.md` — and refusing there would make a case-only rename
   * impossible. `realpath` reports the stored spelling, so when both sides
   * resolve to the same real path they are the same entry reached by two
   * spellings, and the rename is a change of case rather than a collision.
   */
  private async assertVacant(
    target: string,
    source: string,
    relativePath: string,
  ): Promise<void> {
    if (!(await pathExists(target))) return;
    const [targetReal, sourceReal] = await Promise.all([
      canonicalPath(target),
      canonicalPath(source),
    ]);
    if (targetReal === sourceReal) return;
    throw new DaedalusError(
      "CONFLICT",
      `Workspace path '${relativePath}' already exists`,
    );
  }

  /**
   * Where a file the editor reads or saves lives. A workspace path goes
   * through every check `resolveVisiblePath` makes. An absolute path is a file
   * outside the workspace that a terminal link opened, which the user chose
   * by clicking it, so it is used where it is; the callers still refuse
   * symbolic links, folders, and files too large or binary to show.
   */
  private async resolveOpenablePath(
    workspace: Workspace,
    requestedPath: string,
  ): Promise<{ target: string; relativePath: string }> {
    if (!isAbsolute(requestedPath))
      return this.resolveVisiblePath(workspace, requestedPath);
    const target = resolve(requestedPath);
    return { target, relativePath: target };
  }

  /**
   * Resolves an existing path inside the workspace. Refuses an absolute path,
   * one that escapes the root (also through a symlink), and anything under
   * `.daedalus` or `.git`.
   */
  async resolveVisiblePath(
    workspace: Workspace,
    requestedPath: string,
  ): Promise<{ target: string; relativePath: string }> {
    if (isAbsolute(requestedPath))
      throw new DaedalusError("VALIDATION", "Workspace paths must be relative");
    const target = resolve(workspace.path, requestedPath || ".");
    if (
      target !== resolve(workspace.path) &&
      !isPathInside(workspace.path, target)
    )
      throw new DaedalusError(
        "VALIDATION",
        "Workspace path escapes the workspace root",
      );
    const relativePath = relative(workspace.path, target);
    if (
      relativePath
        .split(/[\\/]/)
        .some((segment) => segment === ".daedalus" || segment === ".git")
    )
      throw new DaedalusError(
        "VALIDATION",
        "Internal workspace and Git metadata are not visible",
      );
    if (!(await pathExists(target)))
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace path '${requestedPath}' was not found`,
      );
    const [workspaceCanonical, targetCanonical] = await Promise.all([
      canonicalPath(workspace.path),
      canonicalPath(target),
    ]);
    if (
      targetCanonical !== workspaceCanonical &&
      !isPathInside(workspaceCanonical, targetCanonical)
    )
      throw new DaedalusError(
        "VALIDATION",
        "Workspace path resolves outside the workspace root",
      );
    return { target, relativePath };
  }
}

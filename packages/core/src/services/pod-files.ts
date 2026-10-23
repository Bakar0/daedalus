import { basename, extname, join, posix } from "node:path";
import type {
  Workspace,
  WorkspaceFile,
  WorkspaceFileEntry,
  WorkspaceImage,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { must, type PodMoveSide } from "./move-side";
import {
  assertEntryName,
  IMAGE_MIME_TYPES,
  immutableEntryFields,
  immutableReason,
  MAX_IMPORTED_FILE_BYTES,
  MAX_VIEWABLE_FILE_BYTES,
  MAX_VIEWABLE_IMAGE_BYTES,
} from "./workspace-files";

/** Folders at the pod's root that are never workspace content. */
const POD_HIDDEN = new Set([
  ".daedalus",
  ".home",
  ".daedalus-move",
  ".daedalus-trash",
]);
/** Where a removed entry waits in the pod, for `restore`. */
const POD_TRASH = ".daedalus-trash";

type Kind = "directory" | "file" | "symlink";

/**
 * Lists a folder's entries, one `<d|f|l>\t<name>\0` each. Plain bash, so it
 * runs the same in the pod and in a test standing in for it.
 */
const LIST_SCRIPT = `cd -- "$1" || exit 2
shopt -s nullglob dotglob
for entry in *; do
  if [ -L "$entry" ]; then kind=l
  elif [ -d "$entry" ]; then kind=d
  else kind=f; fi
  printf '%s\\t%s\\0' "$kind" "$entry"
done`;

/**
 * What a path is, walking it one part at a time so a link anywhere on the
 * way is seen, never followed: `d`, `f` or `l`, exit 2 when missing.
 */
const KIND_SCRIPT = `set -f
cur=.
IFS=/
for part in $1; do
  cur="$cur/$part"
  if [ -L "$cur" ]; then printf l; exit 0; fi
done
[ -e "$cur" ] || exit 2
if [ -d "$cur" ]; then printf d; else printf f; fi`;

/**
 * A workspace's files while it lives in the cloud: the explorer and editor
 * read and write the pod's folder through its runner, under the rules this
 * Mac's folder has. A link is listed but never opened or written through.
 */
export class PodFiles {
  constructor(
    private readonly repositories: Pick<
      SqliteRepositories,
      "listSessionWorktrees"
    >,
  ) {}

  async listDirectory(
    workspace: Workspace,
    pod: PodMoveSide,
    requestedPath: string,
  ): Promise<WorkspaceFileEntry[]> {
    const path = visiblePath(requestedPath);
    if ((await this.#kind(pod, path)) !== "directory")
      throw new DaedalusError(
        "VALIDATION",
        `'${requestedPath}' is not a directory`,
      );
    const listed = await must(pod, ".", "bash", [
      "-c",
      LIST_SCRIPT,
      "bash",
      path || ".",
    ]);
    const entries: WorkspaceFileEntry[] = [];
    for (const line of listed.split("\0")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const kind = KINDS[line.slice(0, tab)];
      const name = line.slice(tab + 1);
      if (!kind || !name || name === ".git") continue;
      if (!path && POD_HIDDEN.has(name)) continue;
      entries.push(this.#entry(workspace, posix.join(path, name), kind));
    }
    const rank = (kind: Kind) =>
      kind === "directory" ? 0 : kind === "file" ? 1 : 2;
    return entries.sort(
      (left, right) =>
        rank(left.kind) - rank(right.kind) ||
        left.name.localeCompare(right.name),
    );
  }

  async readFile(
    pod: PodMoveSide,
    requestedPath: string,
  ): Promise<WorkspaceFile> {
    const path = visiblePath(requestedPath);
    const bytes = await this.#read(pod, path, MAX_VIEWABLE_FILE_BYTES, "1 MB");
    if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0))
      throw new DaedalusError(
        "VALIDATION",
        "Binary files cannot be opened in the workspace viewer",
      );
    return {
      name: basename(path),
      path,
      content: new TextDecoder().decode(bytes),
      format: [".md", ".mdx", ".markdown"].includes(extname(path).toLowerCase())
        ? "markdown"
        : "text",
    };
  }

  async readImage(
    pod: PodMoveSide,
    requestedPath: string,
  ): Promise<WorkspaceImage> {
    const path = visiblePath(requestedPath);
    const mimeType = IMAGE_MIME_TYPES[extname(path).toLowerCase()];
    if (!mimeType)
      throw new DaedalusError(
        "VALIDATION",
        `'${requestedPath}' is not an image the viewer shows`,
      );
    const bytes = await this.#read(
      pod,
      path,
      MAX_VIEWABLE_IMAGE_BYTES,
      "20 MB",
    );
    return {
      name: basename(path),
      path,
      mimeType,
      base64: Buffer.from(bytes).toString("base64"),
    };
  }

  async writeFile(
    pod: PodMoveSide,
    input: { path: string; content: string; expectedContent: string },
  ): Promise<WorkspaceFile> {
    const path = visiblePath(input.path);
    assertWritable(path);
    const bytes = new TextEncoder().encode(input.content);
    if (bytes.byteLength > MAX_VIEWABLE_FILE_BYTES)
      throw new DaedalusError(
        "VALIDATION",
        "Files larger than 1 MB cannot be saved in the workspace editor",
      );
    const current = new TextDecoder().decode(
      await this.#read(pod, path, MAX_VIEWABLE_FILE_BYTES, "1 MB"),
    );
    if (current !== input.expectedContent)
      throw new DaedalusError(
        "CONFLICT",
        `Workspace file '${input.path}' changed outside the editor; reopen it before saving`,
      );
    await pod.writeFile(path, bytes);
    return this.readFile(pod, path);
  }

  async createEntry(
    workspace: Workspace,
    pod: PodMoveSide,
    input: { parentPath?: string; name: string; kind: "file" | "directory" },
  ): Promise<WorkspaceFileEntry> {
    const name = assertEntryName(input.name);
    const parent = visiblePath(input.parentPath ?? "");
    assertWritable(parent);
    if ((await this.#kind(pod, parent)) !== "directory")
      throw new DaedalusError("VALIDATION", "New entries require a folder");
    if (!parent && POD_HIDDEN.has(name))
      throw new DaedalusError("VALIDATION", `The ${name} folder is reserved`);
    const path = posix.join(parent, name);
    if ((await this.#kind(pod, path)) !== undefined)
      throw new DaedalusError(
        "CONFLICT",
        `Workspace path '${path}' already exists`,
      );
    if (input.kind === "directory") await must(pod, ".", "mkdir", ["--", path]);
    else await pod.writeFile(path, new Uint8Array());
    return this.#entry(workspace, path, input.kind);
  }

  async importFile(
    workspace: Workspace,
    pod: PodMoveSide,
    input: { parentPath?: string; name: string; base64: string },
  ): Promise<WorkspaceFileEntry> {
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.byteLength > MAX_IMPORTED_FILE_BYTES)
      throw new DaedalusError(
        "VALIDATION",
        "Files larger than 50 MB cannot be copied into the workspace",
      );
    const entry = await this.createEntry(workspace, pod, {
      ...(input.parentPath !== undefined
        ? { parentPath: input.parentPath }
        : {}),
      name: input.name,
      kind: "file",
    });
    await pod.writeFile(entry.path, new Uint8Array(bytes));
    return entry;
  }

  async renameEntry(
    workspace: Workspace,
    pod: PodMoveSide,
    input: { path: string; name: string },
  ): Promise<WorkspaceFileEntry> {
    const name = assertEntryName(input.name);
    const source = await this.#mutable(workspace, pod, input.path);
    const parent = posix.dirname(source.path);
    return this.#move(
      workspace,
      pod,
      source,
      posix.join(parent === "." ? "" : parent, name),
    );
  }

  async moveEntry(
    workspace: Workspace,
    pod: PodMoveSide,
    input: { path: string; destinationPath: string },
  ): Promise<WorkspaceFileEntry> {
    const source = await this.#mutable(workspace, pod, input.path);
    const folder = visiblePath(input.destinationPath);
    assertWritable(folder);
    if ((await this.#kind(pod, folder)) !== "directory")
      throw new DaedalusError(
        "VALIDATION",
        `'${input.destinationPath}' is not a folder`,
      );
    if (folder === source.path || folder.startsWith(`${source.path}/`))
      throw new DaedalusError(
        "VALIDATION",
        "A folder cannot be moved inside itself",
      );
    const destination = posix.join(folder, basename(source.path));
    if (destination === source.path)
      return this.#entry(workspace, source.path, source.kind);
    return this.#move(workspace, pod, source, destination);
  }

  /**
   * Moves an entry into the pod's trash, outside what the explorer lists,
   * so `restoreEntry` can put it back. A move home leaves the trash behind.
   */
  async removeEntry(
    workspace: Workspace,
    pod: PodMoveSide,
    input: { path: string },
  ): Promise<WorkspaceFileEntry & { trashId: string }> {
    const source = await this.#mutable(workspace, pod, input.path);
    const trashId = crypto.randomUUID();
    const holder = posix.join(POD_TRASH, trashId);
    await must(pod, ".", "mkdir", ["-p", "--", holder]);
    await pod.writeFile(
      posix.join(holder, "origin.json"),
      new TextEncoder().encode(
        JSON.stringify({ workspaceId: workspace.id, path: source.path }),
      ),
    );
    await must(pod, ".", "mv", ["--", source.path, `${holder}/entry`]);
    return { ...this.#entry(workspace, source.path, source.kind), trashId };
  }

  async restoreEntry(
    workspace: Workspace,
    pod: PodMoveSide,
    input: { trashId: string },
  ): Promise<WorkspaceFileEntry> {
    if (!/^[0-9a-f-]{36}$/.test(input.trashId))
      throw new DaedalusError("VALIDATION", "Not a trash id");
    const holder = posix.join(POD_TRASH, input.trashId);
    let origin: { workspaceId?: unknown; path?: unknown };
    try {
      origin = JSON.parse(
        new TextDecoder().decode(
          (await pod.readFile(posix.join(holder, "origin.json")))!,
        ),
      ) as typeof origin;
    } catch {
      throw new DaedalusError(
        "NOT_FOUND",
        "That entry is no longer in the trash",
      );
    }
    if (origin.workspaceId !== workspace.id || typeof origin.path !== "string")
      throw new DaedalusError(
        "VALIDATION",
        "That entry was removed from another workspace",
      );
    const path = visiblePath(origin.path);
    assertWritable(path);
    if ((await this.#kind(pod, path)) !== undefined)
      throw new DaedalusError(
        "CONFLICT",
        `Workspace path '${path}' already exists`,
      );
    const kind = await this.#kind(pod, `${holder}/entry`, true);
    if (!kind)
      throw new DaedalusError(
        "NOT_FOUND",
        "That entry is no longer in the trash",
      );
    await must(pod, ".", "mv", ["--", `${holder}/entry`, path]);
    await pod.remove(holder);
    return this.#entry(workspace, path, kind);
  }

  async #move(
    workspace: Workspace,
    pod: PodMoveSide,
    source: { path: string; kind: Kind },
    destination: string,
  ): Promise<WorkspaceFileEntry> {
    const parent = posix.dirname(destination);
    assertWritable(parent === "." ? "" : parent);
    if (!parent.includes("/") && POD_HIDDEN.has(basename(destination)))
      throw new DaedalusError(
        "VALIDATION",
        `The ${basename(destination)} folder is reserved`,
      );
    visiblePath(destination);
    if ((await this.#kind(pod, destination)) !== undefined)
      throw new DaedalusError(
        "CONFLICT",
        `Workspace path '${destination}' already exists`,
      );
    await must(pod, ".", "mv", ["--", source.path, destination]);
    return this.#entry(workspace, destination, source.kind);
  }

  async #mutable(
    workspace: Workspace,
    pod: PodMoveSide,
    requestedPath: string,
  ): Promise<{ path: string; kind: Kind }> {
    const path = visiblePath(requestedPath);
    const kind = await this.#kind(pod, path);
    if (!kind)
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace path '${requestedPath}' was not found`,
      );
    const refusal = immutableReason(this.repositories, {
      workspaceId: workspace.id,
      relativePath: path,
      target: join(workspace.path, path),
    });
    if (refusal) throw new DaedalusError(refusal.code, refusal.message);
    return { path, kind };
  }

  async #read(
    pod: PodMoveSide,
    path: string,
    maxBytes: number,
    limit: string,
  ): Promise<Uint8Array> {
    const kind = await this.#kind(pod, path);
    if (kind === "symlink")
      throw new DaedalusError(
        "VALIDATION",
        "Symbolic links cannot be opened in the workspace viewer",
      );
    if (kind !== "file")
      throw new DaedalusError(
        kind ? "VALIDATION" : "NOT_FOUND",
        kind ? `'${path}' is not a file` : `'${path}' was not found`,
      );
    const size = Number(
      /^\s*(\d+)/.exec(await must(pod, ".", "wc", ["-c", "--", path]))?.[1],
    );
    if (!(size <= maxBytes))
      throw new DaedalusError(
        "VALIDATION",
        `Files larger than ${limit} cannot be opened in the workspace viewer`,
      );
    return (await pod.readFile(path)) ?? new Uint8Array();
  }

  /** What a path in the pod is, or undefined when it is not there. */
  async #kind(
    pod: PodMoveSide,
    path: string,
    hidden = false,
  ): Promise<Kind | undefined> {
    if (!hidden) visiblePath(path);
    if (!path) return "directory";
    const result = await pod.run(".", "bash", [
      "-c",
      KIND_SCRIPT,
      "bash",
      path,
    ]);
    if (result.exitCode === 2) return undefined;
    if (result.exitCode !== 0)
      throw new DaedalusError(
        "DEPENDENCY",
        `The cloud workspace could not read ${path}: ${result.stderr.trim()}`,
      );
    return KINDS[result.stdout.trim()];
  }

  #entry(workspace: Workspace, path: string, kind: Kind): WorkspaceFileEntry {
    return {
      name: basename(path),
      path,
      kind,
      ...immutableEntryFields(
        kind === "symlink"
          ? {
              code: "VALIDATION",
              message: "Symbolic links cannot be changed here",
            }
          : immutableReason(this.repositories, {
              workspaceId: workspace.id,
              relativePath: path,
              target: join(workspace.path, path),
            }),
      ),
    };
  }
}

const KINDS: Record<string, Kind> = {
  d: "directory",
  f: "file",
  l: "symlink",
};

/**
 * A path the explorer may name in the pod: relative, inside the workspace,
 * and never Daedalus's or git's own.
 */
function visiblePath(requested: string): string {
  if (requested.startsWith("/") || requested.includes("\0"))
    throw new DaedalusError("VALIDATION", "Workspace paths must be relative");
  const path = posix.normalize(requested || ".");
  if (path === ".") return "";
  const parts = path.split("/");
  if (parts[0] === "..")
    throw new DaedalusError(
      "VALIDATION",
      "Workspace path escapes the workspace root",
    );
  if (parts.includes(".git") || POD_HIDDEN.has(parts[0]!))
    throw new DaedalusError(
      "VALIDATION",
      "Internal workspace and Git metadata are not visible",
    );
  return path.replace(/\/$/, "");
}

function assertWritable(path: string): void {
  if (path.split("/")[0] === "repos")
    throw new DaedalusError(
      "CONFLICT",
      "Workspace repository references are managed and read-only",
    );
}

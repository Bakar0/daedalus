import {
  DaedalusError,
  type Workspace,
  type WorkspaceArchiveResult,
} from "@daedalus/core";

/**
 * The archived workspace, or why it was not: a workspace in the cloud comes
 * home first, which a cap can stop.
 */
export function workspaceArchivedOrExplain(
  archived: WorkspaceArchiveResult,
  reference: string,
): Workspace {
  if (archived.status === "archived") return archived.workspace;
  throw new DaedalusError(
    "CONFLICT",
    `This workspace cannot come home from the cloud, so it is not archived: ${archived.items
      .map(
        (item) =>
          `${item.what} is ${Math.ceil(item.bytes / 1048576)} MB, over ${Math.round(item.maxBytes / 1048576)} MB`,
      )
      .join("; ")}`,
  );
}

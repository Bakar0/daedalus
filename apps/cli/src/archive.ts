import {
  DaedalusError,
  type Workspace,
  type WorkspaceArchiveResult,
} from "@daedalus/core";

/** `--approve a,b`: the paths a workspace may bring home from the cloud. */
export function approvedPaths(value: string | undefined): string[] | undefined {
  const paths = value
    ?.split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  return paths?.length ? paths : undefined;
}

/**
 * The archived workspace, or why it was not: a workspace in the cloud comes
 * home first, and asks before it brings files that steer agents. The CLI
 * cannot ask, so it says which flag answers.
 */
export function workspaceArchivedOrExplain(
  archived: WorkspaceArchiveResult,
  reference: string,
): Workspace {
  if (archived.status === "archived") return archived.workspace;
  if (archived.status === "needsApproval")
    throw new DaedalusError(
      "CONFLICT",
      `Coming home from the cloud, this workspace would bring files that steer agents: ${archived.paths.join(", ")}. Look at them, then run 'daedal workspace archive ${reference} --approve ${archived.paths.join(",")}'`,
    );
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

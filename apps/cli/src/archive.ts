import {
  DaedalusError,
  type AgentSession,
  type SessionArchiveResult,
  type Workspace,
  type WorkspaceArchiveResult,
} from "@daedalus/core";

/** `--approve a,b`: the paths a cloud session may bring home. */
export function approvedPaths(value: string | undefined): string[] | undefined {
  const paths = value
    ?.split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  return paths?.length ? paths : undefined;
}

/**
 * The archived session, or why it was not: a cloud session asks before it
 * brings files that steer agents home, and before it is archived without
 * the cloud's changes. The CLI cannot ask, so it says which flag answers.
 */
export function archivedOrExplain(
  archived: SessionArchiveResult,
  reference: string,
): AgentSession {
  if (archived.status === "archived") return archived.session;
  if (archived.status === "needsApproval")
    throw new DaedalusError(
      "CONFLICT",
      `Coming home from the cloud, this session would bring files that steer agents: ${archived.paths.join(", ")}. Look at them, then run 'daedal agent archive ${reference} --approve ${archived.paths.join(",")}'`,
    );
  if (archived.status === "needsRepositories")
    throw new DaedalusError(
      "CONFLICT",
      `${tooMany(archived)} Choose with 'daedal agent archive ${reference} --repositories <name>,...'`,
    );
  throw new DaedalusError(
    "CONFLICT",
    `This session cannot come home from the cloud: ${archived.reason}. To archive it with only what this Mac has, leaving the cloud's changes behind, run 'daedal agent archive ${reference} --without-cloud-changes'`,
  );
}

/** As `archivedOrExplain`, for a workspace and the cloud session that asks. */
export function workspaceArchivedOrExplain(
  archived: WorkspaceArchiveResult,
  reference: string,
): Workspace {
  if (archived.status === "archived") return archived.workspace;
  if (archived.status === "needsApproval")
    throw new DaedalusError(
      "CONFLICT",
      `Cloud session ${archived.sessionId} would bring back files that steer agents: ${archived.paths.join(", ")}. Look at them, archive that session with 'daedal agent archive ${archived.sessionId} --approve ${archived.paths.join(",")}', then archive the workspace again`,
    );
  if (archived.status === "needsRepositories")
    throw new DaedalusError(
      "CONFLICT",
      `${tooMany(archived)} Archive that session with 'daedal agent archive ${archived.sessionId} --repositories <name>,...', then archive the workspace again`,
    );
  if (archived.status === "needsCloudDecision")
    throw new DaedalusError(
      "CONFLICT",
      `Deleting the workspace's cloud copy would lose: ${archived.lost.join("; ")}. Run 'daedal workspace archive ${reference} --delete-cloud-copy' to delete it anyway, or '--keep-cloud-copy' to keep it asleep`,
    );
  throw new DaedalusError(
    "CONFLICT",
    `Cloud session ${archived.sessionId} cannot come home: ${archived.reason}. To archive the workspace with only what this Mac has, leaving the cloud's changes behind, run 'daedal workspace archive ${reference} --without-cloud-changes'`,
  );
}

/** Says which repositories wait in the cloud, and the limits. */
function tooMany(archived: {
  repositories: { name: string; bytes: number }[];
  maxCount: number;
  maxBytes: number;
}): string {
  const listed = archived.repositories
    .map(({ name, bytes }) => `${name} (${Math.ceil(bytes / 1048576)} MB)`)
    .join(", ");
  return `More repositories wait in the cloud than come home at once (at most ${archived.maxCount}, ${Math.round(archived.maxBytes / 1048576)} MB in all): ${listed}.`;
}

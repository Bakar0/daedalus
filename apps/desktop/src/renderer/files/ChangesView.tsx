import type { ChangedFileDto, WorktreeChangesDto } from "@daedalus/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopClient } from "../client-types";
import type { DiffTarget } from "./EditorArea";
import { workspaceBaseName, workspaceParentPath } from "./explorer-state";

// Long enough that an agent writing a burst of files causes one git pass, not
// one per file.
const REFRESH_DELAY_MS = 600;

const STATUS_LETTER: Record<ChangedFileDto["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

/** How a worktree's changes are keyed: the same pair a worktree row has. */
export const worktreeKey = (sessionId: string, repositoryId: string) =>
  `${sessionId}:${repositoryId}`;

/**
 * Every session worktree's changes in a workspace, kept fresh: read once,
 * then again shortly after files change on disk or the data moves (a new
 * worktree, a fetch that moved the base). One git pass at a time; a request
 * during a pass runs once it ends.
 */
export function useWorktreeChanges(
  client: DesktopClient,
  workspaceId: string | undefined,
): ReadonlyMap<string, WorktreeChangesDto> {
  const [changes, setChanges] = useState<
    ReadonlyMap<string, WorktreeChangesDto>
  >(() => new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    let response:
      Awaited<ReturnType<typeof client.request.workspaceChanges>> | undefined;
    try {
      response = await client.request.workspaceChanges({
        workspace: workspaceId,
      });
    } catch {
      response = undefined;
    } finally {
      running.current = false;
    }
    if (response?.ok)
      setChanges(
        new Map(
          response.data.map((tree) => [
            worktreeKey(tree.sessionId, tree.repositoryId),
            tree,
          ]),
        ),
      );
    if (again.current) {
      again.current = false;
      void refresh();
    }
  }, [client, workspaceId]);

  useEffect(() => {
    setChanges(new Map());
    if (!workspaceId) return;
    const soon = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refresh(), REFRESH_DELAY_MS);
    };
    void refresh();
    const stopFiles = client.subscribeWorkspaceFiles(
      ({ workspaceId: changed }) => {
        if (changed === workspaceId) soon();
      },
    );
    const stopData = client.subscribe(soon);
    return () => {
      stopFiles();
      stopData();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [client, refresh, workspaceId]);

  return changes;
}

/**
 * One worktree's changed files, as VS Code's Source Control lists them: name,
 * folder, line counts and a status letter. A click opens the diff as a
 * preview, a double-click keeps it, and the context menu opens the file.
 */
export function ChangedFileList({
  tree,
  onOpenDiff,
  onOpenFile,
}: {
  tree: WorktreeChangesDto;
  onOpenDiff(target: DiffTarget, options: { pinned: boolean }): void;
  onOpenFile(path: string): void;
}) {
  const [selected, setSelected] = useState<string>();
  if (tree.files.length === 0)
    return <p className="changes-empty">No changes yet.</p>;
  return (
    <div
      aria-label={`Changes in ${tree.branchName}`}
      className="changes-list"
      role="list"
    >
      {tree.files.map((file) => {
        const target: DiffTarget = {
          path: file.path,
          root: tree.root,
          repositoryPath: file.repositoryPath,
          originalRepositoryPath: file.originalRepositoryPath,
          status: file.status,
        };
        const folder = workspaceParentPath(file.repositoryPath);
        return (
          <div
            className={`changes-file ${selected === file.path ? "selected" : ""} ${file.status}`}
            key={file.path}
            onClick={() => {
              setSelected(file.path);
              onOpenDiff(target, { pinned: false });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              if (file.status !== "deleted") onOpenFile(file.path);
            }}
            onDoubleClick={() => onOpenDiff(target, { pinned: true })}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpenDiff(target, { pinned: event.key === "Enter" });
              }
            }}
            role="listitem"
            tabIndex={0}
            title={`${file.path}${file.originalRepositoryPath ? `\nRenamed from ${file.originalRepositoryPath}` : ""}\nRight-click to open the file`}
          >
            <span className="changes-file-name">
              {workspaceBaseName(file.repositoryPath)}
            </span>
            {folder && <span className="changes-file-folder">{folder}</span>}
            {file.additions !== undefined && (
              <span className="changes-lines">
                {file.additions > 0 && (
                  <span className="added">+{file.additions}</span>
                )}
                {file.deletions !== undefined && file.deletions > 0 && (
                  <span className="deleted">−{file.deletions}</span>
                )}
              </span>
            )}
            <span aria-label={file.status} className="changes-status">
              {STATUS_LETTER[file.status]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

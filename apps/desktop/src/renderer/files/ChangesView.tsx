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

export interface ChangesViewProps {
  client: DesktopClient;
  workspaceId: string;
  /** Session names by id, so a worktree reads as whose work it is. */
  sessionNames: ReadonlyMap<string, string>;
  onOpenDiff(target: DiffTarget, options: { pinned: boolean }): void;
  onOpenFile(path: string): void;
  onCount(count: number): void;
}

/**
 * What every session's worktree changed since it branched, grouped by
 * worktree, as VS Code's Source Control lists a repository's changes. It
 * follows the filesystem, so a file an agent writes appears here within a
 * second, and a click shows the diff.
 */
export function ChangesView({
  client,
  workspaceId,
  sessionNames,
  onOpenDiff,
  onOpenFile,
  onCount,
}: ChangesViewProps) {
  const [changes, setChanges] = useState<WorktreeChangesDto[]>();
  const [error, setError] = useState<string>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const countRef = useRef(onCount);
  countRef.current = onCount;

  // One git pass at a time: a request during a pass runs once it ends.
  const running = useRef(false);
  const again = useRef(false);
  const refresh = useCallback(async (): Promise<void> => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    const response = await client.request
      .workspaceChanges({ workspace: workspaceId })
      .finally(() => {
        running.current = false;
      });
    if (again.current) {
      again.current = false;
      void refresh();
    }
    if (!response.ok) {
      setError(response.error.message);
      return;
    }
    setError(undefined);
    setChanges(response.data);
    countRef.current(
      response.data.reduce((total, tree) => total + tree.files.length, 0),
    );
  }, [client, workspaceId]);

  const refreshSoon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), REFRESH_DELAY_MS);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const stopFiles = client.subscribeWorkspaceFiles(
      ({ workspaceId: changed }) => {
        if (changed === workspaceId) refreshSoon();
      },
    );
    // A new worktree, a fetch that moved the base, a session archived.
    const stopData = client.subscribe(refreshSoon);
    return () => {
      stopFiles();
      stopData();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [client, refresh, refreshSoon, workspaceId]);

  if (error)
    return (
      <div className="changes-view">
        <p className="changes-empty">{error}</p>
      </div>
    );
  if (!changes)
    return (
      <div className="changes-view">
        <p className="changes-empty">Reading changes…</p>
      </div>
    );
  if (changes.length === 0)
    return (
      <div className="changes-view">
        <p className="changes-empty">
          No session has a worktree here yet. Changes appear once an agent
          checks out a repository.
        </p>
      </div>
    );

  return (
    <div className="changes-view" role="tree" aria-label="Changes">
      {changes.map((tree) => {
        const open = !collapsed.has(tree.root);
        const owner = sessionNames.get(tree.sessionId);
        return (
          <div className="changes-group" key={tree.root}>
            <button
              aria-expanded={open}
              className="changes-group-heading"
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (open) next.add(tree.root);
                  else next.delete(tree.root);
                  return next;
                })
              }
              title={`${tree.root}\nBranch ${tree.branchName}${tree.base ? `\nCompared with ${tree.base.slice(0, 8)}` : ""}`}
              type="button"
            >
              <span
                aria-hidden="true"
                className={`file-tree-twisty ${open ? "open" : ""}`}
              >
                ›
              </span>
              <span className="changes-group-name">
                {owner ?? tree.repositoryName}
                <small>
                  {owner ? `${tree.repositoryName} · ` : ""}
                  {tree.branchName}
                </small>
              </span>
              <span className="changes-count">{tree.files.length}</span>
            </button>
            {open &&
              (tree.files.length === 0 ? (
                <p className="changes-empty nested">No changes yet.</p>
              ) : (
                tree.files.map((file) => {
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
                      aria-selected={selected === file.path}
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
                      role="treeitem"
                      tabIndex={0}
                      title={`${file.path}${file.originalRepositoryPath ? `\nRenamed from ${file.originalRepositoryPath}` : ""}\nRight-click to open the file`}
                    >
                      <span className="changes-file-name">
                        {workspaceBaseName(file.repositoryPath)}
                      </span>
                      {folder && (
                        <span className="changes-file-folder">{folder}</span>
                      )}
                      {file.additions !== undefined && (
                        <span className="changes-lines">
                          {file.additions > 0 && (
                            <span className="added">+{file.additions}</span>
                          )}
                          {file.deletions !== undefined &&
                            file.deletions > 0 && (
                              <span className="deleted">−{file.deletions}</span>
                            )}
                        </span>
                      )}
                      <span aria-label={file.status} className="changes-status">
                        {STATUS_LETTER[file.status]}
                      </span>
                    </div>
                  );
                })
              ))}
          </div>
        );
      })}
    </div>
  );
}

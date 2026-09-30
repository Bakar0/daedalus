-- Merged pull requests, kept after their worktree is gone (#44). The pull
-- request cache lives in memory and forgets a branch when its worktree is
-- removed, so without this nothing remembers what a workspace has shipped.
-- The World's rooms and its weekly scroll read it. Written once, the first
-- time a refresh sees the pull request merged; `merged_at` is GitHub's own
-- time when `gh` reports it, so a merge seen late still dates correctly.
CREATE TABLE shipped_pull_requests (
  url TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT,
  task_id TEXT,
  repository_id TEXT,
  number INTEGER NOT NULL,
  title TEXT,
  branch_name TEXT NOT NULL,
  merged_at TEXT NOT NULL
);

CREATE INDEX shipped_pull_requests_workspace_idx
ON shipped_pull_requests(workspace_id, merged_at);

CREATE TABLE workspace_repositories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('write', 'reference')),
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, name),
  UNIQUE(workspace_id, canonical_path)
);

CREATE TABLE session_worktrees (
  session_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  branch_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, repository_id)
);

CREATE INDEX workspace_repositories_workspace_idx
ON workspace_repositories(workspace_id, created_at);

CREATE INDEX session_worktrees_session_idx
ON session_worktrees(session_id, created_at);

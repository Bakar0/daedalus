CREATE TABLE repository_library (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  remote_url TEXT NOT NULL UNIQUE,
  git_directory TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  last_fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE workspace_repositories
ADD COLUMN library_repository_id TEXT REFERENCES repository_library(id);

ALTER TABLE workspace_repositories
ADD COLUMN reference_path TEXT;

ALTER TABLE workspace_repositories
ADD COLUMN base_branch TEXT;

ALTER TABLE workspace_repositories
ADD COLUMN base_commit TEXT;

ALTER TABLE workspace_repositories
ADD COLUMN fetched_at TEXT;

CREATE INDEX repository_library_name_idx
ON repository_library(name, created_at);

CREATE INDEX workspace_repositories_library_idx
ON workspace_repositories(library_repository_id);

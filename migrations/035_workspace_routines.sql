-- Routines on their own page: a schedule and a prompt that run in a workspace
-- folder as a headless provider session. No session holds them.

CREATE TABLE workspace_routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  -- NULL runs in the workspaces root, for chores across every workspace.
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_routine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id TEXT NOT NULL REFERENCES workspace_routines(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'skipped')),
  -- The provider's conversation id, which `--resume` continues.
  provider_session_id TEXT,
  working_directory TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- The last thing the agent said, or why the run failed or was skipped.
  summary TEXT,
  -- The session a "continue" made from this run.
  continued_session_id TEXT
);

CREATE INDEX workspace_routine_runs_by_routine
  ON workspace_routine_runs (routine_id, id DESC);

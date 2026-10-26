-- One piece of work going through a workflow. A task has at most one open
-- run (ended_at NULL), shared by every session on it; a session without a
-- task has its own. `steps` is the run's copy of the workflow's steps as
-- JSON, with each step's state, times and note, so editing a workflow file
-- changes the next run and not this one. A dynamic run (`dynamic`) has
-- no workflow file at all, and a run whose steps were added or removed
-- after it started is `modified`. A circular run goes back to `loop_to`
-- after its last step; `history` keeps each finished iteration's steps.
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  workflow TEXT NOT NULL,
  steps TEXT NOT NULL,
  dynamic INTEGER NOT NULL DEFAULT 0,
  modified INTEGER NOT NULL DEFAULT 0,
  loop_to TEXT,
  until_text TEXT NOT NULL DEFAULT '',
  iteration INTEGER NOT NULL DEFAULT 1,
  history TEXT NOT NULL DEFAULT '[]',
  end_note TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX workflow_runs_task ON workflow_runs(task_id, started_at);
CREATE INDEX workflow_runs_session ON workflow_runs(session_id, started_at);

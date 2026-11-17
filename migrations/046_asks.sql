-- Needs you: a question for the user, kept until it is answered, dismissed
-- or closed. One session owns it; it may be pinned to a plan task.
CREATE TABLE asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  context TEXT,
  why TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  recommended INTEGER,
  plan_path TEXT,
  task_key TEXT,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'answered', 'dismissed', 'closed')),
  answer TEXT,
  note TEXT,
  closed_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  -- When the owner was told it was answered or dismissed; null while that
  -- notice still waits to be delivered.
  notice_delivered_at TEXT,
  -- When the user was notified that it was asked; null until then.
  notified_at TEXT
);
CREATE INDEX asks_session ON asks (session_id, state);
CREATE INDEX asks_workspace ON asks (workspace_id, state);
CREATE INDEX asks_plan ON asks (plan_path, task_key);

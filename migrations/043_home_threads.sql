-- Home: the main agent's session lives in one hidden workspace row, kept out
-- of every list that shows workspaces.
ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace'
  CHECK (kind IN ('workspace', 'home'));
-- A thread (a lead's member) the user or its lead marked done. It shows as
-- Resolved and no longer counts against the lead's member cap.
ALTER TABLE agent_sessions ADD COLUMN resolved_at TEXT;
-- Work a lead suggests as a new thread, which the user starts from the
-- Threads pane or dismisses.
CREATE TABLE thread_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  started_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  closed_at TEXT
);
CREATE INDEX thread_suggestions_lead ON thread_suggestions (lead_session_id);

-- The board rework (#25). Lanes are derived and never stored, so nothing here
-- describes a lane. What is stored is what the board cannot derive.

-- Per-workspace board settings. Clicking Start on a card moves a `todo` or
-- `blocked` task to `in_progress`, because that click is the user's decision
-- to begin; a workspace that tracks status some other way turns it off. The
-- default provider and model are what Start and Start next launch with when
-- the user does not choose.
ALTER TABLE workspaces ADD COLUMN start_sets_in_progress INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspaces ADD COLUMN default_provider TEXT
  CHECK (default_provider IS NULL OR default_provider IN ('claude', 'codex'));
ALTER TABLE workspaces ADD COLUMN default_model TEXT;

-- When the brief itself last changed. `updated_at` moves on every status
-- change too, so the timeline could not tell "edited the brief" from "marked
-- it done" without its own column. Null means never edited since creation.
ALTER TABLE tasks ADD COLUMN brief_updated_at TEXT;

-- The badge holds only open reasons and is deleted on clear, which is right
-- for the badge and loses the one thing the user cannot recover afterwards:
-- what the agent asked last time. The newest five cleared reasons per session
-- are kept here for the task timeline. Trimmed on insert, never read by
-- anything that decides whether a session needs the user.
CREATE TABLE attention_history (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('agent', 'hook', 'transcript', 'pane')),
  raised_at TEXT NOT NULL,
  cleared_at TEXT NOT NULL
);

CREATE INDEX attention_history_session_idx
ON attention_history(session_id, cleared_at);

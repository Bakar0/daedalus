ALTER TABLE agent_sessions ADD COLUMN provider_session_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN archived_at TEXT;
ALTER TABLE agent_sessions ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX agent_sessions_workspace_archived_idx
ON agent_sessions(workspace_id, archived_at);

ALTER TABLE agent_sessions
ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'
CHECK (kind IN ('agent', 'terminal'));

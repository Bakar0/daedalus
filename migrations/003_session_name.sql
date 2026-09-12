ALTER TABLE agent_sessions
ADD COLUMN name TEXT NOT NULL DEFAULT 'Session';

UPDATE agent_sessions
SET name = COALESCE(
  (SELECT title FROM tasks WHERE tasks.id = agent_sessions.task_id),
  CASE
    WHEN kind = 'terminal' THEN 'Terminal'
    WHEN provider = 'codex' THEN 'Codex session'
    WHEN provider = 'claude' THEN 'Claude session'
    ELSE 'Session'
  END
);

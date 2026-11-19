-- When a thread's fork began: its own messages are the ones after this time,
-- the rest is main's conversation it was born with. The fork session's
-- started_at moves on every restore, so it cannot answer this.
ALTER TABLE asks ADD COLUMN fork_started_at TEXT;
UPDATE asks SET fork_started_at = created_at WHERE fork_session_id IS NOT NULL;

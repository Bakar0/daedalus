-- The session that started this one with `agent spawn` from inside itself,
-- as a handoff does, or null when the user or the app started it. The World
-- draws the new agent being handed a scroll by this one. Not a foreign key:
-- the spawner may be deleted while the session it started lives on.
ALTER TABLE agent_sessions ADD COLUMN spawned_by TEXT;

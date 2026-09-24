-- Automatic handoff (#33). A session whose context passes this share of its
-- window is asked to write a handoff note and continue in a fresh session.
-- Null is off, which is the default: a handoff interrupts whatever the agent
-- is doing, so it is a choice the user makes per workspace.
ALTER TABLE workspaces ADD COLUMN auto_handoff_percent INTEGER
  CHECK (auto_handoff_percent IS NULL OR (auto_handoff_percent BETWEEN 10 AND 100));

-- When a session was last asked to hand off, by the user or by the sweep.
-- Read by the sweep so it asks once, and by the app so the card can say the
-- agent is writing its note. Cleared by nothing: the session is archived by
-- its own successor, and until then the request stands.
ALTER TABLE agent_sessions ADD COLUMN handoff_requested_at TEXT;

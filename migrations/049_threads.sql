-- Threads: an ask hangs off one message in its session's main conversation,
-- by the message's id in the agent's transcript (Claude's entry uuid, Codex's
-- message id), with a copy of its text for when the transcript is gone.
ALTER TABLE asks ADD COLUMN anchor_id TEXT;
ALTER TABLE asks ADD COLUMN anchor_text TEXT;
-- When the agent said it is blocked on the thread; null while it is not.
ALTER TABLE asks ADD COLUMN bumped_at TEXT;
-- A question thread is one the agent asked; a fork thread is one the user
-- opened, talked through in a forked, read-only copy of the session.
ALTER TABLE asks ADD COLUMN kind TEXT NOT NULL DEFAULT 'question'
  CHECK (kind IN ('question', 'fork'));
ALTER TABLE asks ADD COLUMN fork_session_id TEXT;

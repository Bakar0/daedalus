-- A conversation with a copy of an agent (a thread the user opened by
-- asking) can be closed: it leaves the agent's list for its history, keeps
-- every message, and comes back when reopened or when its copy answers
-- after it was closed. `fork_answered_at` is when the copy last finished a
-- turn, kept so an answer still shows as new once the copy has stopped.
ALTER TABLE conversations ADD COLUMN closed_at TEXT;
ALTER TABLE conversations ADD COLUMN fork_answered_at TEXT;

-- Until now closing a conversation archived its copy and hid it for good.
-- Those are the closed ones.
UPDATE conversations
SET closed_at = updated_at
WHERE kind = 'thread'
  AND resolved_at IS NULL
  AND fork_session_id IN (
    SELECT id FROM agent_sessions WHERE archived_at IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM messages
    WHERE messages.conversation_id = conversations.id
      AND messages.kind = 'message'
  );

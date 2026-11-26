-- How the session's agent is driven. `tmux` is the provider's own terminal
-- program in the session's tmux session, read from its screen and typed
-- into. `acp` is `daedal acp-host` in that tmux session, which runs the
-- provider's Agent Client Protocol adapter: turns, tool calls and permission
-- requests arrive as messages, and the session has no terminal to read.
-- Fixed at spawn.
ALTER TABLE agent_sessions ADD COLUMN runner TEXT NOT NULL DEFAULT 'tmux'
  CHECK (runner IN ('tmux', 'acp'));

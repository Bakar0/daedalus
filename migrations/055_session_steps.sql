-- What an agent did, one row per hook that marks a step of a turn: the
-- user's prompt, each tool call that finished, and the turn's end. A chat
-- reads them to show a finished turn as one line with its tool calls and the
-- files it edited. Hooks report no line counts, so none are kept.
CREATE TABLE session_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prompt', 'tool', 'stop')),
  -- On a tool step: its name, and what it ran on (a command, a file's name).
  tool TEXT,
  detail TEXT,
  -- The whole path of a file the tool wrote, for Edit, Write and their kin.
  file TEXT,
  failed INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX session_steps_session ON session_steps (session_id, id);

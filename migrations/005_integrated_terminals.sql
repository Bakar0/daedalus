CREATE TABLE integrated_terminals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tmux_session TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  args TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'exited', 'lost')),
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX integrated_terminals_status_idx
ON integrated_terminals(status);

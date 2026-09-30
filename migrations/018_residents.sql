-- Residents (#49): named, long-lived agents that own a workspace and run
-- routines on a clock Daedalus keeps. The first one is Argus. A routine's
-- definition is a Markdown file in the resident's workspace; only its runtime
-- state lives here.

-- `session_id` is the one session on duty. A handoff moves it to the
-- successor, so it always names the live conversation. `state` is what the
-- user chose (on duty, paused, stopped) plus `draining`, which the scheduler
-- sets while it waits for runs in flight to finish before a handoff.
CREATE TABLE residents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  model TEXT,
  auto_handoff_percent INTEGER NOT NULL DEFAULT 60
    CHECK (auto_handoff_percent BETWEEN 10 AND 100),
  state TEXT NOT NULL DEFAULT 'stopped'
    CHECK (state IN ('on_duty', 'draining', 'paused', 'stopped')),
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  draining_since TEXT,
  created_at TEXT NOT NULL
);

-- One row per routine file the scheduler has seen. Removed with the file.
CREATE TABLE routine_state (
  resident_id TEXT NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (resident_id, name)
);

-- The integer id is what Daedalus types into the resident's pane
-- (`/daedalus-routine 812`), so it is short on purpose. `delivered_at` is set
-- when the line is typed; a run counts as in flight from then until it ends.
CREATE TABLE routine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resident_id TEXT NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  routine TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  queued_at TEXT NOT NULL,
  delivered_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('quiet', 'notified', 'task')),
  summary TEXT,
  missed_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX routine_runs_resident_idx ON routine_runs(resident_id, status, id);

-- What a routine reported. The key identifies the issue, not the sighting, so
-- the same failure seen twice is one row. At most one open row per key.
-- `same_as` names the open finding this one was merged into when two
-- routines saw one cause; it then shares that finding's task.
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  resident_id TEXT NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  routine TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  same_as TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'urgent')),
  title TEXT NOT NULL,
  url TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'cleared', 'closed')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('useful', 'noise')),
  opened_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  cleared_at TEXT,
  closed_at TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX findings_open_key_idx
ON findings(resident_id, dedupe_key) WHERE state = 'open';

CREATE INDEX findings_key_idx ON findings(resident_id, dedupe_key, opened_at);

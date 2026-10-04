-- Session abilities (#49): any session can be named, pinned and colored, and
-- can hold abilities such as routines. Routines run on a clock Daedalus keeps
-- and are typed into the session that holds them.

-- Development builds of #49 created other tables under the same version
-- number. No release shipped them, so they are dropped rather than migrated.
DROP TABLE IF EXISTS findings;
DROP TABLE IF EXISTS routine_reports;
DROP TABLE IF EXISTS routine_runs;
DROP TABLE IF EXISTS routine_state;
DROP TABLE IF EXISTS routine_agents;
DROP TABLE IF EXISTS residents;

-- `pinned_at` orders pinned sessions at the top of their workspace's list.
-- `color` is one of the fixed session colors, or null.
ALTER TABLE agent_sessions ADD COLUMN pinned_at TEXT;
ALTER TABLE agent_sessions ADD COLUMN color TEXT;

-- An ability a session holds. Routine data references `id`, not the session,
-- so a handoff moves the ability to the successor with one update of
-- `session_id`. A revoke sets `enabled` to 0 and keeps the row and its data,
-- so granting the ability again brings everything back. `pending_note` is a
-- line Daedalus still has to type into the session: the note that tells it
-- about a grant or a revoke.
CREATE TABLE session_abilities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  ability TEXT NOT NULL CHECK (ability IN ('routines')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  config TEXT NOT NULL DEFAULT '{}',
  pending_note TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (session_id, ability)
);

-- One row per routine. The definition and the scheduler's state live
-- together; a template never fires and is copied into live routines.
CREATE TABLE routines (
  id TEXT PRIMARY KEY,
  ability_id TEXT NOT NULL REFERENCES session_abilities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  until TEXT,
  model TEXT,
  timeout_ms INTEGER NOT NULL,
  output TEXT NOT NULL CHECK (output IN ('task', 'notify', 'none')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  vars TEXT NOT NULL DEFAULT '{}',
  body TEXT NOT NULL,
  is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0, 1)),
  next_run_at TEXT,
  last_run_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ability_id, is_template, name)
);

-- The integer id is what Daedalus types into the session
-- (`/daedalus-routine 812`), so it is short on purpose. `delivered_at` is set
-- when the line is typed; a run counts as in flight from then until it ends.
CREATE TABLE routine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ability_id TEXT NOT NULL REFERENCES session_abilities(id) ON DELETE CASCADE,
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

CREATE INDEX routine_runs_ability_idx ON routine_runs(ability_id, status, id);

-- What a routine reported. The key identifies the thing reported, not the
-- sighting, so the same report seen twice is one row. At most one open row
-- per key. `same_as` names the open report this one was merged into when two
-- routines saw one cause; it then shares that report's task.
CREATE TABLE routine_reports (
  id TEXT PRIMARY KEY,
  ability_id TEXT NOT NULL REFERENCES session_abilities(id) ON DELETE CASCADE,
  routine TEXT NOT NULL,
  report_key TEXT NOT NULL,
  same_as TEXT,
  urgent INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  title TEXT NOT NULL,
  url TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'closed')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('useful', 'noise')),
  opened_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  closed_at TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX routine_reports_open_key_idx
ON routine_reports(ability_id, report_key) WHERE state = 'open';

CREATE INDEX routine_reports_key_idx
ON routine_reports(ability_id, report_key, opened_at);

CREATE INDEX routine_reports_task_idx ON routine_reports(task_id);

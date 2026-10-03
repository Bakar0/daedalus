-- Routine agents (#49): named Claude sessions in an ordinary workspace that
-- run routines on a clock Daedalus keeps. A routine's definition is a
-- Markdown file in the agent's folder; only its runtime state lives here.

-- Development builds of #49 created these under other names. No release
-- shipped them, so they are dropped rather than migrated.
DROP TABLE IF EXISTS findings;
DROP TABLE IF EXISTS routine_runs;
DROP TABLE IF EXISTS routine_state;
DROP TABLE IF EXISTS residents;

-- `session_id` is the agent's current session. A handoff moves it to the
-- successor, so it always names the live conversation. `state` is on duty
-- or paused, plus `draining`, which the scheduler sets while it waits for
-- runs in flight to finish before a handoff. The folder is
-- `<workspace>/worktrees/agents/<slug>` and never moves.
-- `mode` is who owns the input: the user (`manual`) or Daedalus (`auto`,
-- the input locked). `last_input_at` is the user's last keystroke, which
-- starts the countdown back to auto; `stashed_draft` is unsent text Daedalus
-- cleared from the input box when it locked, typed back on unlock.
CREATE TABLE routine_agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT,
  auto_handoff_percent INTEGER NOT NULL DEFAULT 60
    CHECK (auto_handoff_percent BETWEEN 10 AND 100),
  state TEXT NOT NULL DEFAULT 'on_duty'
    CHECK (state IN ('on_duty', 'draining', 'paused')),
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  draining_since TEXT,
  mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'auto')),
  last_input_at TEXT,
  stashed_draft TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE UNIQUE INDEX routine_agents_session_idx
ON routine_agents(session_id) WHERE session_id IS NOT NULL;

-- One row per routine file the scheduler has seen. Removed with the file.
CREATE TABLE routine_state (
  routine_agent_id TEXT NOT NULL REFERENCES routine_agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (routine_agent_id, name)
);

-- The integer id is what Daedalus types into the agent's pane
-- (`/daedalus-routine 812`), so it is short on purpose. `delivered_at` is set
-- when the line is typed; a run counts as in flight from then until it ends.
CREATE TABLE routine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_agent_id TEXT NOT NULL REFERENCES routine_agents(id) ON DELETE CASCADE,
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

CREATE INDEX routine_runs_agent_idx ON routine_runs(routine_agent_id, status, id);

-- What a routine reported. The key identifies the thing reported, not the
-- sighting, so the same report seen twice is one row. At most one open row
-- per key. `same_as` names the open report this one was merged into when two
-- routines saw one cause; it then shares that report's task.
CREATE TABLE routine_reports (
  id TEXT PRIMARY KEY,
  routine_agent_id TEXT NOT NULL REFERENCES routine_agents(id) ON DELETE CASCADE,
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
ON routine_reports(routine_agent_id, report_key) WHERE state = 'open';

CREATE INDEX routine_reports_key_idx
ON routine_reports(routine_agent_id, report_key, opened_at);

CREATE INDEX routine_reports_task_idx ON routine_reports(task_id);

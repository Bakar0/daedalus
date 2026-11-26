-- The job engine. A job is one piece of work with an owner: a workflow step,
-- a plan task, a prompt, a message to a team member. Jobs form one tree per
-- piece of work, named by its root.
--
-- `job_events` is the only source of truth: every change to a job is one row
-- appended to it, never changed afterwards. `jobs` and `job_outputs` mirror
-- what the log says, written in the same transaction as the event, so that
-- reading is one query. Replaying the log rebuilds both.
CREATE TABLE job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  -- The event's own fields as JSON, without `jobId` and `type`.
  data TEXT NOT NULL DEFAULT '{}',
  -- The session that asked, when one did. Not a foreign key: the log
  -- outlives the sessions it names.
  session_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX job_events_root ON job_events (root_id, seq);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  needs TEXT NOT NULL DEFAULT '[]',
  gives TEXT NOT NULL DEFAULT '[]',
  gate TEXT,
  runner TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,
  loop TEXT,
  source TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  -- The session doing it. Not a foreign key, as in the log.
  session_id TEXT,
  hold TEXT,
  approved TEXT NOT NULL DEFAULT '{"start":false,"result":false}',
  result TEXT,
  why TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- When this round started running, and when the job reached an end.
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX jobs_root ON jobs (root_id);
CREATE INDEX jobs_workspace ON jobs (workspace_id);
CREATE INDEX jobs_session ON jobs (session_id);

-- What a job handed over in its current round.
CREATE TABLE job_outputs (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (job_id, name)
);

-- The job a session was started for: its brief on a restart or a rebirth.
ALTER TABLE agent_sessions ADD COLUMN job_id TEXT;

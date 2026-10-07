-- daedalus:foreign-keys-off
-- Teams (#45). The orchestration ability makes a session the lead of a team.
-- The team is the lead's orchestration ability row, so a handoff that moves
-- the ability to the successor moves the team with it.

-- `session_abilities` gains 'orchestration' in its CHECK, which SQLite can
-- only change by rebuilding the table. The runner turns foreign keys off for
-- this file, because dropping the old table would otherwise cascade into
-- routines, runs and reports, and checks every key once the file has run.
CREATE TABLE session_abilities_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  ability TEXT NOT NULL CHECK (ability IN ('routines', 'orchestration')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  config TEXT NOT NULL DEFAULT '{}',
  pending_note TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (session_id, ability)
);

INSERT INTO session_abilities_new
  (id, session_id, ability, enabled, paused, config, pending_note, granted_at, revoked_at)
SELECT id, session_id, ability, enabled, paused, config, pending_note, granted_at, revoked_at
FROM session_abilities;

DROP TABLE session_abilities;
ALTER TABLE session_abilities_new RENAME TO session_abilities;

-- A member's team, and its handle in the team chat (`@client-worker`). Both
-- stay through rename, handoff, restore and revive. The lead itself has no
-- row value here: it is the session that holds the team's ability.
ALTER TABLE agent_sessions ADD COLUMN team_id TEXT
  REFERENCES session_abilities(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN team_handle TEXT;

CREATE INDEX agent_sessions_team_idx ON agent_sessions(team_id);

-- The team chat. `author` is 'lead', 'user' or a member's handle; `tags`
-- is a JSON array of the handles the message was pushed to.
CREATE TABLE team_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES session_abilities(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX team_messages_team_idx ON team_messages(team_id, id);

-- Per reader: the last message it read with `team chat`, and the last tagged
-- message Daedalus delivered to its session. A failed delivery keeps
-- `delivered_through` and records why, so the next attempt sends it again.
CREATE TABLE team_cursors (
  team_id TEXT NOT NULL REFERENCES session_abilities(id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  read_through INTEGER NOT NULL DEFAULT 0,
  delivered_through INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY (team_id, handle)
);

-- daedalus:foreign-keys-off
-- Flow maps (#65). A map belongs to a workspace and outlives the sessions
-- that work on it. Components nest inside one parent, typed relations link
-- any two, and each component carries a flow of stages from a fixed set.

-- `session_abilities` gains 'flow' in its CHECK, which SQLite can only change
-- by rebuilding the table. Foreign keys are off for this file so dropping the
-- old table does not cascade into routines, runs, reports and the team chat;
-- the runner checks every key once the file has run.
CREATE TABLE session_abilities_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  ability TEXT NOT NULL CHECK (ability IN ('routines', 'orchestration', 'flow')),
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

-- One row per map. `number` is the map's readable number in its workspace.
-- `name` is the root component's name, kept equal to it. Every change to
-- anything on the map moves `updated_at`, which the app watches.
CREATE TABLE flow_maps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, number)
);

-- A component is a deliverable. The root has no parent; every other
-- component has exactly one, in the same map. Deleting a component deletes
-- what it contains. A dropped component keeps its row with the reason.
CREATE TABLE flow_components (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES flow_maps(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES flow_components(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  deliverable TEXT NOT NULL DEFAULT '',
  done_when TEXT NOT NULL DEFAULT '',
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  dropped_reason TEXT,
  dropped_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (map_id, number)
);

CREATE INDEX flow_components_map_idx ON flow_components(map_id, parent_id, position);
CREATE INDEX flow_components_task_idx ON flow_components(task_id);

CREATE TABLE flow_relations (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES flow_maps(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  from_id TEXT NOT NULL REFERENCES flow_components(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES flow_components(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('calls', 'publishes to', 'reads from', 'writes to', 'depends on')),
  note TEXT,
  dropped_reason TEXT,
  dropped_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (map_id, number),
  CHECK (from_id <> to_id)
);

CREATE INDEX flow_relations_map_idx ON flow_relations(map_id);

-- A component's flow. `mode` says who decides the state: 'own' stages are set
-- by an agent; 'rollup' and 'after' stages of a container are computed from
-- the components inside when read, and their stored state is only what an
-- agent set on an 'after' stage once it could start. `session_id` is the
-- session that claimed the stage with `flow stage start`; it stays after the
-- stage finishes, so the map shows who did it. Not a foreign key: a deleted
-- session should not erase that.
CREATE TABLE flow_stages (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES flow_components(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('research', 'plan', 'prototype', 'implement', 'validate', 'deploy')),
  position INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'own' CHECK (mode IN ('own', 'rollup', 'after')),
  label TEXT,
  state TEXT NOT NULL DEFAULT 'todo' CHECK (state IN ('todo', 'running', 'done', 'skipped', 'blocked')),
  note TEXT,
  session_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  dropped_reason TEXT,
  dropped_at TEXT
);

CREATE INDEX flow_stages_component_idx ON flow_stages(component_id, position);
CREATE INDEX flow_stages_session_idx ON flow_stages(session_id);

-- Decisions worth remembering, on the component they belong to. `author` is
-- a session's name or 'user'.
CREATE TABLE flow_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id TEXT NOT NULL REFERENCES flow_components(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX flow_decisions_component_idx ON flow_decisions(component_id, id);

-- One line per change worth showing: added, dropped, stage started or
-- finished, decided. A line points at the component or relation it is
-- about, so deleting that item takes its lines too and leaves no trace.
CREATE TABLE flow_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id TEXT NOT NULL REFERENCES flow_maps(id) ON DELETE CASCADE,
  component_id TEXT REFERENCES flow_components(id) ON DELETE CASCADE,
  relation_id TEXT REFERENCES flow_relations(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX flow_history_map_idx ON flow_history(map_id, id);

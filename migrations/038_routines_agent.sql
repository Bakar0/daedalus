-- The one Claude session that writes and keeps the user's routines, opened
-- from the Routines page. A rebirth moves it to the successor.
CREATE TABLE routines_agent (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL
);

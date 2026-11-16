-- Home no longer has a main agent (#71): nothing tracks sessions as its
-- threads or suggests threads to start. Drops what 044 made and the
-- suggestions table from 043. 043's `workspaces.kind` (the Home row) and
-- `agent_sessions.resolved_at` (a lead marking a member done) stay.
DROP TABLE IF EXISTS track_notes;
DROP TABLE IF EXISTS session_tracks;
DROP TABLE IF EXISTS thread_suggestions;

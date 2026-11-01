-- A finished run stays unread until the user opens it; the Routines link in
-- the sidebar counts the unread ones. Runs from before this count as read.
ALTER TABLE workspace_routine_runs ADD COLUMN seen_at TEXT;
UPDATE workspace_routine_runs SET seen_at = COALESCE(finished_at, started_at);

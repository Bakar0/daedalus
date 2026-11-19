-- How far a thread's fork has read main: main's messages after this time are
-- new to it, and go to the fork before its next turn. Null until its first.
ALTER TABLE asks ADD COLUMN fork_synced_at TEXT;

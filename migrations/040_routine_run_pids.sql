-- A run's `claude -p` outlives an app that quits, as sessions do. Its pid
-- lets the next app keep watching it, and end it once it is gone.
ALTER TABLE workspace_routine_runs ADD COLUMN pid INTEGER;

-- `daedal routine run` cannot start the run itself: the CLI exits before the
-- run ends, and only the app watches a run to its end. It asks here instead,
-- and the app's tick starts the run.
ALTER TABLE workspace_routines ADD COLUMN run_requested_at TEXT;

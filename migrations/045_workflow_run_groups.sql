-- Workflows included in a run with `@name` (sub-workflows): each group's id,
-- its own loop and which time round it is on, as JSON. Runs started before
-- have none.
ALTER TABLE workflow_runs ADD COLUMN groups TEXT NOT NULL DEFAULT '[]';

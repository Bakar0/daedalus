-- A workflow run belongs to the session that runs it, not to a task: the
-- user wants workflows apart from tasks. Runs keep their rows; a rebirth
-- moves a session's runs to its successor.
DROP INDEX workflow_runs_task;
ALTER TABLE workflow_runs DROP COLUMN task_id;

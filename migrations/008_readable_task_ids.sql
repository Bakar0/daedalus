ALTER TABLE workspaces ADD COLUMN task_id_prefix TEXT;
ALTER TABLE workspaces
ADD COLUMN next_task_number INTEGER NOT NULL DEFAULT 1
CHECK (next_task_number >= 1);

UPDATE workspaces
SET task_id_prefix = slug
WHERE task_id_prefix IS NULL;

CREATE UNIQUE INDEX workspaces_task_id_prefix_idx
ON workspaces(task_id_prefix);

ALTER TABLE tasks ADD COLUMN number INTEGER;

WITH numbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id
      ORDER BY created_at, id
    ) AS task_number
  FROM tasks
)
UPDATE tasks
SET number = (
  SELECT task_number
  FROM numbered
  WHERE numbered.id = tasks.id
);

CREATE UNIQUE INDEX tasks_workspace_number_idx
ON tasks(workspace_id, number);

UPDATE workspaces
SET next_task_number = COALESCE(
  (
    SELECT MAX(tasks.number) + 1
    FROM tasks
    WHERE tasks.workspace_id = workspaces.id
  ),
  1
);

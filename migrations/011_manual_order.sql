-- Manual ordering for the two navigator lists.
--
-- Both lists were ordered for the user and only one way: workspaces by
-- creation ascending, sessions by start time. Neither could be rearranged, so
-- a list long enough to need an order was a list you had to read end to end.
--
-- `position` is the authoritative order. It is a sparse INTEGER rather than a
-- dense one so that creating a row is a single write at MIN(position) - 1 —
-- newest first, as the app now presents both lists — without renumbering
-- everything that already exists. A reorder rewrites the affected list
-- densely in one transaction, which is cheap at the tens of rows these lists
-- hold and keeps the column readable in a way fractional indexing does not.
--
-- Workspace positions are global. Session positions are per workspace, which
-- is why there is no unique index on either: a reorder and a create race to
-- the same integer often enough that uniqueness would buy a constraint
-- violation rather than a correct order, and ties already fall back to id.

ALTER TABLE workspaces ADD COLUMN position INTEGER;

ALTER TABLE agent_sessions ADD COLUMN position INTEGER;

-- Backfill newest first, which inverts the order both lists were displayed in.
-- That is the point of the change rather than a side effect of it: the thing
-- you just made is the thing you are looking for.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS rank
  FROM workspaces
)
UPDATE workspaces
SET position = (SELECT rank FROM ordered WHERE ordered.id = workspaces.id);

WITH ordered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id
      ORDER BY started_at DESC, id DESC
    ) AS rank
  FROM agent_sessions
)
UPDATE agent_sessions
SET position = (SELECT rank FROM ordered WHERE ordered.id = agent_sessions.id);

CREATE INDEX agent_sessions_workspace_position_idx
ON agent_sessions(workspace_id, position);

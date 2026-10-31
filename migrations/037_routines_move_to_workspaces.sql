-- The routines ability is gone: a routine is now a time and a prompt that runs
-- headless in a workspace (035). Each live routine moves to its session's
-- workspace, with the ability's purpose at the top of its prompt. Templates,
-- runs and reports are dropped; tasks the reports opened stay on the board.
-- A run is told when the previous one ended, so `{{last_run}}` becomes words.
INSERT INTO workspace_routines
  (id, name, workspace_id, schedule, prompt, model, enabled, next_run_at,
   last_run_at, run_requested_at, created_at, updated_at)
SELECT
  r.id,
  r.name || CASE
    WHEN EXISTS (SELECT 1 FROM workspace_routines w WHERE w.name = r.name)
      OR EXISTS (
        SELECT 1 FROM routines o
        WHERE o.name = r.name AND o.is_template = 0 AND o.id < r.id
      )
    THEN '-' || lower(substr(r.id, 1, 4))
    ELSE ''
  END,
  s.workspace_id,
  json_extract(r.schedule, '$.text'),
  CASE
    WHEN json_extract(a.config, '$.purpose') IS NOT NULL
    THEN 'Purpose: ' || json_extract(a.config, '$.purpose') || char(10) || char(10)
    ELSE ''
  END || replace(r.body, '{{last_run}}', '<when the previous run ended, ISO 8601>'),
  r.model,
  CASE WHEN r.enabled = 1 AND a.enabled = 1 AND a.paused = 0 THEN 1 ELSE 0 END,
  r.next_run_at,
  r.last_run_at,
  NULL,
  r.created_at,
  r.updated_at
FROM routines r
JOIN session_abilities a ON a.id = r.ability_id
JOIN agent_sessions s ON s.id = a.session_id
WHERE r.is_template = 0;

DROP TABLE routine_reports;
DROP TABLE routine_runs;
DROP TABLE routines;
DELETE FROM session_abilities WHERE ability = 'routines';

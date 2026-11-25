-- Which session a plan's task was started in. A plan file names an owner by
-- handle (`@name`), which several sessions can answer to over time; this row
-- names the one session, so a view can follow a task to its session and that
-- session's workflow run. One session per task: starting a task again
-- replaces the row.
CREATE TABLE plan_task_links (
  plan_path TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_path, task_id)
);

CREATE INDEX plan_task_links_session ON plan_task_links(session_id);

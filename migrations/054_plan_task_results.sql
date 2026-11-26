-- What a plan task's worker handed back when it submitted (`daedal plan
-- submit`), and the claim that keeps two processes from starting a worker on
-- the same task. A claim is taken before the session exists, so it cannot
-- live on `plan_task_links`, whose rows name a session.
CREATE TABLE plan_task_results (
  plan_path TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  result TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (plan_path, task_id)
);

CREATE TABLE plan_task_claims (
  plan_path TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (plan_path, task_id)
);

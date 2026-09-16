-- Agent activity is observed, not owned: one row per session, replaced in
-- place. It is persisted rather than cached in memory because the CLI, the
-- provider hooks, and the desktop app are separate processes that must all
-- see the same reading.
CREATE TABLE agent_activity (
  session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  activity TEXT NOT NULL CHECK (
    activity IN ('unknown', 'working', 'needs_permission', 'needs_input',
                 'idle', 'done', 'error')
  ),
  detail TEXT,
  since TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('agent', 'hook', 'transcript', 'pane')),
  -- The last alert sent for this session, kept here rather than on the badge
  -- because it has to outlive a clear: a turn that bounces
  -- working -> needs_permission -> working three times is one alert, and the
  -- badge it raised is gone by the time the third bounce arrives.
  notified_activity TEXT,
  notified_at TEXT
);

-- One badge per session. `reasons` is a JSON array used as a ring buffer of
-- the newest five open reasons, so repeated raises accumulate context instead
-- of stacking alerts.
CREATE TABLE session_attention (
  session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reasons TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX session_attention_workspace_idx
ON session_attention(workspace_id);

-- Ephemeral alerts that nobody could see yet: toasts raised while the window
-- was closed, desktop notifications raised by a CLI with no notifier. They
-- are drained by whichever surface can finally show them.
CREATE TABLE pending_notifications (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('toast', 'desktop')),
  level TEXT NOT NULL CHECK (level IN ('info', 'success', 'error')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX pending_notifications_session_idx
ON pending_notifications(session_id);

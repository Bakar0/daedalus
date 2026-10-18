-- Automatic rebirth at three levels: a global default in the app's settings,
-- a workspace's own threshold, and a session's own. In both columns NULL
-- takes the level above (session from workspace, workspace from global), 0
-- is off whatever the level above says, and 10 to 100 is a threshold.
--
-- `auto_handoff_percent` (016) said only "a threshold, or off", so it cannot
-- tell off from inherit. It stays, written as the threshold or NULL, for
-- older builds. Its NULLs become inherit here: the global default starts
-- off, so every workspace that was off stays off until the user sets one.
ALTER TABLE workspaces ADD COLUMN auto_rebirth_percent INTEGER
  CHECK (auto_rebirth_percent IS NULL OR auto_rebirth_percent = 0
    OR auto_rebirth_percent BETWEEN 10 AND 100);
UPDATE workspaces SET auto_rebirth_percent = auto_handoff_percent;

ALTER TABLE agent_sessions ADD COLUMN auto_rebirth_percent INTEGER
  CHECK (auto_rebirth_percent IS NULL OR auto_rebirth_percent = 0
    OR auto_rebirth_percent BETWEEN 10 AND 100);

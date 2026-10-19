-- Where the session runs: null for this Mac, or a cloud host id
-- (`ws:<workspaceId>`, the workspace's pod). A cloud session's
-- working_directory is relative to the workspace root on that host.
ALTER TABLE agent_sessions ADD COLUMN host_id TEXT;

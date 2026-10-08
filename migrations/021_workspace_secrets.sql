-- Workspace secrets (#62). The value of each secret is a login Keychain item;
-- this table only remembers which names a workspace has, so listing them
-- never reads the Keychain. Removing the workspace deletes the Keychain
-- items first and these rows with it.
CREATE TABLE workspace_secrets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, name)
);

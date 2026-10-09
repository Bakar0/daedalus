-- Secrets (#62). A secret is global (workspace_id NULL) or belongs to one
-- workspace, where it wins over a global one of the same name. The value is
-- a login Keychain item; this table only remembers the names, so listing
-- them never reads the Keychain. Removing a workspace deletes its Keychain
-- items first and these rows with it.
-- A development build of #62 created workspace_secrets under the name
-- 021_workspace_secrets. No release shipped it, so it is dropped.
DROP TABLE IF EXISTS workspace_secrets;

CREATE TABLE secrets (
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX secrets_workspace_name_idx
ON secrets(workspace_id, name) WHERE workspace_id IS NOT NULL;

CREATE UNIQUE INDEX secrets_global_name_idx
ON secrets(name) WHERE workspace_id IS NULL;

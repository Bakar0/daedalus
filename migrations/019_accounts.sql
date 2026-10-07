-- Account profiles (#43). A profile is a provider configuration folder under
-- the Daedalus home, listed in config.json. A session records which one it
-- runs on, so a restore, a revive or a handoff starts it on the same account.
-- Null is the provider's default account. The column is set once, at spawn.
ALTER TABLE agent_sessions ADD COLUMN account TEXT;

-- Which account a workspace starts each provider's sessions on when the user
-- does not choose. One per provider, because a workspace can run both. Null
-- is the default account; removing a profile resets these to null.
ALTER TABLE workspaces ADD COLUMN default_claude_account TEXT;
ALTER TABLE workspaces ADD COLUMN default_codex_account TEXT;

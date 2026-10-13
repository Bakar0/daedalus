-- The model a workspace starts sessions with, remembered per provider
-- account rather than once per workspace. Account ids differ in what models
-- they offer: a Bedrock account takes `us.anthropic.…` ids that a Claude
-- subscription does not, so one remembered model broke the other account.
-- Keys are `<provider>:<account>`, the account being `default` or a profile
-- id. The single default model moves to the key of the account it was used
-- with: the default provider on that provider's default account.
-- `default_model` stays, written as that same entry, for older builds.
ALTER TABLE workspaces ADD COLUMN account_models TEXT NOT NULL DEFAULT '{}';
UPDATE workspaces
SET account_models = json_object(
  default_provider || ':' || COALESCE(
    CASE default_provider
      WHEN 'claude' THEN default_claude_account
      ELSE default_codex_account
    END,
    'default'
  ),
  default_model
)
WHERE default_model IS NOT NULL AND default_provider IS NOT NULL;

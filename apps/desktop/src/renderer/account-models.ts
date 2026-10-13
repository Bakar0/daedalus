/**
 * A provider account's key: `claude:default`, `claude:<profile id>`, … The
 * same key as the core's `accountModelKey`, so a workspace's `accountModels`
 * and the loaded model lists line up. Models are per account because
 * accounts take different ids: Bedrock's `us.anthropic.…` against a Claude
 * subscription's `claude-…`.
 */
export const accountModelKey = (
  provider: string,
  account: string | null | undefined,
): string => `${provider}:${account || "default"}`;

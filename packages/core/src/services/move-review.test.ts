import { expect, test } from "vitest";
import { steersAgent } from "./move-git";

/**
 * Review finding M-1 (artifacts/cloud-sessions/cloud-ui-review.md, "Move and
 * sync"). macOS volumes are case-insensitive by default, and git there runs
 * with core.ignorecase=true: `.CLAUDE/settings.json` from the pod lands in
 * `.claude/settings.json`, which Claude reads, hooks and all.
 */
test.each([
  ".CLAUDE/settings.json",
  ".Claude/settings.local.json",
  "claude.md",
  "docs/Claude.md",
  "agents.md",
  ".MCP.json",
  ".ENVRC",
  ".VSCode/tasks.json",
])("M-1: %s needs approval", (path) => {
  expect(steersAgent(path)).toBe(true);
});

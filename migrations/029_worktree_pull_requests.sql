-- The last pull request GitHub reported for each worktree's branch. The git
-- status monitor kept it in memory only, so after every restart the panel
-- showed no pull request until `gh` was asked again, and a branch with no
-- commits ahead of its base was never asked at all. `branch_name` is the
-- branch it was found for: a worktree that moved to another branch does not
-- show the old branch's pull request. `pull_request` is the reference as
-- JSON, or null when the branch has none; `landed_head` is the HEAD that
-- answer was found to have landed.
CREATE TABLE worktree_pull_requests (
  path TEXT PRIMARY KEY REFERENCES session_worktrees(path) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  pull_request TEXT,
  landed_head TEXT,
  checked_at TEXT NOT NULL
);

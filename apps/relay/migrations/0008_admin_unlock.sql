-- Sudo mode for the admin section: admin calls from a Mac also need an
-- unlock, approved by a fresh Google sign-in in the browser. The Mac holds
-- the unlock's secret in memory only; the relay keeps its hash.
CREATE TABLE admin_unlocks (
  secret_hash TEXT PRIMARY KEY,
  mac_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  -- Set when the admin's Google sign-in approves it.
  approved_at TEXT,
  -- Pending: until when it can be approved. Approved: until when it works,
  -- moved on by each admin call, never past an hour after approval.
  expires_at TEXT NOT NULL
);

-- A sign-in in flight may be approving an unlock.
ALTER TABLE oauth_states ADD COLUMN unlock_hash TEXT;

-- Accounts, devices and the access lock for the Daedalus relay.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Phone sign-in sessions. Only a hash of the token is kept.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Macs and phones. A Mac exists unclaimed (user_id NULL) from its first
-- connection until a signed-in phone claims it; a claimed Mac connects with
-- a device token, of which only a hash is kept.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mac', 'phone')),
  name TEXT NOT NULL DEFAULT '',
  token_hash TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  revoked_at TEXT,
  last_seen_at TEXT
);
CREATE INDEX devices_user ON devices(user_id);

-- Signing in is not enough: an account needs an active entitlement. Payment
-- providers will write rows here later; the relay only reads them.
CREATE TABLE entitlements (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('invite', 'admin', 'appstore', 'stripe')),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at TEXT,
  max_macs INTEGER NOT NULL,
  max_phones INTEGER NOT NULL,
  monthly_mb INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  max_uses INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

-- Google sign-in in flight: the PKCE verifier and where to return.
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  invite TEXT,
  expires_at TEXT NOT NULL
);

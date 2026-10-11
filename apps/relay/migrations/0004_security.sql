-- Fixes from the security review (artifacts/remote-work/security-review.md).

-- A pairing code's claim key, as a hash, and until when it works. The Mac
-- registers it when it shows the code, and a claim must present the key,
-- so the Mac's id alone no longer claims it (H1).
ALTER TABLE devices ADD COLUMN claim_hash TEXT;
ALTER TABLE devices ADD COLUMN claim_expires_at TEXT;

-- A sign-in belongs to one phone from its first connection, so removing
-- the phone ends it and it cannot register other phones (M1).
ALTER TABLE sessions ADD COLUMN device_id TEXT;
CREATE INDEX sessions_device ON sessions(device_id);

-- A sign-in in flight is tied to the browser that started it by a cookie,
-- kept here as a hash (M3), and may name the phone it is for.
ALTER TABLE oauth_states ADD COLUMN browser_hash TEXT;
ALTER TABLE oauth_states ADD COLUMN device_id TEXT;

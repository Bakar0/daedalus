-- A Mac signs in with Google itself, in the browser. The sign-in in flight
-- names the Mac, the hash of the claim key it registered, and its name.
ALTER TABLE oauth_states ADD COLUMN mac_id TEXT;
ALTER TABLE oauth_states ADD COLUMN mac_claim_hash TEXT;
ALTER TABLE oauth_states ADD COLUMN mac_name TEXT;

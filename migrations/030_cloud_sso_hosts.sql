-- The AWS access portal hosts this Mac copied into a cloud workspace, with a
-- Bedrock profile's sso-session. A pod may ask the Mac to open a sign-in
-- page only on these hosts (and Claude's own), never any *.awsapps.com:
-- anyone can have a portal there, so a pod could open a look-alike.
CREATE TABLE cloud_sso_hosts (
  cloud_id TEXT NOT NULL,
  host TEXT NOT NULL,
  PRIMARY KEY (cloud_id, host)
);

-- A cloud workspace link belongs to the gateway account that made it. A Mac
-- signed in to another gateway or user must not reuse the old account's
-- cloud ids or reach its pods, and signing back in to the first account
-- brings its links back. Links made before this have no account (''), and
-- are claimed by the account this Mac is signed in to when the app or a
-- sign-in to that same account next sees them.
CREATE TABLE cloud_workspace_links (
  workspace_id TEXT NOT NULL,
  cloud_id TEXT NOT NULL UNIQUE,
  gateway_url TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, gateway_url, user_id)
);
INSERT INTO cloud_workspace_links (workspace_id, cloud_id, gateway_url, user_id)
  SELECT workspace_id, cloud_id, '', '' FROM cloud_workspaces;
DROP TABLE cloud_workspaces;

-- The account this Mac is signed in to now; no row while it is signed out.
CREATE TABLE cloud_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  gateway_url TEXT NOT NULL,
  user_id TEXT NOT NULL
);

-- Where a workspace lives: on this Mac (no row, or 'mac') or in its cloud
-- copy ('cloud'). Written only by a finished workspace move, by archive,
-- and by the fallback to this Mac's backup when the gateway deleted the
-- cloud copy. `notice` is what the user is told about the last such change
-- until they dismiss it.
CREATE TABLE workspace_places (
  workspace_id TEXT PRIMARY KEY,
  place TEXT NOT NULL CHECK (place IN ('mac', 'cloud')),
  notice TEXT
);

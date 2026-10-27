-- `team chat --tagged` reads only the messages that tag the reader, so it
-- keeps its own marker: moving read_through past the untagged messages
-- would lose them, and not moving it would print the tagged ones again.
ALTER TABLE team_cursors ADD COLUMN tagged_read_through INTEGER NOT NULL DEFAULT 0;

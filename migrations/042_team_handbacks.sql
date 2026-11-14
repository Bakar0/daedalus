-- A hand-back is the note Daedalus posts to a lead when a member's turn
-- ends. It is kept apart from what people wrote, because a lead gets at
-- most one delivery of hand-backs a minute while anything else goes at once.
ALTER TABLE team_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';
-- When the last delivery reached the reader's session, which the hand-back
-- rate is measured from.
ALTER TABLE team_cursors ADD COLUMN delivered_at TEXT;

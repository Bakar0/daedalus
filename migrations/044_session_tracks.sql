-- A session tracking another (#71): the main agent at Home keeps an eye on
-- ordinary sessions in any workspace without making them members of a team.
-- A tracked session's turn ends are reported to its tracker.
CREATE TABLE session_tracks (
  tracker_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  tracked_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tracker_session_id, tracked_session_id)
);
CREATE INDEX session_tracks_tracked ON session_tracks (tracked_session_id);
-- What goes between a tracker and a session it tracks, delivered in full
-- through the session's inbox: a report of a tracked session's turn end to
-- its tracker ('report', or 'waiting' when it waits on the user, which wakes
-- no one alone), or a message from the tracker to the tracked session.
-- `peer_session_id` is the other end: the session a report is about, or the
-- tracker a message is from. `delivered_at` stays null until it reached the
-- recipient; a failed attempt records why.
CREATE TABLE track_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  peer_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'report', 'waiting')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT,
  attempted_at TEXT
);
CREATE INDEX track_notes_recipient ON track_notes (recipient_session_id, delivered_at);

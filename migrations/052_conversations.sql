-- One messaging store for team channels and threads. A conversation is a
-- channel (a team's chat: many participants, `@tag` routing, never resolved)
-- or a thread (an agent and the user, hanging off a line in the agent's main,
-- resolved and reopened). Both are logs of append-only messages, and every
-- participant has a cursor in each. Replaces `team_messages`, `team_cursors`
-- and `asks`, whose rows are copied here and which are then dropped.

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'thread')),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- A channel's team: its lead's orchestration ability row, so the channel
  -- moves with the team on a handoff. The channel's name is the team's.
  team_id TEXT UNIQUE REFERENCES session_abilities(id) ON DELETE CASCADE,
  -- A thread's user-facing number (`#81`), its owner, and its subject.
  number INTEGER UNIQUE,
  owner_session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
  title TEXT,
  -- The line in the owner's main the thread hangs off: its id in the agent's
  -- transcript and a copy of its text for when the transcript is gone.
  anchor_id TEXT,
  anchor_text TEXT,
  -- The plan task a thread is pinned to: the plan's absolute path and ^id.
  plan_path TEXT,
  task_key TEXT,
  -- A read-only fork of the owner the user talks the thread through with.
  fork_session_id TEXT,
  fork_started_at TEXT,
  fork_synced_at TEXT,
  -- When the owner said it is blocked on the thread; cleared by any reply.
  blocked_at TEXT,
  snoozed_until TEXT,
  -- Null while open. `resolved_by` is `user`, `agent` or `daedalus`.
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'channel' AND team_id IS NOT NULL AND number IS NULL)
    OR (kind = 'thread' AND team_id IS NULL AND number IS NOT NULL
        AND owner_session_id IS NOT NULL)
  )
);
CREATE INDEX conversations_owner ON conversations (owner_session_id, resolved_at);
CREATE INDEX conversations_workspace ON conversations (workspace_id, kind);
CREATE INDEX conversations_plan ON conversations (plan_path, task_key);

-- `author` is a participant: in a channel a handle (`lead`, `user`, a
-- member's handle), in a thread `agent`, `user` or `lead`; `daedalus` writes
-- notices. A `notice` records an event (blocked, resolved, reopened) and is
-- never delivered to the session that caused it. `handback` and `waiting`
-- are channel notes Daedalus posts for a lead.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message'
    CHECK (kind IN ('message', 'notice', 'handback', 'waiting')),
  body TEXT NOT NULL,
  -- Folded under the body: ids, logs, links.
  details TEXT,
  -- Choices the reader can pick from, a JSON array of strings.
  options TEXT NOT NULL DEFAULT '[]',
  -- On a reply that picked one: its index in the latest offered options.
  picked INTEGER,
  -- Channel `@tags`, a JSON array of the handles it was pushed to.
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX messages_conversation ON messages (conversation_id, id);

-- What each participant has seen. `delivered_through` is the last message
-- Daedalus brought it (a session's inbox, the user's notification);
-- `read_through` the last it read; `tagged_read_through` the last tagged one
-- read with `channel read --tagged`. A failed delivery keeps
-- `delivered_through` and records why, so the next attempt sends it again.
CREATE TABLE cursors (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  participant TEXT NOT NULL,
  read_through INTEGER NOT NULL DEFAULT 0,
  tagged_read_through INTEGER NOT NULL DEFAULT 0,
  delivered_through INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  last_error TEXT,
  last_attempt_at TEXT,
  PRIMARY KEY (conversation_id, participant)
);

-- Search: trigram, so part of a word matches.
CREATE VIRTUAL TABLE messages_search USING fts5(
  body, details, content = 'messages', content_rowid = 'id', tokenize = 'trigram'
);
CREATE TRIGGER messages_search_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_search (rowid, body, details)
  VALUES (new.id, new.body, coalesce(new.details, ''));
END;
CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_search (messages_search, rowid, body, details)
  VALUES ('delete', old.id, old.body, coalesce(old.details, ''));
END;

-- Channels: one per team that has a chat, in its lead's workspace.
INSERT INTO conversations (kind, workspace_id, team_id, created_at, updated_at)
SELECT 'channel', agent_sessions.workspace_id, session_abilities.id,
       coalesce(MIN(team_messages.created_at), session_abilities.granted_at),
       coalesce(MAX(team_messages.created_at), session_abilities.granted_at)
FROM session_abilities
JOIN agent_sessions ON agent_sessions.id = session_abilities.session_id
LEFT JOIN team_messages ON team_messages.team_id = session_abilities.id
WHERE session_abilities.ability = 'orchestration'
  AND (team_messages.id IS NOT NULL
       OR EXISTS (SELECT 1 FROM team_cursors WHERE team_cursors.team_id = session_abilities.id))
GROUP BY session_abilities.id;

-- Channel messages keep their ids, so every cursor keeps its value.
INSERT INTO messages (id, conversation_id, author, kind, body, tags, created_at)
SELECT team_messages.id, conversations.id, team_messages.author,
       team_messages.kind, team_messages.body, team_messages.tags,
       team_messages.created_at
FROM team_messages
JOIN conversations ON conversations.team_id = team_messages.team_id
ORDER BY team_messages.id;

INSERT INTO cursors (conversation_id, participant, read_through,
  tagged_read_through, delivered_through, delivered_at, last_error, last_attempt_at)
SELECT conversations.id, team_cursors.handle, team_cursors.read_through,
       team_cursors.tagged_read_through, team_cursors.delivered_through,
       team_cursors.delivered_at, team_cursors.last_error, team_cursors.last_attempt_at
FROM team_cursors
JOIN conversations ON conversations.team_id = team_cursors.team_id;

-- Threads keep their numbers.
INSERT INTO conversations (kind, workspace_id, number, owner_session_id, title,
  anchor_id, anchor_text, plan_path, task_key, fork_session_id,
  fork_started_at, fork_synced_at, blocked_at, snoozed_until,
  resolved_at, resolved_by, created_at, updated_at)
SELECT 'thread', workspace_id, id, session_id, title,
       anchor_id, anchor_text, plan_path, task_key, fork_session_id,
       fork_started_at, fork_synced_at,
       CASE WHEN state = 'open' THEN bumped_at END,
       CASE WHEN state = 'open' THEN snoozed_until END,
       closed_at,
       CASE
         WHEN state IN ('answered', 'dismissed') AND closed_reason IS NOT 'Answered in its session' THEN 'user'
         WHEN closed_reason = 'Closed by the user' THEN 'user'
         WHEN state = 'open' THEN NULL
         WHEN closed_reason LIKE '''%'' was archived' OR closed_reason = 'Its session was deleted'
           OR closed_reason LIKE 'Its task ^%' THEN 'daedalus'
         ELSE 'agent'
       END,
       created_at, updated_at
FROM asks
ORDER BY id;

-- The question the agent asked; a fork thread was opened by the user and
-- starts with no message.
INSERT INTO messages (conversation_id, author, body, details, options, created_at)
SELECT conversations.id, 'agent',
       asks.title || coalesce(char(10) || char(10) || asks.why, ''),
       asks.context, asks.options, asks.created_at
FROM asks
JOIN conversations ON conversations.number = asks.id
WHERE asks.kind = 'question'
ORDER BY asks.id;

INSERT INTO messages (conversation_id, author, kind, body, created_at)
SELECT conversations.id, 'agent', 'notice', 'blocked', asks.bumped_at
FROM asks
JOIN conversations ON conversations.number = asks.id
WHERE asks.bumped_at IS NOT NULL
ORDER BY asks.id;

-- The user's answer: the option picked, the words written, or both.
INSERT INTO messages (conversation_id, author, body, picked, created_at)
SELECT conversations.id, 'user',
       trim(coalesce(asks.answer, '') || char(10) || coalesce(asks.note, ''), char(10)),
       (SELECT CAST(option.key AS INTEGER) FROM json_each(asks.options) AS option
        WHERE option.value = asks.answer),
       coalesce(asks.closed_at, asks.updated_at)
FROM asks
JOIN conversations ON conversations.number = asks.id
WHERE asks.state = 'answered'
  AND asks.closed_reason IS NOT 'Answered in its session'
  AND (asks.answer IS NOT NULL OR asks.note IS NOT NULL)
ORDER BY asks.id;

-- How it ended.
INSERT INTO messages (conversation_id, author, kind, body, created_at)
SELECT conversations.id, conversations.resolved_by, 'notice',
       'resolved' || CASE
         WHEN asks.state = 'answered' AND asks.closed_reason = 'Answered in its session'
           THEN ': answered in main' || coalesce(' (' || asks.note || ')', '')
         WHEN asks.state = 'answered' THEN ''
         ELSE coalesce(': ' || asks.closed_reason, '')
       END,
       coalesce(asks.closed_at, asks.updated_at)
FROM asks
JOIN conversations ON conversations.number = asks.id
WHERE asks.state <> 'open'
ORDER BY asks.id;

-- The user has read every thread's history up to now, and was notified of
-- all of it but an open question it was not notified of yet. The owner has
-- been brought everything but an ending the user wrote that it was not told.
INSERT INTO cursors (conversation_id, participant, read_through, delivered_through)
SELECT conversations.id, 'user', MAX(messages.id),
       CASE WHEN asks.state = 'open' AND asks.notified_at IS NULL THEN 0
            ELSE MAX(messages.id) END
FROM conversations
JOIN asks ON asks.id = conversations.number
JOIN messages ON messages.conversation_id = conversations.id
WHERE conversations.kind = 'thread'
GROUP BY conversations.id;

INSERT INTO cursors (conversation_id, participant, read_through, delivered_through)
SELECT conversations.id, 'agent', 0,
       CASE
         WHEN asks.notice_delivered_at IS NULL AND conversations.resolved_by = 'user'
           THEN coalesce((SELECT MAX(id) FROM messages
                          WHERE conversation_id = conversations.id AND author <> 'user'), 0)
         ELSE coalesce((SELECT MAX(id) FROM messages
                        WHERE conversation_id = conversations.id), 0)
       END
FROM conversations
JOIN asks ON asks.id = conversations.number
WHERE conversations.kind = 'thread';

DROP TABLE asks;
DROP TABLE team_cursors;
DROP TABLE team_messages;

-- A line Daedalus adds once to the next message it brings a session, then
-- deletes. Every session alive now is told the commands it learned changed.
CREATE TABLE session_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX session_notes_session ON session_notes (session_id);

INSERT INTO session_notes (session_id, body, created_at)
SELECT id,
  '[Daedalus] Messaging commands changed in this version. Threads: daedal thread new/say/read/find/list/bump/resolve (run ''daedal thread --help''). Team chat is now a channel: daedal channel say/read/find/list (run ''daedal channel --help''); messages from it start with [channel #<team>]. The commands you were taught before (thread start/update/show/close, team say/chat) now fail and print what to run instead.',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM agent_sessions WHERE archived_at IS NULL;

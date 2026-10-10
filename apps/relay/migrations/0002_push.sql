-- Web Push subscriptions, one per phone, and when each account was last
-- pushed to. A push carries no content: the phone shows a fixed line.

CREATE TABLE push_subscriptions (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

CREATE TABLE push_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_sent_at TEXT NOT NULL
);

-- Every change an admin makes to keys and plans: who, what, when. The
-- admin section shows it, and it is what admin actions are rate-limited by.
CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  -- The admin's account, or NULL for the admin key (relay-admin).
  actor_user_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  -- The key's code or the account's email.
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX admin_log_actor ON admin_log(actor_user_id, at);

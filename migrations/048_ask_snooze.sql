-- Snooze: an open ask the user put off until a time. Until then it is out
-- of Activity's count and folded under Snoozed; at the time it comes back
-- and the user is notified again (notified_at is cleared when it is snoozed).
ALTER TABLE asks ADD COLUMN snoozed_until TEXT;

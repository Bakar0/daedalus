-- Frames, not bytes, are what the relay is billed for: count them per
-- account and month, and give each plan a monthly frame allowance.
ALTER TABLE usage ADD COLUMN frames INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entitlements ADD COLUMN monthly_frames INTEGER NOT NULL DEFAULT 3000000;

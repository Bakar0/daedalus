-- Pro. An invite can grant its plan for a number of days (a trial); without
-- them the plan has no end. Plans themselves live in PLANS in accounts.ts.
ALTER TABLE invites ADD COLUMN grant_days INTEGER;

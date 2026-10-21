-- The tool call a reading is about, as the provider names it. A wait keeps
-- it so that only that call ending ends the wait: Claude runs tools side by
-- side, and another one finishing while a dialog is up took the badge down.
-- NULL is a reading no hook tied to a call, and ends the way it always did.
ALTER TABLE agent_activity ADD COLUMN tool_use_id TEXT;

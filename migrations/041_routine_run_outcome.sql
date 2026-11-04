-- What a finished run found, apart from whether it ran: 'ok' when nothing
-- needs a person, 'attention' when something does. Null for runs from
-- before this, and for runs that did not finish.
ALTER TABLE workspace_routine_runs ADD COLUMN outcome TEXT;

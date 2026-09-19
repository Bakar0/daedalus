-- Reboot recovery needs two things the schema could not say.
--
-- `lost_reason` is why a vanished session could not be brought back. A reboot
-- kills the Daedalus tmux server, every live row reconciles to `lost`, and the
-- startup sweep resumes each one's native conversation. The ones it cannot
-- resume — a custom session with no native resume command, a Claude session
-- whose transcript cannot be identified, a working directory that is gone —
-- must say so on the card instead of sitting there as a bare red dot. It is
-- cleared whenever a session goes `lost` afresh, so it always describes the
-- current disappearance rather than the last one.
ALTER TABLE agent_sessions ADD COLUMN lost_reason TEXT;

-- `revived_at` marks an integrated terminal that was reopened by that sweep.
-- A terminal has no conversation to resume, so it comes back as a fresh login
-- shell in the same directory: everything except the scrollback. That is worth
-- having and worth admitting to, and the two are only distinguishable with a
-- record of it, so the tab can say the history is not what it was.
ALTER TABLE integrated_terminals ADD COLUMN revived_at TEXT;

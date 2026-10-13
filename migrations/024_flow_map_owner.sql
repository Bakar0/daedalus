-- A flow map belongs to the session that builds it (#65, decided
-- 2026-10-13): to that session's flow ability row, the way a team belongs to
-- its lead's orchestration row. A rebirth moves the row, so the map follows
-- the work; a revoke keeps the row, so the map stays readable and comes back
-- on a new grant. Only the owner changes the map's shape; any session in the
-- workspace may claim and finish its stages.
ALTER TABLE flow_maps ADD COLUMN ability_id TEXT
  REFERENCES session_abilities(id) ON DELETE CASCADE;

-- Maps made before this belong to the newest flow ability in their
-- workspace; a map with none to belong to is removed.
UPDATE flow_maps SET ability_id = (
  SELECT session_abilities.id FROM session_abilities
  JOIN agent_sessions ON agent_sessions.id = session_abilities.session_id
  WHERE session_abilities.ability = 'flow'
    AND agent_sessions.workspace_id = flow_maps.workspace_id
  ORDER BY session_abilities.enabled DESC, session_abilities.granted_at DESC
  LIMIT 1
);
DELETE FROM flow_maps WHERE ability_id IS NULL;

CREATE INDEX flow_maps_ability_idx ON flow_maps(ability_id);

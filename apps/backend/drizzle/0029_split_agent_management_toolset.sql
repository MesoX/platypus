-- Split the legacy "agent-management" toolset into three:
--   - agent-discovery   (read-only: listAgents, getAgent, listToolSets, listModelProviders)
--   - skill-management  (listSkills, getSkill, upsertSkill, deleteSkill)
--   - agent-management  (write-only: createAgent, updateAgent, deleteAgent)
--
-- Additive migration: any agent that previously had "agent-management" in its
-- tool_set_ids gets "agent-discovery" and "skill-management" added alongside it,
-- preserving existing capability. Idempotent — re-running is a no-op once the
-- new IDs are already present.

UPDATE "agent"
SET "tool_set_ids" = (
  SELECT jsonb_agg(DISTINCT v)
  FROM jsonb_array_elements_text(
    "tool_set_ids" || '["agent-discovery", "skill-management"]'::jsonb
  ) AS t(v)
)
WHERE "tool_set_ids" @> '["agent-management"]'::jsonb
  AND NOT (
    "tool_set_ids" @> '["agent-discovery"]'::jsonb
    AND "tool_set_ids" @> '["skill-management"]'::jsonb
  );

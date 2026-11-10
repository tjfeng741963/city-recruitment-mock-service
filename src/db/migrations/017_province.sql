ALTER TABLE agent_conversations ADD COLUMN province TEXT NOT NULL DEFAULT '';
ALTER TABLE candidate_events ADD COLUMN province TEXT NOT NULL DEFAULT '';

ALTER TABLE agent_conversations ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_conversations ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_conversations ADD COLUMN remark TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_conversations ADD COLUMN factory_name TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_conversations ADD COLUMN interview_date TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_conversations ADD COLUMN interview_time TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_conversations ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE dify_recruitment_state (
  identity TEXT PRIMARY KEY,
  position_id INTEGER REFERENCES service_positions(id) ON DELETE SET NULL,
  draft_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE agent_archive ADD COLUMN dify_device_code TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_archive ADD COLUMN dify_conversation_row_id INTEGER;
ALTER TABLE agent_archive ADD COLUMN dify_external_session TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_archive ADD COLUMN dify_account_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_archive ADD COLUMN interview_point TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_archive ADD COLUMN interview_address TEXT NOT NULL DEFAULT '';

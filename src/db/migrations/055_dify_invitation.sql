CREATE TABLE dify_invitation_state (
  identity TEXT PRIMARY KEY,
  position_id INTEGER NOT NULL REFERENCES service_positions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('invited','offered','declined','waiting_confirmation'))
);

CREATE TABLE dify_interview_reminders (
  archive_key TEXT PRIMARY KEY REFERENCES agent_archive(session_key) ON DELETE CASCADE,
  device_code TEXT NOT NULL,
  command_id TEXT UNIQUE REFERENCES bridge_commands(id) ON DELETE CASCADE,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0,1)),
  due_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  interview_date TEXT NOT NULL,
  interview_time TEXT NOT NULL,
  interview_address TEXT NOT NULL
);
CREATE INDEX idx_dify_interview_reminders_due ON dify_interview_reminders(device_code, due_at) WHERE command_id IS NULL AND suppressed=0;

CREATE TABLE dify_turn_plan (
  identity TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  position_id INTEGER NOT NULL REFERENCES service_positions(id) ON DELETE CASCADE,
  facts_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

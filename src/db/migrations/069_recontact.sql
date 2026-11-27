CREATE TABLE recontact_rules (
  position_id INTEGER NOT NULL REFERENCES service_positions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('work_location','interview_invite')),
  enabled INTEGER NOT NULL,
  wait_minutes INTEGER NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  parts_json TEXT NOT NULL,
  enabled_at INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (position_id,stage)
);
CREATE TABLE recontact_templates (
  id INTEGER PRIMARY KEY,
  position_id INTEGER NOT NULL REFERENCES service_positions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE recontact_previews (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  result_json TEXT
);
CREATE TABLE recontact_devices (
  device_code TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  enabled_at INTEGER NOT NULL
);
CREATE TABLE recontact_capability (
  device_code TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE TABLE recontact_jobs (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  position_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  device_code TEXT NOT NULL,
  account_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  mode_generation TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('auto','batch')),
  stage TEXT NOT NULL DEFAULT '',
  origin_key TEXT NOT NULL,
  baseline_inbound_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  reason TEXT NOT NULL DEFAULT '',
  stop_reason TEXT NOT NULL DEFAULT '',
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id,account_id,contact_id,origin_key)
);
CREATE UNIQUE INDEX recontact_active_session ON recontact_jobs(tenant_id,account_id,contact_id)
  WHERE status IN ('scheduled','sending','unknown');
CREATE UNIQUE INDEX recontact_auto_round ON recontact_jobs(tenant_id,account_id,contact_id,baseline_inbound_id)
  WHERE source='auto';
CREATE INDEX recontact_due ON recontact_jobs(device_code,status,due_at);
CREATE TABLE recontact_steps (
  job_id INTEGER NOT NULL REFERENCES recontact_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  value TEXT NOT NULL,
  payload TEXT NOT NULL,
  delay_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL DEFAULT '',
  due_at INTEGER,
  confirmed_at INTEGER,
  command_id TEXT UNIQUE,
  PRIMARY KEY(job_id,seq)
);
CREATE TABLE recontact_anchors (
  trace_id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  position_id INTEGER NOT NULL,
  mode_generation TEXT NOT NULL,
  provider TEXT NOT NULL,
  inbound_source TEXT NOT NULL,
  stage TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX recontact_anchors_pending ON recontact_anchors (device_code,consumed,delivered_at);
ALTER TABLE agent_conversation_state ADD COLUMN recontact_inbound_id TEXT NOT NULL DEFAULT '';

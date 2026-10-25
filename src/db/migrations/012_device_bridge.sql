CREATE TABLE bridge_devices (
  device_code TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'offline' CHECK(state IN ('offline','scanning','online')),
  heartbeat_at INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE message_deliveries ADD COLUMN generated_content TEXT;
CREATE TABLE bridge_contacts (
  device_code TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(device_code,contact_id),
  UNIQUE(device_code,customer_id)
);
CREATE TABLE bridge_commands (
  id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  contact_id TEXT NOT NULL,
  content TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','succeeded','failed','unknown')),
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  message_id TEXT NOT NULL DEFAULT '',
  simulated INTEGER NOT NULL DEFAULT 0,
  receipt_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(device_code,idempotency_key)
);
CREATE INDEX idx_bridge_commands_pending ON bridge_commands(device_code,status,created_at);
CREATE TABLE bridge_inbound (
  device_code TEXT NOT NULL,
  event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(device_code,event_id)
);

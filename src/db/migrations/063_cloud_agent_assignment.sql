CREATE TABLE cloud_agent_machine_presence (
  machine_code TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE TABLE cloud_agent_assignments (
  account_id INTEGER PRIMARY KEY REFERENCES agent_devices(id) ON DELETE CASCADE,
  device_code TEXT NOT NULL UNIQUE,
  requested_by INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  machine_code TEXT UNIQUE,
  assigned_by INTEGER,
  assigned_at INTEGER,
  nonce TEXT UNIQUE,
  issued_token_hash TEXT,
  connected_at INTEGER
);

CREATE TABLE dify_reply_sessions (
  identity TEXT PRIMARY KEY,
  device_code TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE dify_reply_calls (
  id TEXT PRIMARY KEY,
  device_code TEXT NOT NULL,
  position_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

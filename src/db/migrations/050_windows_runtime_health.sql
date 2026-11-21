CREATE TABLE IF NOT EXISTS windows_runtime_health (
  device_code TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  wecom_available INTEGER NOT NULL,
  reply_ready INTEGER NOT NULL,
  reason TEXT NOT NULL,
  sync_state TEXT NOT NULL,
  backlog INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reply_mode_transition (
  device_code TEXT PRIMARY KEY,
  id TEXT NOT NULL DEFAULT '',
  parent_id TEXT NOT NULL DEFAULT '',
  generation TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'idle',
  effective TEXT NOT NULL,
  target TEXT NOT NULL,
  started_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  client_at INTEGER NOT NULL DEFAULT 0,
  client_ready INTEGER NOT NULL DEFAULT 0,
  issue TEXT NOT NULL DEFAULT '',
  rollback INTEGER NOT NULL DEFAULT 0
);

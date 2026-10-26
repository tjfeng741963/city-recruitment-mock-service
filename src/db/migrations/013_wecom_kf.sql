CREATE TABLE wecom_connections (
  corp_id TEXT NOT NULL, open_kfid TEXT NOT NULL, device_code TEXT NOT NULL UNIQUE,
  cursor TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 0, processed_generation INTEGER NOT NULL DEFAULT 0,
  sync_token TEXT NOT NULL DEFAULT '', token_expires_at INTEGER NOT NULL DEFAULT 0,
  reply_after INTEGER NOT NULL, last_sync_at INTEGER NOT NULL DEFAULT 0, next_sync_at INTEGER NOT NULL DEFAULT 0,
  callback_verified_at INTEGER, last_error TEXT,
  PRIMARY KEY(corp_id,open_kfid)
);
CREATE TABLE wecom_callback_events (payload_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE wecom_contacts (
  corp_id TEXT NOT NULL, open_kfid TEXT NOT NULL, external_userid TEXT NOT NULL,
  device_code TEXT NOT NULL, customer_id INTEGER NOT NULL UNIQUE,
  last_customer_at INTEGER NOT NULL DEFAULT 0, last_customer_msgid TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(corp_id,open_kfid,external_userid)
);
CREATE TABLE wecom_inbox (
  corp_id TEXT NOT NULL, open_kfid TEXT NOT NULL, msgid TEXT NOT NULL,
  customer_id INTEGER, payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','processing','done','ignored','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(corp_id,open_kfid,msgid)
);
CREATE TABLE wecom_outbox (
  id INTEGER PRIMARY KEY, corp_id TEXT NOT NULL, open_kfid TEXT NOT NULL, device_code TEXT NOT NULL,
  customer_id INTEGER NOT NULL, external_userid TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  msgid TEXT NOT NULL, content TEXT NOT NULL, window_msgid TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','sending','api_accepted','unknown','blocked','failed')),
  last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(corp_id,open_kfid,idempotency_key), UNIQUE(corp_id,open_kfid,msgid)
);
CREATE INDEX idx_wecom_inbox_pending ON wecom_inbox(status,next_attempt_at,created_at);
CREATE INDEX idx_wecom_outbox_quota ON wecom_outbox(corp_id,open_kfid,customer_id,window_msgid,status);

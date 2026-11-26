CREATE TABLE recipient_bindings (
  device_code TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('conflict','awaiting','verified','needs_confirmation')),
  remark TEXT UNIQUE,
  PRIMARY KEY (device_code, account_id, conversation_id),
  CHECK ((status = 'conflict' AND remark IS NULL) OR (status <> 'conflict' AND remark IS NOT NULL))
);

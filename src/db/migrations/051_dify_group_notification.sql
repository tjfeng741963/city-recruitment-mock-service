ALTER TABLE agent_archive ADD COLUMN dify_notify_binding TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_archive ADD COLUMN dify_notify_content TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_dify_archive_pending_notice
  ON agent_archive(dify_device_code, dify_account_id, dify_notify_binding)
  WHERE dify_notify_content <> '';

CREATE TABLE bridge_outbound (
  device_code TEXT NOT NULL,
  event_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY(device_code,event_id)
);
CREATE INDEX idx_bridge_commands_message ON bridge_commands(device_code,message_id);

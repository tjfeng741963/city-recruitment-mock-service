CREATE TABLE dify_material_followup (
  identity TEXT PRIMARY KEY,
  position_id INTEGER NOT NULL REFERENCES service_positions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('image', 'video', 'both')),
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_dify_material_followup_expiry ON dify_material_followup(expires_at);

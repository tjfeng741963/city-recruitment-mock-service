CREATE TABLE kb_publication_preview (
  id TEXT PRIMARY KEY,
  source_revision TEXT NOT NULL,
  target_url TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL
);

-- 企微收藏位置快照：按当前设备上报的企微账号隔离。
CREATE TABLE IF NOT EXISTS location_favorites (
  account_id TEXT NOT NULL,
  favorite_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'location' CHECK(kind IN ('location','other')),
  title TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  location_card_sha TEXT NOT NULL DEFAULT '',
  snapshot_id TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(account_id, favorite_id)
);

CREATE INDEX IF NOT EXISTS idx_location_favorites_account
  ON location_favorites(account_id, kind, title);

ALTER TABLE location_cards ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
ALTER TABLE location_cards ADD COLUMN source_favorite_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_location_cards_account ON location_cards(account_id, created_at);

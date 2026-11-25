-- 开场支持「位置卡」条目（2026-11-25）
--
-- 背景：客户加好友后第一句常常是「在哪面试」「发个地址」。过去开场只能发
-- 文字/图片/视频，地址得等客户问、Agent 再回。
--
-- 现在客户端能发企微原生位置卡（见 agent/location_card.py：按坐标生成
-- 位置消息 + 粘贴发送），所以开场最后一条可以直接是那张卡。
--
-- SQLite 不能改 CHECK 约束，只能重建表。content 复用为 JSON：
--   {"lng":113.39114,"lat":23.117692,"address":"…","name":"冠宇商务中心"}
-- 其余列原样保留（media_name/delay_ms/status 等语义不变）。

PRAGMA foreign_keys = OFF;

CREATE TABLE position_opening_new (
  id INTEGER PRIMARY KEY,
  position_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  media_name TEXT NOT NULL DEFAULT '',
  delay_ms INTEGER NOT NULL DEFAULT 2000,
  status TEXT NOT NULL DEFAULT 'enabled',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind IN ('text', 'image', 'video', 'location')),
  CHECK (status IN ('enabled', 'disabled')),
  CHECK (delay_ms >= 0)
);

INSERT INTO position_opening_new
  (id, position_id, seq, kind, content, media_name, delay_ms, status, created_at, updated_at)
SELECT id, position_id, seq, kind, content, media_name, delay_ms, status, created_at, updated_at
  FROM position_opening;

DROP TABLE position_opening;
ALTER TABLE position_opening_new RENAME TO position_opening;

CREATE INDEX IF NOT EXISTS idx_position_opening_order
  ON position_opening(position_id, status, seq, id);

PRAGMA foreign_keys = ON;

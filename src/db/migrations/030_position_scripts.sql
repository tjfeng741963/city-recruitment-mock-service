-- 按岗位配置话术（2026-11-14 四端契约）。
--
-- 背景：device_scripts 是「按设备 + stage + 城市」的话术，同一个岗位在不同设备上
-- 要各配一遍，运营漏配就会退回到通用话术。岗位话术挂在 service_positions 上，
-- 配置一次，所有能接这个岗位的设备都拿到同一份。
--
-- content 支持占位符 {{factory}} {{job_title}} {{wage}} {{hours_text}}
-- {{age_text}} {{welfare}}，以及媒体标记 【图片:xxx.jpg】/【视频:xx.mp4】；
-- media_json 是这些媒体的清单（[{"name":"xxx.jpg","kind":"image"}]），
-- 客户端按 name 到 media_assets 找文件。
--
-- UNIQUE(position_id, stage) 让「保存」是 upsert：同一个岗位同一阶段只有一条，
-- 网页上反复点保存不会堆行。

CREATE TABLE IF NOT EXISTS position_scripts (
  id INTEGER PRIMARY KEY,
  position_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  media_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'enabled',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(position_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_position_scripts_position ON position_scripts(position_id);

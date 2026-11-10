-- 设备绑定话术（契约：docs/对齐-配置分发与按设备话术.md §2）
-- 同一设备同一 stage 同一城市只允许一条，POST 路由按此做 upsert。
CREATE TABLE IF NOT EXISTS device_scripts (
  id INTEGER PRIMARY KEY,
  device_code TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'send_info',     -- ask_city/send_info/ask_interview/collect/done
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'enabled',
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(device_code, stage, city)
);

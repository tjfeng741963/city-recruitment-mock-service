-- 设备状态事件流水（契约：掉线提醒与历史补录）
-- heartbeat 状态变化落 reason='reported'，心跳超时清扫落 reason='heartbeat_timeout'。
-- 掉线/扫描推送的 5 分钟节流窗口以本表最近一条同类事件为基准（DB 查询，重启不丢）。
CREATE TABLE IF NOT EXISTS device_events (
  id INTEGER PRIMARY KEY, device_code TEXT NOT NULL, event_type TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_device_events_code ON device_events(device_code, created_at);

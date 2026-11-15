-- 名单自动发内部邀约群（R1，录屏 02:10 实证格式）。
--
-- 客户明确的 MVP 三件事之一：聊天里收齐「姓名 + 手机号 + 面试日期 + 城市」
-- 后，按 `[城市简写][月/日] [姓名] [手机号]` 自动发到内部邀约群，
-- 例：`深11/9 谢子鑫 18077352958`。
--
-- 为什么要单独建表而不是只写 bridge_commands：
--   ① bridge_commands 只保留当前待发/已发指令，运营事后没法查「这条名单发没发出去」
--   ② 同一位候选人可能改期，需要能看到每次发送的历史与失败原因
--   ③ 幂等键要能跨进程恢复，不能只靠内存
CREATE TABLE IF NOT EXISTS invite_group_sends (
  id INTEGER PRIMARY KEY,
  device_code TEXT NOT NULL DEFAULT '',
  customer_id TEXT NOT NULL DEFAULT '',
  candidate_event_id INTEGER NOT NULL DEFAULT 0,
  group_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  -- pending_send 待入队 / sent 已入队 / failed 入队失败 / skipped 缺配置或字段不全
  status TEXT NOT NULL DEFAULT 'pending_send',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_group_sends_key
  ON invite_group_sends(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_invite_group_sends_created
  ON invite_group_sends(created_at);

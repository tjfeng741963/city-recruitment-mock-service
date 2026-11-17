-- Agent 会话记忆（2026-11-17）：服务端持有会话上下文，客户端只上报消息。
-- context_json 是全量对话条目：[{role:"customer"|"agent", text:"..."}]，
-- assistant 媒体占位条目带 kind/name。开场序列不进这张表：它是岗位配置
-- （position_opening），每轮由编排层从配置注入，运营改了开场新轮次就生效。
CREATE TABLE IF NOT EXISTS agent_session (
  session_key  TEXT PRIMARY KEY,
  position_id  INTEGER NOT NULL,
  context_json TEXT NOT NULL DEFAULT '[]',
  updated_at   TEXT
);

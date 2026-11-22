-- Agent/Dify 接待证据（2026-11-22）：把一次试答或正式调用的岗位、资料、流程
-- 版本和结果放在同一条可回查记录里。Dify 也使用同一张表，后续接入阶段信息时
-- 不需要再次改动运营侧查询契约。
CREATE TABLE IF NOT EXISTS agent_execution_trace (
  trace_id       TEXT PRIMARY KEY,
  session_key    TEXT NOT NULL DEFAULT '',
  device_code    TEXT NOT NULL DEFAULT '',
  customer_id    INTEGER NOT NULL DEFAULT 0,
  position_id    INTEGER NOT NULL DEFAULT 0,
  engine         TEXT NOT NULL DEFAULT 'agent'
                   CHECK (engine IN ('agent','dify','unknown')),
  flow_version   INTEGER NOT NULL DEFAULT 0,
  flow_status    TEXT NOT NULL DEFAULT '',
  stage          TEXT NOT NULL DEFAULT '',
  node_key       TEXT NOT NULL DEFAULT '',
  request_text   TEXT NOT NULL DEFAULT '',
  facts_json     TEXT NOT NULL DEFAULT '{}',
  fact_sources_json TEXT NOT NULL DEFAULT '{}',
  scripts_json   TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received','dry_run','succeeded','failed')),
  error_code     TEXT NOT NULL DEFAULT '',
  error_message  TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  usage_json     TEXT NOT NULL DEFAULT '{}',
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  reply_json     TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_execution_trace_session
  ON agent_execution_trace(session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_execution_trace_device
  ON agent_execution_trace(device_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_execution_trace_position
  ON agent_execution_trace(position_id, created_at DESC);

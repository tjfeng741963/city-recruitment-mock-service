-- 真实客户端发送回执（2026-11-22）：把模型/流程执行与企微键鼠发送结果关联。
ALTER TABLE agent_execution_trace ADD COLUMN delivery_status TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_execution_trace ADD COLUMN delivery_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_execution_trace ADD COLUMN delivery_detail TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_execution_trace ADD COLUMN delivery_at TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_execution_trace_delivery
  ON agent_execution_trace(delivery_status, delivery_at DESC);

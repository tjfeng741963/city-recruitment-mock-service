-- 未知问题（知识库没答上来的原话）。
-- 表在 001 就有（id/question/status/data_json/时间戳），这里补本期流程需要的三列：
--   device_code      哪个账号收的（多设备时才知道找谁补话术）
--   customer_id      客户的会话标识（8090 传的是 external_conversation_id）
--   occurrence_count 同一句问了几次，用来排序（问得多的先补）
ALTER TABLE unknown_questions ADD COLUMN device_code TEXT NOT NULL DEFAULT '';
ALTER TABLE unknown_questions ADD COLUMN customer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE unknown_questions ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_unknown_questions_status ON unknown_questions(status);
CREATE INDEX IF NOT EXISTS idx_unknown_questions_device_question ON unknown_questions(device_code, question);

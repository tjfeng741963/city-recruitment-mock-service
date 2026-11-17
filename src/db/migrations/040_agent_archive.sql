-- 面试档案（2026-11-17）：内容由模型 JSON 判断结果合并写入，
-- 系统不做任何硬提取。interview_confirmed=1 表示双方定下了面试；
-- 面试者改时间时，新一轮输出覆盖旧值（mergeArchive：非空才覆盖）。
CREATE TABLE IF NOT EXISTS agent_archive (
  session_key        TEXT PRIMARY KEY,
  position_id        INTEGER NOT NULL,
  name               TEXT NOT NULL DEFAULT '',
  phone              TEXT NOT NULL DEFAULT '',
  city               TEXT NOT NULL DEFAULT '',
  interview_date     TEXT NOT NULL DEFAULT '',
  interview_time     TEXT NOT NULL DEFAULT '',
  interview_confirmed INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT
);

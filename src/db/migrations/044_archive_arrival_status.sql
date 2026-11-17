-- 面试到达状态（2026-11-17）：约定时间后运营在面试登记面板标记
-- 「已到达 / 爽约」，空串 = 还没到约定时间或未标记。
ALTER TABLE agent_archive ADD COLUMN arrival_status TEXT NOT NULL DEFAULT '';

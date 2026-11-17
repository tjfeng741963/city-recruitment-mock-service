-- 媒体分层（2026-11-17）：通用素材 vs 岗位专属素材。
-- position_id = 0  → 通用素材（工作内容图/安检视频/宿舍图，全部岗位共用）
-- position_id > 0  → 岗位专属（如「面试地点.png」绑广州岗位——各城市面试
--                     地址不同，地点图必须跟岗位走，不能跨岗位串发）
-- Agent 侧不直接读这张表：buildFacts 把岗位绑定的地点图名字注入
-- 事实卡（interview_address_image），模型按名字引用，客户端按名字
-- 「先检索本地 → 缺了从 4222 下载 → 粘贴发送」。
ALTER TABLE media_assets ADD COLUMN position_id INTEGER NOT NULL DEFAULT 0;

-- 面试登记备注（2026-11-23）
--
-- 用途：群通知里「姓名」后面那一段，也就是客户在企微里的叫法（微信名称）。
-- 默认留空时自动取 agent_conversations.nickname；运营也可以在面试登记页覆盖，
-- 比如客户昵称是广告词、表情，或者要写「xx 介绍」这类说明。
ALTER TABLE agent_archive ADD COLUMN remark TEXT NOT NULL DEFAULT '';

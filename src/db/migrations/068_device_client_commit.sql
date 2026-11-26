-- 客户端版本（git commit）：Win 端心跳上报，用来核对设备跑的是不是最新发布。
--
-- 2026-11-26 现场：看板上分不清「已更新」和「以为更新了」，只能 SSH 上机器翻
-- .client-version.json 才知道真实版本。心跳带上 commit 后，服务端和前端都能直接看。
-- 空串表示客户端还没上报（旧版本客户端）。
ALTER TABLE bridge_devices ADD COLUMN client_commit TEXT NOT NULL DEFAULT '';

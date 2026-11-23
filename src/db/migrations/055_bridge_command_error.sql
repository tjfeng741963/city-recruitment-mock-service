-- 刷新指令的失败原因（2026-11-23）
--
-- 网页点了「刷新二维码」后，客户端可能失败：没找到登录窗（已登录/窗口被隐藏）、
-- 点击异常、截图为空。以前这些原因只写进客户端日志，运营在网页看不到，只能
-- 从「图没变」猜。
--
-- 这里把 error 落到指令行上，GET /login-qr 会带最近一条刷新指令的
-- status/error，网页据此显示「上次刷新失败：没找到企微登录窗」。
ALTER TABLE bridge_commands ADD COLUMN error TEXT NOT NULL DEFAULT '';

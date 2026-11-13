-- 存量设备补 observe_only，堵住「双引擎回复」生产事故（2026-11-13）。
--
-- 背景：服务端 message-automation 收到 inbound 会自己调 8090 生成回复并
-- 入队 bridge_commands；客户端 drain() 也会调 8090 直接键盘鼠标发消息。两边
-- 同时开时，同一会话的阶段被推进两次，客户收到两条不同的回复（实机表现为
-- 「左边回一句、右边回一句」）。
--
-- observe_only=true 让服务端只记录、不生成回复，执行权归客户端。
-- 自注册路径（/bridge/devices/:code/register）一直写 true；管理员在网页上
-- 「绑定新号」（POST /api/v1/agent/devices）漏了，存量设备里就有这种。
--
-- 这里把「没显式设过 observe_only」的设备统一补成 true。
-- 显式设成 false 的不动——那是企微官方客服 API 通道，执行权在服务端。
UPDATE agent_devices
   SET data_json = json_set(data_json, '$.observe_only', json('true'))
 WHERE json_extract(data_json, '$.observe_only') IS NULL;

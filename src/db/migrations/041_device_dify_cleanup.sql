-- Dify 全链路下线（2026-11-17）：设备档案里遗留的 dify 字段一次性清除，
-- 保证 data_json 结构与当前真实消费方（岗位绑定 / 心跳 / 二维码）一致。
-- 之后设备 PUT 也会拒绝 dify 字段落库（agent.routes 在合并前剔除）。
UPDATE agent_devices
   SET data_json = json_remove(
         json_remove(
           json_remove(data_json, '$.dify_url'),
         '$.dify_key'),
       '$.dify_key_env')
 WHERE data_json LIKE '%dify%';

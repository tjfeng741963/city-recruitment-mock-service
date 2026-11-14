-- 候选人表字段回填（2026-11-14）。
--
-- 客户要的 OA 口径：归属账号 / 项目名称 / 面试时间 / 客户真实姓名 /
-- 手机号码 / 省市区 / 客户状态标签 / 提醒到场。
--
-- 这些列在 candidate_events 里本来就有，但历史行是空的：早期建事件只写了
-- nickname + city，后续对话里补上的省、区县、厂名、面试时间没有回写。
-- 这里先补能补的，其余由 profile.routes.ts 的后续推送继续补。

UPDATE candidate_events
   SET province = COALESCE(
         NULLIF(province, ''),
         (SELECT c.province FROM cities c WHERE c.city_name = candidate_events.city LIMIT 1),
         ''
       )
 WHERE province = '' AND city <> '';

UPDATE candidate_events
   SET district = COALESCE(NULLIF(district, ''), (SELECT NULLIF(ac.district, '') FROM agent_conversations ac
         WHERE ac.device_code = candidate_events.device_code AND ac.customer_id = candidate_events.customer_id LIMIT 1), ''),
       factory_name = COALESCE(NULLIF(factory_name, ''), (SELECT NULLIF(ac.factory_name, '') FROM agent_conversations ac
         WHERE ac.device_code = candidate_events.device_code AND ac.customer_id = candidate_events.customer_id LIMIT 1), ''),
       interview_time = COALESCE(NULLIF(interview_time, ''), (SELECT NULLIF(ac.interview_time, '') FROM agent_conversations ac
         WHERE ac.device_code = candidate_events.device_code AND ac.customer_id = candidate_events.customer_id LIMIT 1), '')
 WHERE event_type IN ('invited', 'disqualified');

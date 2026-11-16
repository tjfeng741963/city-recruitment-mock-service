-- 设备必须绑定品类（2026-11-13 与 HR 对齐）。
--
-- HR 原话：「a工厂对应a账号，a地铁会对应a账号……大方向已经定死了的，不会乱来」。
-- 一个微信号只做一个板块，不存在「什么都招」的综合号。
-- 所以 vertical_id 是设备的必填项，不再是可选的过滤条件。
--
-- 本条迁移只做两件事：
--   1. 给已存在但没绑品类的设备补一个默认值（factory），
--      否则新的必填校验会让这些设备无法保存配置。运营随后在网页上改。
--   2. 补 logistics / rpo / daily 三个板块的空壳配置（本期不推广，先占位，
--      等客户给真实岗位数据再填 position_schema）。
--
-- 注意：补默认值只是迁移的一次性动作；新建/编辑设备时前端仍要求显式选择。

UPDATE agent_devices
   SET data_json = json_set(data_json, '$.vertical_id',
         (SELECT id FROM vertical WHERE tenant_id=1 AND code='factory'))
 WHERE json_extract(data_json, '$.vertical_id') IS NULL
   AND EXISTS (SELECT 1 FROM vertical WHERE tenant_id=1 AND code='factory');

-- 物流：字段先按工厂的通用形态（工价/班次/吃住），等真实数据再调整
INSERT INTO vertical (tenant_id, code, name, config_json, sort_order)
SELECT 1, 'logistics', '物流',
       '{"employer_label":"物流点","location_levels":["province","city","district","point"],"position_schema":[{"key":"wage_text","label":"工价","type":"text","required":true},{"key":"hours_text","label":"班次","type":"text"},{"key":"welfare_text","label":"吃住","type":"text"}],"faq_pack":"","flow_template":""}',
       3
WHERE NOT EXISTS (SELECT 1 FROM vertical WHERE tenant_id=1 AND code='logistics');

-- RPO：服务员、保洁、保安、客服、会计等
INSERT INTO vertical (tenant_id, code, name, config_json, sort_order)
SELECT 1, 'rpo', 'RPO',
       '{"employer_label":"用工单位","location_levels":["province","city","district","point"],"position_schema":[{"key":"wage_text","label":"月薪","type":"text","required":true},{"key":"hours_text","label":"班次","type":"text"},{"key":"welfare_text","label":"福利","type":"text"}],"faq_pack":"","flow_template":""}',
       4
WHERE NOT EXISTS (SELECT 1 FROM vertical WHERE tenant_id=1 AND code='rpo');

-- 日结兼职
INSERT INTO vertical (tenant_id, code, name, config_json, sort_order)
SELECT 1, 'daily', '日结兼职',
       '{"employer_label":"用工方","location_levels":["province","city","point"],"position_schema":[{"key":"wage_text","label":"日薪","type":"text","required":true},{"key":"hours_text","label":"时长","type":"text"}],"faq_pack":"","flow_template":""}',
       5
WHERE NOT EXISTS (SELECT 1 FROM vertical WHERE tenant_id=1 AND code='daily');

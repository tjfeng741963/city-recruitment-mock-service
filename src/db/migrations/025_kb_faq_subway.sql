-- 025_kb_faq_subway.sql
-- 地铁安检品类通用问答包（faq-subway-v1）+ 流程模板。
--
-- 内容来源：《11.9全国安检输送集合信息+薪资表.xlsx》的真实表格字段：
-- 城市 / 薪资待遇 / 上班时间及月休 / 基本要求 / 安排线路 / 面试时间 /
-- 联系人 / 面试地址 / 面试携带资料 / 上岗流程及资料 / 临时备注。
-- 覆盖城市：广州、佛山、南昌、深圳、南宁。
--
-- 与工厂包（022）的差别：
--   * 地铁的「厂」其实是线路/站点，用 employer 抽象不够贴切，主要靠 city scope
--   * 多了身高、线路、民族限制、月休四个品类特有字段
--   * 面试时间是「周一至周六 上午11:00-11:30 下午14:00-14:30」这类窗口，
--     不能写死成某个日期
--
-- 幂等：靠 code / question 唯一 + NOT EXISTS。

INSERT INTO kb_template (code, name, vertical_code, version)
SELECT 'faq-subway-v1', '地铁安检通用问答包', 'subway', 1
WHERE NOT EXISTS (SELECT 1 FROM kb_template WHERE code='faq-subway-v1');

INSERT INTO flow_template (code, vertical_code, steps_json, version)
SELECT 'flow-subway-v1', 'subway',
'[{"stage":"ask_city","ask":"你打算去哪个城市？广州、佛山、深圳、南宁、南昌都在招。","skip_if":"city_known"},{"stage":"send_info","action":"render_position_card"},{"stage":"ask_interview","ask":"这两天能不能过来面试？能来的话我把名额给你留着。"},{"stage":"collect","ask":"名字、电话、身高发我一下，我给你报上去。"},{"stage":"done","action":"send_interview_notice"}]',
1
WHERE NOT EXISTS (SELECT 1 FROM flow_template WHERE code='flow-subway-v1');

-- ── 地铁安检通用问答 ─────────────────────────────────────────────
INSERT INTO kb_template_item (template_id, question, keywords, answer, priority, sort_order)
SELECT t.id, v.question, v.keywords, v.answer, v.priority, v.sort_order
FROM kb_template t
CROSS JOIN (
  SELECT '工资多少' AS question,
         '["工资","薪资","多少钱","一个班","待遇","挣多少","收入"]' AS keywords,
         '这边待遇是{wage|按城市和班次定，面试时我当面跟你核对}' AS answer,
         10 AS priority, 1 AS sort_order
  UNION ALL SELECT '上班时间',
         '["上班时间","几点上","几个班","班次","早班","晚班","通班"]',
         '{shift|分早班晚班，想多挣钱也能打通班，面试时跟你说具体时间}',
         10, 2
  UNION ALL SELECT '月休几天',
         '["月休","休息","几天休","休几天","上几休几"]',
         '{rest|月休按站点排班走，面试时跟你说清楚}',
         9, 3
  UNION ALL SELECT '年龄要求',
         '["年龄","多大","几岁","超龄","岁能"]',
         '{age|年龄要求以站点为准，你说下多大我帮你看看能不能报}',
         10, 4
  UNION ALL SELECT '身高要求',
         '["身高","多高","一米六","一米七","个子"]',
         '{height|安检岗有身高要求，你报一下身高我帮你对一下}',
         10, 5
  UNION ALL SELECT '安排在哪个站',
         '["哪个站","线路","几号线","安排","站点","分到哪"]',
         '{line|按你就近的站点安排，具体哪条线面试时确定}',
         9, 6
  UNION ALL SELECT '什么民族不招',
         '["民族","彝族","藏族","回族","维吾尔","新疆"]',
         '{ethnicity|民族限制各城市不一样，你说下情况我帮你确认}',
         8, 7
  UNION ALL SELECT '有纹身能进吗',
         '["纹身","花臂","刺青","伤疤","色弱","案底"]',
         '{tattoo_policy}',
         9, 8
  UNION ALL SELECT '什么时候面试',
         '["几点面试","面试时间","什么时候面试","上午","下午"]',
         '面试时间是{interview_time}，过来直接找我。',
         10, 9
  UNION ALL SELECT '在哪里面试',
         '["地址","位置","在哪","怎么走","哪里面试","地铁站"]',
         '面试地点在{address}。',
         10, 10
  UNION ALL SELECT '面试要带什么',
         '["带什么","准备什么","身份证","照片","带啥"]',
         '{cert}',
         9, 11
  UNION ALL SELECT '上班干什么',
         '["干什么","做什么","工作内容","累不累","活重不重","站着还是坐着"]',
         '就是地铁站里的安检岗，检查行李、维持秩序，站着为主，每个班有轮休。',
         7, 12
  UNION ALL SELECT '要培训吗',
         '["培训","上岗证","考证","多久能上岗"]',
         '{training|上岗前有统一培训，通过安检证考试就能排班}',
         7, 13
  UNION ALL SELECT '要不要体检',
         '["体检","健康证","体检费"]',
         '{medical|需要体检，主要是查传染病，体检费以站点通知为准}',
         7, 14
  UNION ALL SELECT '包吃住吗',
         '["包吃","包住","住宿","吃住","宿舍"]',
         '{welfare|住宿和餐食按各站点政策，面试时我当面跟你说清楚}',
         8, 15
  UNION ALL SELECT '买社保吗',
         '["社保","五险","保险","补贴"]',
         '{insurance|社保按当地规定缴，具体补贴面试时跟你核对}',
         7, 16
  UNION ALL SELECT '多久转正',
         '["转正","正式工","试用期","多久转"]',
         '{regular|试用期满考核通过就转正，面试时会跟你说清考核标准}',
         8, 17
  UNION ALL SELECT '是中介吗',
         '["中介","派遣","收费","介绍费","要交钱"]',
         '我们这边直招，不收取任何费用，工资直接发到你卡上。',
         7, 18
) AS v
WHERE t.code = 'faq-subway-v1'
  AND NOT EXISTS (
    SELECT 1 FROM kb_template_item i
    WHERE i.template_id = t.id AND i.question = v.question
  );

-- ── 导入到租户实例（kb_faq）────────────────────────────────────────
INSERT INTO kb_faq (tenant_id, vertical_id, scope_level, question, keywords, answer, priority, template_item_id)
SELECT 1, vv.id, 'global', i.question, i.keywords, i.answer, i.priority, i.id
FROM kb_template_item i
JOIN kb_template t ON t.id = i.template_id AND t.code = 'faq-subway-v1'
JOIN vertical vv ON vv.tenant_id = 1 AND vv.code = 'subway'
WHERE NOT EXISTS (
  SELECT 1 FROM kb_faq f
  WHERE f.tenant_id = 1 AND f.vertical_id = vv.id AND f.question = i.question
);

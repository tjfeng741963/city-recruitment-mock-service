-- 022_kb_faq_seed.sql
-- 工厂品类通用问答包（15 组）+ 流程模板。
-- 内容来源：69 张真实生产聊天截图的交集（docs/知识库方案-流程驱动-20261113.md §二）。
--
-- 设计要点：
--   * answer 里不写任何数字，全部用 {占位符}，运行时从 position.data_json 取值
--   * scope_level='global' + vertical_id=factory：只对工厂品类可见，地铁/保姆不会命中
--   * template_item_id 指向模板项，租户改过的条目升级时不覆盖
--
-- 幂等：靠 code/question 唯一 + NOT EXISTS，重复执行不会插重复行。

INSERT INTO kb_template (code, name, vertical_code, version)
SELECT 'faq-factory-v1', '工厂通用问答包', 'factory', 1
WHERE NOT EXISTS (SELECT 1 FROM kb_template WHERE code='faq-factory-v1');

INSERT INTO flow_template (code, vertical_code, steps_json, version)
SELECT 'flow-factory-v1', 'factory',
'[{"stage":"ask_job_type","ask":"你应聘普工还是叉车？","skip_if":"only_one_position"},{"stage":"send_info","action":"render_position_card"},{"stage":"ask_interview","ask":"这两天能不能过来面试？能来的话我把名额给你留着。"},{"stage":"collect","ask":"名字和电话发我一下，我给你先报名。"},{"stage":"done","action":"send_interview_notice"}]',
1
WHERE NOT EXISTS (SELECT 1 FROM flow_template WHERE code='flow-factory-v1');

-- ── 15 组工厂通用问答 ────────────────────────────────────────────
INSERT INTO kb_template_item (template_id, question, keywords, answer, priority, sort_order)
SELECT t.id, v.question, v.keywords, v.answer, v.priority, v.sort_order
FROM kb_template t
CROSS JOIN (
  SELECT '工资多少' AS question,
         '["工资","工价","多少钱","一小时","时薪","几块","待遇"]' AS keywords,
         '这边工价是{wage}' AS answer,
         10 AS priority, 1 AS sort_order
  UNION ALL SELECT '包吃住吗',
         '["包吃","包住","吃住","水电","扣钱","住宿免费","管吃"]',
         '{welfare}',
         10, 2
  UNION ALL SELECT '在哪里',
         '["位置","地址","在哪","怎么走","远不远","发个位置","定位"]',
         '面试地点在{address}，我这边把定位发你。',
         10, 3
  UNION ALL SELECT '什么时候面试',
         '["面试","几点","什么时候","时间","明天","今天"]',
         '面试时间是{interview_time}，过来直接到厂门口联系我。',
         10, 4
  UNION ALL SELECT '要体检吗',
         '["体检","体检费","健康证","体检钱"]',
         '{medical}',
         8, 5
  UNION ALL SELECT '有纹身能进吗',
         '["纹身","花臂","刺青","纹身能进"]',
         '{tattoo_policy}',
         8, 6
  UNION ALL SELECT '白班还是两班倒',
         '["白班","夜班","两班倒","班次","长白班","倒班"]',
         '{shift}',
         8, 7
  UNION ALL SELECT '宿舍几人间',
         '["宿舍","几人","空调","住宿","几人间","住的地方"]',
         '{dorm}',
         8, 8
  UNION ALL SELECT '买社保吗',
         '["社保","五险","五险一金","保险"]',
         '{insurance}',
         6, 9
  UNION ALL SELECT '多久转正',
         '["转正","正式工","多久转","干多久"]',
         '{regular}',
         8, 10
  UNION ALL SELECT '干什么活',
         '["累不累","干什么","工作内容","难不难","做什么","活重不重"]',
         '{work}',
         8, 11
  UNION ALL SELECT '能借支吗',
         '["借支","预支","借钱","预支工资","先借"]',
         '{advance}',
         6, 12
  UNION ALL SELECT '面试要带什么',
         '["带什么","准备什么","身份证","带啥"]',
         '带身份证原件就行，别穿拖鞋短裤，到了联系我。',
         6, 13
  UNION ALL SELECT '是中介吗',
         '["中介","派遣","收费","介绍费","要交钱"]',
         '我们这边直招，不收取任何费用，工资直接发到你卡上。',
         6, 14
  UNION ALL SELECT '太远了过来不方便',
         '["太远","远吗","距离","过去不方便","住哪"]',
         '{relocate_policy}',
         4, 15
) AS v
WHERE t.code = 'faq-factory-v1'
  AND NOT EXISTS (
    SELECT 1 FROM kb_template_item i
    WHERE i.template_id = t.id AND i.question = v.question
  );

-- ── 导入到租户实例（kb_faq）────────────────────────────────────────
INSERT INTO kb_faq (tenant_id, vertical_id, scope_level, question, keywords, answer, priority, template_item_id)
SELECT 1, vv.id, 'global', i.question, i.keywords, i.answer, i.priority, i.id
FROM kb_template_item i
JOIN kb_template t ON t.id = i.template_id AND t.code = 'faq-factory-v1'
JOIN vertical vv ON vv.tenant_id = 1 AND vv.code = 'factory'
WHERE NOT EXISTS (
  SELECT 1 FROM kb_faq f
  WHERE f.tenant_id = 1 AND f.vertical_id = vv.id AND f.question = i.question
);

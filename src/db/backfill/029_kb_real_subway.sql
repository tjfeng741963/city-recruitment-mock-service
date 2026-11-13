-- 029_kb_real_subway.sql
-- 客户真实地铁安检岗位导入（5 个城市 / 6 个面试点）。
--
-- 数据来源：《11.9全国安检输送集合信息+薪资表.xlsx》的真实字段（城市 / 薪资待遇 /
-- 上班时间及月休 / 基本要求 / 安排线路 / 面试时间 / 联系人 / 面试地址 / 携带资料）。
--
-- 为什么在 src/db/backfill/ 而不是 migrations/：要写 cities / factories /
-- service_positions，迁移在种子之前跑，那时表是空的。由 backfillLegacyKb 在种子后执行。
--
-- 与工厂的差别：
--   * 地铁的「厂」其实是运营公司/面试点，一个城市可能有两个面试点（佛山万通、百花）
--   * 每家的年龄、身高、民族限制、线路都不同，按 employer 存固定答案，不放占位符
--   * 面试时间是固定的「周几 + 时段」，不是某一天
--
-- 幂等：全部 NOT EXISTS。

-- ── 1. 位置：三个省 + 三个市 ────────────────────────────────────
INSERT INTO location (parent_id, level, name, code, status)
SELECT NULL, 'province', v.name, '', 'enabled'
FROM (SELECT '江西' AS name UNION ALL SELECT '广西') AS v
WHERE NOT EXISTS (SELECT 1 FROM location l WHERE l.parent_id IS NULL AND l.level='province' AND l.name=v.name);

INSERT INTO location (parent_id, level, name, code, status, address)
SELECT p.id, 'city', v.city, v.code, 'enabled', v.address
FROM (
  SELECT '广东' AS province, '佛山' AS city, 'LEGACY-FS' AS code, '广东省佛山市' AS address
  UNION ALL SELECT '江西', '南昌', 'LEGACY-NC', '江西省南昌市'
  UNION ALL SELECT '广西', '南宁', 'LEGACY-NN', '广西壮族自治区南宁市'
) AS v
JOIN location p ON p.parent_id IS NULL AND p.level='province' AND p.name = v.province
WHERE NOT EXISTS (SELECT 1 FROM location l WHERE l.parent_id=p.id AND l.level='city' AND l.name=v.city);

-- 面试点：每家一个点，地址用客户资料原文——「发地址」直接发这个
INSERT INTO location (parent_id, level, name, code, status, address, walk_guide)
SELECT c.id, 'point', v.name, v.code, 'enabled', v.address, v.walk_guide
FROM (
  SELECT '广州' AS city, '冠宇商务中心' AS name, 'GZ-GYSW' AS code,
         '广州市冠宇商务中心 2 楼 224' AS address,
         '乘坐地铁 4、5 号线 车陂南站 C 出口直行 80 米，导航即到' AS walk_guide
  UNION ALL SELECT '佛山', '百花广场', 'FS-BHGC',
         '佛山市百花广场写字楼 22 楼 2220 室', '乘坐广佛线 祖庙站 A 出口即到'
  UNION ALL SELECT '佛山', '万通国际', 'FS-WTGJ',
         '佛山市石湾镇街道汾江南路 51 号万通国际 2331 房', ''
  UNION ALL SELECT '南昌', '财富大厦', 'NC-CFDS',
         '南昌市财富大厦 B 座 9 楼 901 室', '乘坐地铁 1、4 号线 八一广场站 7 号口出来，导航 100 米即到'
  UNION ALL SELECT '深圳', '固戍站面试点', 'SZ-GSZ',
         '深圳市宝安区固戍地铁站附近', '乘坐地铁 1 号线 固戍站 F 出口，导航 100 米即到'
  UNION ALL SELECT '南宁', '钻石广场', 'NN-ZSGC',
         '南宁市钻石广场', '乘坐地铁 1/2 号线 朝阳广场 D 出口出来，导航至钻石广场'
) AS v
JOIN location c ON c.level='city' AND c.name = v.city
WHERE NOT EXISTS (SELECT 1 FROM location l WHERE l.parent_id=c.id AND l.level='point' AND l.name=v.name);

-- ── 2. 旧表：城市（8090 的 /agent/jobs 按 city_name 查）─────────────
INSERT INTO cities (city_name, province, recruitment_status, data_json)
SELECT v.city, v.province, 'enabled', '{}'
FROM (
  SELECT '佛山' AS city, '广东' AS province
  UNION ALL SELECT '南昌', '江西'
  UNION ALL SELECT '南宁', '广西'
) AS v
WHERE NOT EXISTS (SELECT 1 FROM cities c WHERE c.city_name = v.city);

-- ── 3. 旧表：安检项目（沿用 factories 表，一条 = 一个城市的招工主体）──
INSERT INTO factories (factory_name, city_id, status, data_json)
SELECT v.name, (SELECT id FROM cities WHERE city_name = v.city LIMIT 1), 'enabled', v.data_json
FROM (
  SELECT '广州地铁安检' AS name, '广州' AS city,
         '{"place":"广州市冠宇商务中心 2 楼 224","interview_time":"周一至周六 上午11:00-11:30、下午14:00-14:30","contact":"聂队长 13660204005"}' AS data_json
  UNION ALL SELECT '佛山万通地铁安检', '佛山',
         '{"place":"佛山市石湾镇街道汾江南路 51 号万通国际 2331 房","interview_time":"周日至周五 上午11:00-11:30、下午14:00-14:30","contact":"聂队长 19878700086"}'
  UNION ALL SELECT '佛山百花地铁安检', '佛山',
         '{"place":"佛山市百花广场写字楼 22 楼 2220 室","interview_time":"周一至周六 上午11:00-11:30、下午14:00-14:30","contact":"杨队长 13757925510"}'
  UNION ALL SELECT '南昌地铁安检', '南昌',
         '{"place":"南昌市财富大厦 B 座 9 楼 901 室","interview_time":"周一至周六 上午10:00-12:00、下午14:00-17:00","contact":"张队长 15070621694"}'
  UNION ALL SELECT '深圳地铁安检', '深圳',
         '{"place":"深圳市宝安区固戍地铁站附近","interview_time":"周一至周六 上午11:00-12:00、下午14:00-17:00","contact":"张队长 15813839313"}'
  UNION ALL SELECT '南宁地铁安检', '南宁',
         '{"place":"南宁市钻石广场","interview_time":"周一 下午14:30；周二三六 上午10:30、下午14:30；周四五 上午10:30；周日休息","contact":"唐队长 15278212553"}'
) AS v
WHERE NOT EXISTS (SELECT 1 FROM factories f WHERE f.factory_name = v.name);

-- ── 4. 旧表：每个城市的安检岗位 ────────────────────────────────
INSERT INTO service_positions (position_name, factory_id, city_id, status, data_json)
SELECT '安检员', f.id, f.city_id, 'enabled', v.data_json
FROM (
  SELECT '广州地铁安检' AS factory_name,
         '{"wage_text":"试用期 120 元/班、连班 240 元/天；转正后前 174 小时底薪 2680 元，超出按 23.1 元/小时算加班；买社保补贴 400，不买补贴 800","wage_unit":"元/班","hours_text":"早班 6:30-14:30，晚班 14:30-22:30，通班 6:30-22:30（自愿），轮班制","rest_text":"上 2 休 1","age_text":"18-35 岁","height_text":"男 165cm 以上，女 155cm 以上","line_text":"11、13、21 号线，海珠有轨电车","ethnicity_policy":"广州本地户籍不招；彝族、藏族、回族、新疆维吾尔族不招"}' AS data_json
  UNION ALL SELECT '佛山万通地铁安检',
         '{"wage_text":"试用期 110 元/班、连班 220 元/天；转正 150 元/班、连班 300 元/天","wage_unit":"元/班","hours_text":"早班 7:00-15:00，晚班 15:00-22:30，通班 7:00-22:30（自愿），轮班制","rest_text":"上 3 休 1","age_text":"18-35 岁","height_text":"男 165cm 以上，女 155cm 以上","line_text":"2、3、7 号线，南新线，广佛线","ethnicity_policy":"彝族、回族、新疆维吾尔族、藏族不招"}'
  UNION ALL SELECT '佛山百花地铁安检',
         '{"wage_text":"试用期 110 元/班、连班 220 元/天；转正 150 元/班、连班 300 元/天","wage_unit":"元/班","hours_text":"早班 7:00-15:00，晚班 15:00-22:30，通班 7:00-22:30（自愿），轮班制","rest_text":"上 3 休 1","age_text":"18-35 岁","height_text":"男 165cm 以上，女 155cm 以上","line_text":"2、3、7 号线，南新线，广佛线","ethnicity_policy":"彝族、回族、新疆维吾尔族、藏族不招"}'
  UNION ALL SELECT '南昌地铁安检',
         '{"wage_text":"试用期 80 元/班、连班 160 元/天；转正 125 元/班、连班 250 元/天","wage_unit":"元/班","hours_text":"轮班制，具体班次面试时确认","rest_text":"月休按排班","age_text":"16-30 岁","height_text":"男 165cm，女 155cm","line_text":"1 号线","ethnicity_policy":"彝族、藏族、回族、新疆维吾尔族不招"}'
  UNION ALL SELECT '深圳地铁安检',
         '{"wage_text":"150 元/班，通班可达 300 元/天","wage_unit":"元/班","hours_text":"早班 6:00-15:00，晚班 15:00-23:30，通班 6:00-23:30（自愿），轮班制","rest_text":"月休 4-6 天","age_text":"18-35 岁","height_text":"男 165cm 以上，女 155cm 以上","line_text":"按站点就近安排","ethnicity_policy":"深圳本地户籍已满不招；新疆维吾尔族、藏族、回族、彝族目前暂时不招"}'
  UNION ALL SELECT '南宁地铁安检',
         '{"wage_text":"实习 80 元/班、连班 160 元/天；转正 110 元/班、连班 220 元/天","wage_unit":"元/班","hours_text":"早班 6:30-14:30，晚班 14:30-22:30，通班 6:30-22:30（自愿），轮班制","rest_text":"月休 6 天左右","age_text":"18-28 岁","height_text":"男 165cm，女 155cm","line_text":"3、4、5 号线","ethnicity_policy":"彝族、藏族、回族、新疆维吾尔族不招"}'
) AS v
JOIN factories f ON f.factory_name = v.factory_name
WHERE NOT EXISTS (
  SELECT 1 FROM service_positions sp WHERE sp.factory_id = f.id AND sp.position_name = '安检员'
);

-- ── 5. v3 招工方：一个面试点一行 ────────────────────────────────
INSERT INTO employer (tenant_id, vertical_id, employer_code, display_name, short_name, location_id, status, data_json)
SELECT 1, (SELECT id FROM vertical WHERE tenant_id=1 AND code='subway'),
       v.code, v.name, v.short_name,
       (SELECT l.id FROM location l WHERE l.level='point' AND l.name=v.point LIMIT 1),
       'enabled', '{}'
FROM (
  SELECT 'SUB-GZ-001' AS code, '广州地铁安检' AS name, '广州安检' AS short_name, '冠宇商务中心' AS point
  UNION ALL SELECT 'SUB-FS-001', '佛山万通地铁安检', '佛山万通', '万通国际'
  UNION ALL SELECT 'SUB-FS-002', '佛山百花地铁安检', '佛山百花', '百花广场'
  UNION ALL SELECT 'SUB-NC-001', '南昌地铁安检', '南昌安检', '财富大厦'
  UNION ALL SELECT 'SUB-SZ-001', '深圳地铁安检', '深圳安检', '固戍站面试点'
  UNION ALL SELECT 'SUB-NN-001', '南宁地铁安检', '南宁安检', '钻石广场'
) AS v
WHERE NOT EXISTS (SELECT 1 FROM employer e WHERE e.tenant_id=1 AND e.employer_code = v.code);

-- ── 6. 别名：客户口语 ──────────────────────────────────────────
INSERT INTO employer_alias (employer_id, alias, weight)
SELECT e.id, v.alias, v.weight
FROM employer e
JOIN (
  SELECT 'SUB-GZ-001' AS code, '广州地铁' AS alias, 8 AS weight
  UNION ALL SELECT 'SUB-GZ-001', '广州安检', 8
  UNION ALL SELECT 'SUB-FS-001', '佛山地铁', 8
  UNION ALL SELECT 'SUB-FS-001', '万通', 7
  UNION ALL SELECT 'SUB-FS-002', '百花', 7
  UNION ALL SELECT 'SUB-NC-001', '南昌地铁', 8
  UNION ALL SELECT 'SUB-SZ-001', '深圳地铁', 8
  UNION ALL SELECT 'SUB-NN-001', '南宁地铁', 8
) AS v ON v.code = e.employer_code
WHERE e.tenant_id = 1
  AND NOT EXISTS (SELECT 1 FROM employer_alias a WHERE a.employer_id=e.id AND a.alias=v.alias);

-- ── 7. 岗位挂面试点 ───────────────────────────────────────────
INSERT INTO position_location (position_id, location_id)
SELECT sp.id, e.location_id
FROM service_positions sp
JOIN factories f ON f.id = sp.factory_id
JOIN employer e ON e.tenant_id=1 AND e.display_name = f.factory_name
WHERE e.location_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM position_location pl WHERE pl.position_id=sp.id AND pl.location_id=e.location_id);

-- ── 8. 面试点级问答：每个面试点一套（含地址/时段/联系人）───────────
INSERT INTO kb_faq (tenant_id, vertical_id, scope_level, scope_employer_id, question, keywords, answer, priority, status)
SELECT 1, (SELECT id FROM vertical WHERE tenant_id=1 AND code='subway'),
       'employer', e.id, v.question, v.keywords, v.answer, v.priority, 'enabled'
FROM (
  -- 广州
  SELECT 'SUB-GZ-001' AS code, '工资多少' AS question, '["工资","薪资","多少钱","一个班","待遇","收入"]' AS keywords,
         '试用期 120 元/班，连班 240 元/天；转正后前 174 小时底薪 2680 元，超出按 23.1 元/小时算加班。买社保额外补贴 400，不买补贴 800。' AS answer, 12 AS priority
  UNION ALL SELECT 'SUB-GZ-001', '上班时间', '["上班时间","几点上","班次","早班","晚班","通班"]',
         '早班 6:30-14:30，晚班 14:30-22:30，通班 6:30-22:30（自愿，想多挣钱可以申请），轮班制，上 2 休 1。', 10
  UNION ALL SELECT 'SUB-GZ-001', '年龄身高要求', '["年龄","多大","几岁","身高","多高"]',
         '安检年龄 18-35 岁，男身高 165cm、女身高 155cm。', 10
  UNION ALL SELECT 'SUB-GZ-001', '什么民族不招', '["民族","彝族","藏族","回族","维吾尔","新疆","户籍"]',
         '广州本地户籍不招；彝族、藏族、回族、新疆维吾尔族不招。', 9
  UNION ALL SELECT 'SUB-GZ-001', '有纹身能进吗', '["纹身","花臂","刺青","伤疤","色弱","案底"]',
         '不能有纹身、案底、色弱、大面积伤疤，身体健康无传染病和突发性疾病。', 9
  UNION ALL SELECT 'SUB-GZ-001', '安排在哪个站', '["哪个站","线路","几号线","安排","站点"]',
         '安排在 11、13、21 号线，以及海珠有轨电车。', 9
  UNION ALL SELECT 'SUB-GZ-001', '什么时候面试', '["面试时间","几点面试","什么时候面试","上午","下午","哪天"]',
         '周一至周六面试（周天休息），上午 11:00-11:30，下午 14:00-14:30。', 12
  UNION ALL SELECT 'SUB-GZ-001', '在哪里面试', '["地址","位置","在哪","怎么走","哪里面试"]',
         '面试地址：广州市冠宇商务中心 2 楼 224。乘坐地铁 4、5 号线 车陂南站 C 出口直行 80 米，导航即到。', 12
  UNION ALL SELECT 'SUB-GZ-001', '面试要带什么', '["带什么","准备什么","身份证","带啥"]',
         '面试携带身份证原件。', 10
  UNION ALL SELECT 'SUB-GZ-001', '找谁', '["找谁","联系谁","电话","队长"]',
         '到了联系聂队长 13660204005。', 8
  -- 佛山万通
  UNION ALL SELECT 'SUB-FS-001', '工资多少', '["工资","薪资","多少钱","一个班","待遇","收入"]',
         '试用期 110 元/班，连班 220 元/天；转正后 150 元/班，连班 300 元/天。', 12
  UNION ALL SELECT 'SUB-FS-001', '上班时间', '["上班时间","几点上","班次","早班","晚班","通班"]',
         '早班 7:00-15:00，晚班 15:00-22:30，通班 7:00-22:30（自愿，想多挣钱可以申请），轮班制，上 3 休 1。', 10
  UNION ALL SELECT 'SUB-FS-001', '年龄身高要求', '["年龄","多大","几岁","身高","多高"]',
         '年龄 18-35 岁，男身高 165cm 以上、女身高 155cm 以上。', 10
  UNION ALL SELECT 'SUB-FS-001', '什么民族不招', '["民族","彝族","藏族","回族","维吾尔","新疆","户籍"]',
         '彝族、回族、新疆维吾尔族、藏族不招。', 9
  UNION ALL SELECT 'SUB-FS-001', '有纹身能进吗', '["纹身","花臂","刺青","伤疤","色弱","案底"]',
         '不能有纹身、案底、色弱、大面积伤疤，身体健康无传染病和突发性疾病。', 9
  UNION ALL SELECT 'SUB-FS-001', '安排在哪个站', '["哪个站","线路","几号线","安排","站点"]',
         '安排在 2、3、7 号线，南新线，广佛线。', 9
  UNION ALL SELECT 'SUB-FS-001', '什么时候面试', '["面试时间","几点面试","什么时候面试","上午","下午","哪天"]',
         '万通面试：周日至周五（周六休息），上午 11:00-11:30，下午 14:00-14:30。', 12
  UNION ALL SELECT 'SUB-FS-001', '在哪里面试', '["地址","位置","在哪","怎么走","哪里面试"]',
         '面试地址：佛山市石湾镇街道汾江南路 51 号万通国际 2331 房。', 12
  UNION ALL SELECT 'SUB-FS-001', '找谁', '["找谁","联系谁","电话","队长"]',
         '到了联系聂队长 19878700086。', 8
  -- 佛山百花
  UNION ALL SELECT 'SUB-FS-002', '工资多少', '["工资","薪资","多少钱","一个班","待遇","收入"]',
         '试用期 110 元/班，连班 220 元/天；转正后 150 元/班，连班 300 元/天。', 12
  UNION ALL SELECT 'SUB-FS-002', '上班时间', '["上班时间","几点上","班次","早班","晚班","通班"]',
         '早班 7:00-15:00，晚班 15:00-22:30，通班 7:00-22:30（自愿），轮班制，上 3 休 1。', 10
  UNION ALL SELECT 'SUB-FS-002', '年龄身高要求', '["年龄","多大","几岁","身高","多高"]',
         '年龄 18-35 岁，男身高 165cm 以上、女身高 155cm 以上。', 10
  UNION ALL SELECT 'SUB-FS-002', '什么民族不招', '["民族","彝族","藏族","回族","维吾尔","新疆","户籍"]',
         '彝族、回族、新疆维吾尔族、藏族不招。', 9
  UNION ALL SELECT 'SUB-FS-002', '有纹身能进吗', '["纹身","花臂","刺青","伤疤","色弱","案底"]',
         '不能有纹身、案底、色弱、大面积伤疤。', 9
  UNION ALL SELECT 'SUB-FS-002', '安排在哪个站', '["哪个站","线路","几号线","安排","站点"]',
         '安排在 2、3、7 号线，南新线，广佛线。', 9
  UNION ALL SELECT 'SUB-FS-002', '什么时候面试', '["面试时间","几点面试","什么时候面试","上午","下午","哪天"]',
         '百花面试：周一至周六（周日休息），上午 11:00-11:30，下午 14:00-14:30。', 12
  UNION ALL SELECT 'SUB-FS-002', '在哪里面试', '["地址","位置","在哪","怎么走","哪里面试"]',
         '面试地址：佛山市百花广场写字楼 22 楼 2220 室。乘坐广佛线 祖庙站 A 出口即到。', 12
  UNION ALL SELECT 'SUB-FS-002', '找谁', '["找谁","联系谁","电话","队长"]',
         '到了联系杨队长 13757925510。', 8
  -- 南昌
  UNION ALL SELECT 'SUB-NC-001', '工资多少', '["工资","薪资","多少钱","一个班","待遇","收入"]',
         '试用期 80 元/班，连班 160 元/天；转正后 125 元/班，连班 250 元/天。', 12
  UNION ALL SELECT 'SUB-NC-001', '上班时间', '["上班时间","几点上","班次","早班","晚班","通班"]',
         '轮班制，具体班次面试时跟你确认。', 10
  UNION ALL SELECT 'SUB-NC-001', '年龄身高要求', '["年龄","多大","几岁","身高","多高"]',
         '年龄 16-30 岁，男身高 165cm、女身高 155cm。', 10
  UNION ALL SELECT 'SUB-NC-001', '什么民族不招', '["民族","彝族","藏族","回族","维吾尔","新疆","户籍"]',
         '彝族、藏族、回族、新疆维吾尔族不招。', 9
  UNION ALL SELECT 'SUB-NC-001', '有纹身能进吗', '["纹身","花臂","刺青","伤疤","色弱","案底"]',
         '不能有纹身、案底、色弱、大面积伤疤。', 9
  UNION ALL SELECT 'SUB-NC-001', '安排在哪个站', '["哪个站","线路","几号线","安排","站点"]',
         '安排在 1 号线。', 9
  UNION ALL SELECT 'SUB-NC-001', '什么时候面试', '["面试时间","几点面试","什么时候面试","上午","下午","哪天"]',
         '面试：周一至周六（周日休息），上午 10:00-12:00，下午 14:00-17:00。', 12
  UNION ALL SELECT 'SUB-NC-001', '在哪里面试', '["地址","位置","在哪","怎么走","哪里面试"]',
         '面试地址：南昌市财富大厦 B 座 9 楼 901 室。乘坐地铁 1、4 号线 八一广场站 7 号口出来，导航 100 米即到。', 12
  UNION ALL SELECT 'SUB-NC-001', '找谁', '["找谁","联系谁","电话","队长"]',
         '到了联系张队长 15070621694。', 8
  -- 深圳
  UNION ALL SELECT 'SUB-SZ-001', '工资多少', '["工资","薪资","多少钱","一个班","待遇","收入"]',
         '150 元/班，通班可达 300 元/天。', 12
  UNION ALL SELECT 'SUB-SZ-001', '上班时间', '["上班时间","几点上","班次","早班","晚班","通班"]',
         '早班 6:00-15:00，晚班 15:00-23:30，通班 6:00-23:30（自愿），轮班制，月休 4-6 天。', 10
  UNION ALL SELECT 'SUB-SZ-001', '年龄身高要求', '["年龄","多大","几岁","身高","多高"]',
         '年龄 18-35 岁，男身高 165cm 以上、女身高 155cm 以上。', 10
  UNION ALL SELECT 'SUB-SZ-001', '什么民族不招', '["民族","彝族","藏族","回族","维吾尔","新疆","户籍"]',
         '深圳本地户籍已满不招；新疆维吾尔族、藏族、回族、彝族目前暂时不招。', 9
  UNION ALL SELECT 'SUB-SZ-001', '有纹身能进吗', '["纹身","花臂","刺青","伤疤","色弱","案底"]',
         '不能有纹身、案底、色弱、大面积伤疤。', 9
  UNION ALL SELECT 'SUB-SZ-001', '安排在哪个站', '["哪个站","线路","几号线","安排","站点"]',
         '按你就近的站点安排，具体哪条线面试时确定。', 9
  UNION ALL SELECT 'SUB-SZ-001', '什么时候面试', '["面试时间","几点面试","什么时候面试","上午","下午","哪天"]',
         '面试：周一至周六（周日休息），上午 11:00-12:00，下午 14:00-17:00。', 12
  UNION ALL SELECT 'SUB-SZ-001', '在哪里面试', '["地址","位置","在哪","怎么走","哪里面试"]',
         '面试地址：深圳市宝安区固戍地铁站附近。乘坐地铁 1 号线 固戍站 F 出口，导航 100 米即到。', 12
  UNION ALL SELECT 'SUB-SZ-001', '找谁', '["找谁","联系谁","电话","队长"]',
         '到了联系张队长 15813839313。', 8
  -- 南宁
  UNION ALL SELECT 'SUB-NN-001', '工资多少', '["工资","薪资","多少钱","一个班","待遇","收入"]',
         '实习 80 元/班、连班 160 元/天；转正后 110 元/班、连班 220 元/天。', 12
  UNION ALL SELECT 'SUB-NN-001', '上班时间', '["上班时间","几点上","班次","早班","晚班","通班"]',
         '早班 6:30-14:30，晚班 14:30-22:30，通班 6:30-22:30（自愿），轮班制，月休 6 天左右。', 10
  UNION ALL SELECT 'SUB-NN-001', '年龄身高要求', '["年龄","多大","几岁","身高","多高"]',
         '年龄 18-28 岁，男身高 165cm、女身高 155cm。', 10
  UNION ALL SELECT 'SUB-NN-001', '什么民族不招', '["民族","彝族","藏族","回族","维吾尔","新疆","户籍"]',
         '彝族、藏族、回族、新疆维吾尔族不招。', 9
  UNION ALL SELECT 'SUB-NN-001', '有纹身能进吗', '["纹身","花臂","刺青","伤疤","色弱","案底"]',
         '不能有纹身、案底、色弱、大面积伤疤。', 9
  UNION ALL SELECT 'SUB-NN-001', '安排在哪个站', '["哪个站","线路","几号线","安排","站点"]',
         '安排在 3、4、5 号线。', 9
  UNION ALL SELECT 'SUB-NN-001', '什么时候面试', '["面试时间","几点面试","什么时候面试","上午","下午","哪天"]',
         '周一只有下午 14:30 一场；周二、周三、周六上午 10:30 和下午 14:30 两场；周四、周五只有上午 10:30 一场；周日休息。', 12
  UNION ALL SELECT 'SUB-NN-001', '在哪里面试', '["地址","位置","在哪","怎么走","哪里面试"]',
         '面试地址：南宁市钻石广场。乘坐地铁 1/2 号线 朝阳广场 D 出口出来，导航至钻石广场。', 12
  UNION ALL SELECT 'SUB-NN-001', '找谁', '["找谁","联系谁","电话","队长"]',
         '到了联系唐队长 15278212553。', 8
) AS v
JOIN employer e ON e.tenant_id=1 AND e.employer_code = v.code
WHERE NOT EXISTS (
  SELECT 1 FROM kb_faq f
  WHERE f.tenant_id=1 AND f.scope_level='employer' AND f.scope_employer_id=e.id AND f.question=v.question
);

-- ── 9. 岗位级问答：设备绑了岗位时优先命中（同城两个面试点也不串）──────
INSERT INTO kb_faq (tenant_id, vertical_id, scope_level, scope_position_id, question, keywords, answer, priority, status)
SELECT 1, (SELECT id FROM vertical WHERE tenant_id=1 AND code='subway'),
       'position', sp.id, k.question, k.keywords, k.answer, k.priority, 'enabled'
FROM service_positions sp
JOIN factories f ON f.id = sp.factory_id
JOIN employer e ON e.tenant_id=1 AND e.display_name = f.factory_name
JOIN kb_faq k ON k.tenant_id=1 AND k.scope_level='employer' AND k.scope_employer_id=e.id
WHERE sp.position_name = '安检员'
  AND NOT EXISTS (
    SELECT 1 FROM kb_faq p
    WHERE p.tenant_id=1 AND p.scope_level='position' AND p.scope_position_id=sp.id AND p.question=k.question
  );

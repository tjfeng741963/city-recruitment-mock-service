-- 028_kb_real_factories.sql
-- 客户真实工厂岗位导入（番禺 6 家厂 / 11 个岗位）。
--
-- 为什么不是普通迁移：本文件要往 cities / factories / service_positions 写数据，
-- 而迁移在 seedDatabase() 之前跑，那时这三张表还是空的。所以它和 024 一样，
-- 由 src/db/backfill.ts 在种子之后执行。
--
-- 数据来源：客户资料《岗位清单模板（工厂）.xlsx》+《工厂话术.docx》。
-- 关键事实（吃住、体检、纹身、班次、宿舍）每家都不一样，按 employer 作用域存成
-- 固定答案——**这些答案里不放占位符**，避免岗位数据串厂时答错别家的政策。
-- 工价按 position 作用域一条一个，因为同厂不同工种差很多（华荻普工 24-26、焊工 35-40）。
--
-- 幂等：全部 NOT EXISTS。

-- ── 1. 位置：广东 → 广州（复用 024 的编码，避免重复行）───────────────
INSERT INTO location (parent_id, level, name, code, status)
SELECT NULL, 'province', '广东', '', 'enabled'
WHERE NOT EXISTS (SELECT 1 FROM location WHERE parent_id IS NULL AND level='province' AND name='广东');

INSERT INTO location (parent_id, level, name, code, status, address)
SELECT p.id, 'city', '广州', 'LEGACY-C1', 'enabled', '广东省广州市'
FROM location p
WHERE p.parent_id IS NULL AND p.level='province' AND p.name='广东'
  AND NOT EXISTS (SELECT 1 FROM location l WHERE l.parent_id=p.id AND l.level='city' AND l.name='广州');

-- ── 2. 旧表：6 家真实工厂（8090 的 /agent/jobs 从这里读）─────────────
INSERT INTO factories (factory_name, city_id, status, data_json)
SELECT v.name, (SELECT id FROM cities WHERE city_name='广州' LIMIT 1), 'enabled', v.data_json
FROM (
  SELECT '松下万宝美健生活电器(广州)有限公司' AS name,
         '{"place":"番禺区钟村","interview_time":"每天9:00-9:30"}' AS data_json
  UNION ALL SELECT '松下·万宝(广州)电熨斗有限公司',
         '{"place":"番禺区钟村","interview_time":"每天9:00-9:30"}'
  UNION ALL SELECT '广州酒家集团利口福食品有限公司',
         '{"place":"番禺区南村","interview_time":"每天12:00-13:00"}'
  UNION ALL SELECT '广州华荻科技有限公司',
         '{"place":"番禺区石楼","interview_time":"每天12:00-13:00"}'
  UNION ALL SELECT '广州华智汽车部件有限公司',
         '{"place":"番禺区石楼","interview_time":"每天12:00-12:30"}'
  UNION ALL SELECT '广州广汽商贸物流有限公司',
         '{"place":"番禺区化龙","interview_time":"每天12:00-12:30"}'
) AS v
WHERE NOT EXISTS (SELECT 1 FROM factories f WHERE f.factory_name = v.name);

-- ── 3. 旧表：11 个岗位（工价按工种分开）───────────────────────────
INSERT INTO service_positions (position_name, factory_id, city_id, status, data_json)
SELECT v.position_name, f.id, f.city_id, 'enabled', v.data_json
FROM (
  SELECT '松下万宝美健生活电器(广州)有限公司' AS factory_name, '普工' AS position_name,
         '{"wage_text":"19-23 元/小时","wage_unit":"元/小时","age_text":"18-43岁"}' AS data_json
  UNION ALL SELECT '松下·万宝(广州)电熨斗有限公司', '普工',
         '{"wage_text":"18-21 元/小时","wage_unit":"元/小时","age_text":"18-43岁"}'
  UNION ALL SELECT '广州酒家集团利口福食品有限公司', '普工',
         '{"wage_text":"18-21 元/小时","wage_unit":"元/小时","age_text":"18-48岁"}'
  UNION ALL SELECT '广州华荻科技有限公司', '普工',
         '{"wage_text":"24-26 元/小时","wage_unit":"元/小时","age_text":"18-40岁"}'
  UNION ALL SELECT '广州华荻科技有限公司', '焊工',
         '{"wage_text":"35-40 元/小时","wage_unit":"元/小时","age_text":"18-40岁"}'
  UNION ALL SELECT '广州华荻科技有限公司', '叉车工',
         '{"wage_text":"24-26 元/小时","wage_unit":"元/小时","age_text":"18-40岁"}'
  UNION ALL SELECT '广州华智汽车部件有限公司', '普工',
         '{"wage_text":"24-26 元/小时","wage_unit":"元/小时","age_text":"18-45岁"}'
  UNION ALL SELECT '广州华智汽车部件有限公司', '焊工',
         '{"wage_text":"30-33 元/小时","wage_unit":"元/小时","age_text":"18-45岁"}'
  UNION ALL SELECT '广州华智汽车部件有限公司', '叉车工',
         '{"wage_text":"23-25 元/小时","wage_unit":"元/小时","age_text":"18-45岁"}'
  UNION ALL SELECT '广州广汽商贸物流有限公司', '普工',
         '{"wage_text":"24-25 元/小时","wage_unit":"元/小时","age_text":"18-45岁"}'
  UNION ALL SELECT '广州广汽商贸物流有限公司', '叉车工',
         '{"wage_text":"26-27 元/小时","wage_unit":"元/小时","age_text":"18-45岁"}'
) AS v
JOIN factories f ON f.factory_name = v.factory_name
WHERE NOT EXISTS (
  SELECT 1 FROM service_positions sp
  WHERE sp.factory_id = f.id AND sp.position_name = v.position_name
);

-- ── 4. v3 招工方：一家厂一行，编码与客户资料一致 ─────────────────────
INSERT INTO employer (tenant_id, vertical_id, employer_code, display_name, short_name, location_id, status, data_json)
SELECT 1, (SELECT id FROM vertical WHERE tenant_id=1 AND code='factory'),
       v.code, v.name, v.short_name,
       (SELECT id FROM location WHERE level='city' AND name='广州' LIMIT 1),
       'enabled', '{}'
FROM (
  SELECT 'GZ-PY-001' AS code, '松下万宝美健生活电器(广州)有限公司' AS name, '松下美健' AS short_name
  UNION ALL SELECT 'GZ-PY-002', '松下·万宝(广州)电熨斗有限公司', '松下电熨斗'
  UNION ALL SELECT 'GZ-PY-003', '广州酒家集团利口福食品有限公司', '利口福'
  UNION ALL SELECT 'GZ-PY-004', '广州华荻科技有限公司', '华荻'
  UNION ALL SELECT 'GZ-PY-005', '广州华智汽车部件有限公司', '华智'
  UNION ALL SELECT 'GZ-PY-006', '广州广汽商贸物流有限公司', '广汽商贸'
) AS v
WHERE NOT EXISTS (SELECT 1 FROM employer e WHERE e.tenant_id=1 AND e.employer_code = v.code);

-- ── 5. 别名：全名 + 简称（客户口语里两种都会出现）───────────────────
INSERT INTO employer_alias (employer_id, alias, weight)
SELECT e.id, v.alias, v.weight
FROM employer e
JOIN (
  SELECT 'GZ-PY-001' AS code, '松下万宝美健生活电器(广州)有限公司' AS alias, 10 AS weight
  UNION ALL SELECT 'GZ-PY-001', '松下美健', 8
  UNION ALL SELECT 'GZ-PY-001', '松下', 5
  UNION ALL SELECT 'GZ-PY-002', '松下·万宝(广州)电熨斗有限公司', 10
  UNION ALL SELECT 'GZ-PY-002', '松下电熨斗', 8
  UNION ALL SELECT 'GZ-PY-003', '广州酒家集团利口福食品有限公司', 10
  UNION ALL SELECT 'GZ-PY-003', '利口福', 8
  UNION ALL SELECT 'GZ-PY-004', '广州华荻科技有限公司', 10
  UNION ALL SELECT 'GZ-PY-004', '华荻', 8
  UNION ALL SELECT 'GZ-PY-004', '荻原', 6
  UNION ALL SELECT 'GZ-PY-005', '广州华智汽车部件有限公司', 10
  UNION ALL SELECT 'GZ-PY-005', '华智', 8
  UNION ALL SELECT 'GZ-PY-006', '广州广汽商贸物流有限公司', 10
  UNION ALL SELECT 'GZ-PY-006', '广汽商贸', 8
) AS v ON v.code = e.employer_code
WHERE e.tenant_id = 1
  AND NOT EXISTS (SELECT 1 FROM employer_alias a WHERE a.employer_id=e.id AND a.alias=v.alias);

-- ── 6. 岗位位置：挂到广州（区级另行维护）───────────────────────────
INSERT INTO position_location (position_id, location_id)
SELECT sp.id, l.id
FROM service_positions sp
JOIN factories f ON f.id = sp.factory_id
JOIN location l ON l.level='city' AND l.name='广州'
WHERE f.factory_name IN (
  '松下万宝美健生活电器(广州)有限公司','松下·万宝(广州)电熨斗有限公司',
  '广州酒家集团利口福食品有限公司','广州华荻科技有限公司',
  '广州华智汽车部件有限公司','广州广汽商贸物流有限公司')
  AND NOT EXISTS (SELECT 1 FROM position_location pl WHERE pl.position_id=sp.id AND pl.location_id=l.id);

-- ── 7. 厂级问答：每家一套固定答案（不含占位符，避免串厂）────────────
INSERT INTO kb_faq (tenant_id, vertical_id, scope_level, scope_employer_id, question, keywords, answer, priority, status)
SELECT 1, (SELECT id FROM vertical WHERE tenant_id=1 AND code='factory'),
       'employer', e.id, v.question, v.keywords, v.answer, v.priority, 'enabled'
FROM (
  -- GZ-PY-001 松下美健：包吃包住、不体检、不查纹身
  SELECT 'GZ-PY-001' AS code, '包吃住吗' AS question, '["包吃","包住","吃住","宿舍","水电"]' AS keywords,
         '包吃包住，不扣水电，4-6人间公寓宿舍，有独立卫生间、热水器、洗衣机。' AS answer, 10 AS priority
  UNION ALL SELECT 'GZ-PY-001', '要不要体检', '["体检","健康证","体检费"]', '不体检，直接入职。', 9
  UNION ALL SELECT 'GZ-PY-001', '有纹身能进吗', '["纹身","花臂","刺青","案底"]', '松下发不查纹身，花臂也可以。', 9
  UNION ALL SELECT 'GZ-PY-001', '白班还是两班倒', '["白班","夜班","两班倒","班次","倒班"]',
         '早班 8-20、夜班 20-8，班次自由选择，夜班有额外补贴；月休 4 天，上六休一，周六周日可自己选。', 9
  UNION ALL SELECT 'GZ-PY-001', '干什么活', '["干什么","做什么","工作内容","累不累","活重不重"]',
         '做家用小电器的零件组装、包装、开机、质检，都是小件，纯手工活，无需经验。', 8
  -- GZ-PY-002 松下电熨斗
  UNION ALL SELECT 'GZ-PY-002', '包吃住吗', '["包吃","包住","吃住","宿舍","水电"]',
         '包吃包住，不扣水电，宿舍 4-6 人间。', 10
  UNION ALL SELECT 'GZ-PY-002', '要不要体检', '["体检","健康证","体检费"]', '不体检，直接入职。', 9
  UNION ALL SELECT 'GZ-PY-002', '有纹身能进吗', '["纹身","花臂","刺青","案底"]', '松下发不查纹身，花臂也可以。', 9
  UNION ALL SELECT 'GZ-PY-002', '白班还是两班倒', '["白班","夜班","两班倒","班次","倒班"]',
         '长白班和两班倒自由选择，夜班有额外补贴。', 9
  UNION ALL SELECT 'GZ-PY-002', '干什么活', '["干什么","做什么","工作内容","累不累","活重不重"]',
         '做电熨斗零配件组装、包装、质检，小件手工活。', 8
  -- GZ-PY-003 利口福：食品厂，要健康证
  UNION ALL SELECT 'GZ-PY-003', '包吃住吗', '["包吃","包住","吃住","宿舍","水电"]',
         '包吃包住，食品厂宿舍有空调。', 10
  UNION ALL SELECT 'GZ-PY-003', '要不要体检', '["体检","健康证","体检费"]',
         '食品厂要办健康证，体检费先自付，做满一个月公司报销。', 9
  UNION ALL SELECT 'GZ-PY-003', '有纹身能进吗', '["纹身","花臂","刺青","案底"]', '食品厂要求严，纹身要看位置，面试时当面确认。', 9
  UNION ALL SELECT 'GZ-PY-003', '白班还是两班倒', '["白班","夜班","两班倒","班次","倒班"]', '两班倒为主，具体班次面试时定。', 9
  UNION ALL SELECT 'GZ-PY-003', '干什么活', '["干什么","做什么","工作内容","累不累","活重不重"]',
         '速冻食品、腊味的包装和分拣，车间恒温，要穿工服戴帽子。', 8
  -- GZ-PY-004 华荻：要体检、查纹身
  UNION ALL SELECT 'GZ-PY-004', '包吃住吗', '["包吃","包住","吃住","宿舍","水电"]',
         '包吃工作餐，住宿补贴 200 元/月，宿舍 6 人间有空调。', 10
  UNION ALL SELECT 'GZ-PY-004', '要不要体检', '["体检","健康证","体检费"]', '需要体检，体检费自理。', 9
  UNION ALL SELECT 'GZ-PY-004', '有纹身能进吗', '["纹身","花臂","刺青","案底"]', '华荻要查纹身，花臂进不去。', 9
  UNION ALL SELECT 'GZ-PY-004', '白班还是两班倒', '["白班","夜班","两班倒","班次","倒班"]',
         '两班倒，早班 7-19、中班 10-22，月休 4 天，没有通宵班。', 9
  UNION ALL SELECT 'GZ-PY-004', '干什么活', '["干什么","做什么","工作内容","累不累","活重不重"]',
         '汽车配件分拣、打包、贴标签，工衣普通款，每两小时休息 10 分钟。', 8
  -- GZ-PY-005 华智：公司出体检费、小纹身可以
  UNION ALL SELECT 'GZ-PY-005', '包吃住吗', '["包吃","包住","吃住","宿舍","水电"]',
         '包吃包住，宿舍水电平摊，4 人间有空调热水。', 10
  UNION ALL SELECT 'GZ-PY-005', '要不要体检', '["体检","健康证","体检费"]', '统一体检，体检费公司出钱。', 9
  UNION ALL SELECT 'GZ-PY-005', '有纹身能进吗', '["纹身","花臂","刺青","案底"]', '华智查纹身，小图案可以，大面积不行。', 9
  UNION ALL SELECT 'GZ-PY-005', '白班还是两班倒', '["白班","夜班","两班倒","班次","倒班"]', '两班倒，月休 2-4 天。', 9
  UNION ALL SELECT 'GZ-PY-005', '干什么活', '["干什么","做什么","工作内容","累不累","活重不重"]',
         '汽车座椅配件组装，辅助机器人上下料，把物料放进设备按按钮就行。', 8
  -- GZ-PY-006 广汽商贸
  UNION ALL SELECT 'GZ-PY-006', '包吃住吗', '["包吃","包住","吃住","宿舍","水电"]',
         '包吃包住，工作日免费三餐。', 10
  UNION ALL SELECT 'GZ-PY-006', '要不要体检', '["体检","健康证","体检费"]', '入职统一体检，公司安排。', 9
  UNION ALL SELECT 'GZ-PY-006', '有纹身能进吗', '["纹身","花臂","刺青","案底"]', '广汽这边查纹身，明显的不行。', 9
  UNION ALL SELECT 'GZ-PY-006', '白班还是两班倒', '["白班","夜班","两班倒","班次","倒班"]',
         '早班 7-19，两班倒为主。', 9
  UNION ALL SELECT 'GZ-PY-006', '干什么活', '["干什么","做什么","工作内容","累不累","活重不重"]',
         '汽车零部件物流分拣、配送、装卸，有叉车证可以安排叉车岗。', 8
) AS v
JOIN employer e ON e.tenant_id=1 AND e.employer_code = v.code
WHERE NOT EXISTS (
  SELECT 1 FROM kb_faq f
  WHERE f.tenant_id=1 AND f.scope_level='employer' AND f.scope_employer_id=e.id AND f.question=v.question
);

-- ── 8. 岗位级工价：同一家厂不同工种分开答 ──────────────────────────
INSERT INTO kb_faq (tenant_id, vertical_id, scope_level, scope_position_id, question, keywords, answer, priority, status)
SELECT 1, (SELECT id FROM vertical WHERE tenant_id=1 AND code='factory'),
       'position', sp.id, '工资多少', '["工资","工价","多少钱","一小时","时薪","几块","待遇"]', v.answer, 12, 'enabled'
FROM (
  SELECT '松下万宝美健生活电器(广州)有限公司' AS factory_name, '普工' AS position_name, '这边工价是 19-23 元/小时，做满一个月 22、两个月 24，另有工时补贴。' AS answer
  UNION ALL SELECT '松下·万宝(广州)电熨斗有限公司', '普工', '这边工价是 18-21 元/小时。'
  UNION ALL SELECT '广州酒家集团利口福食品有限公司', '普工', '这边工价是 18-21 元/小时。'
  UNION ALL SELECT '广州华荻科技有限公司', '普工', '普工工价 24-26 元/小时。'
  UNION ALL SELECT '广州华荻科技有限公司', '焊工', '焊工工价 35-40 元/小时。'
  UNION ALL SELECT '广州华荻科技有限公司', '叉车工', '叉车工工价 24-26 元/小时，需要叉车证。'
  UNION ALL SELECT '广州华智汽车部件有限公司', '普工', '普工工价 24-26 元/小时。'
  UNION ALL SELECT '广州华智汽车部件有限公司', '焊工', '焊工工价 30-33 元/小时。'
  UNION ALL SELECT '广州华智汽车部件有限公司', '叉车工', '叉车工工价 23-25 元/小时，需要叉车证。'
  UNION ALL SELECT '广州广汽商贸物流有限公司', '普工', '普工工价 24-25 元/小时。'
  UNION ALL SELECT '广州广汽商贸物流有限公司', '叉车工', '叉车工工价 26-27 元/小时，需要叉车证。'
) AS v
JOIN factories f ON f.factory_name = v.factory_name
JOIN service_positions sp ON sp.factory_id = f.id AND sp.position_name = v.position_name
WHERE NOT EXISTS (
  SELECT 1 FROM kb_faq k
  WHERE k.tenant_id=1 AND k.scope_level='position' AND k.scope_position_id=sp.id AND k.question='工资多少'
);

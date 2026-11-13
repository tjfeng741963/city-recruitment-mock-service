-- 030_kb_real_scripts.sql
-- 按客户《地铁安检话术》与《工厂话术》原文编码：
--   异议处理（嫌远/嫌低/嫌累/问社保/问福利/说再考虑）+ 12 城市工资架构 + 真实发送顺序。
--
-- 为什么要单独一份：025 是「通用问答包」（把问题拆成一句话），029 是「5 个城市
-- 的面试点信息」。而这两份 docx 才是运营**实际发给客户的原话**，八成内容属于
-- 「客户嫌远/嫌低/嫌累」时怎么接，不是问答对。之前没编码，
-- 客户一说「太远了我过去不方便」就没有对应说法。
--
-- 数据来源：
--   * 地铁安检话术（灰色部分口述+文字）.docx —— 171 段
--   * 工厂话术（灰色部分口述+文字）.docx     —— 109 段
--
-- 幂等：全部 NOT EXISTS / 限定 WHERE。

-- ══════════════════════════════════════════════════════════════
-- 一、地铁：补全 12 个城市（029 只导了 5 个）
-- ══════════════════════════════════════════════════════════════

-- 1.1 话术文档里有、029 没导的 8 个城市
INSERT INTO cities (city_name, province, recruitment_status, data_json)
SELECT v.city, v.province, 'enabled', '{}'
FROM (
  SELECT '杭州' AS city, '浙江' AS province
  UNION ALL SELECT '成都', '四川'
  UNION ALL SELECT '沈阳', '辽宁'
  UNION ALL SELECT '昆明', '云南'
  UNION ALL SELECT '青岛', '山东'
  UNION ALL SELECT '武汉', '湖北'
  UNION ALL SELECT '郑州', '河南'
  UNION ALL SELECT '重庆', '重庆'
) AS v
WHERE NOT EXISTS (SELECT 1 FROM cities c WHERE c.city_name = v.city);

INSERT INTO location (parent_id, level, name, code, status, address)
SELECT NULL, 'city', v.city, v.code, 'enabled', v.address
FROM (
  SELECT '杭州' AS city, 'LEGACY-HZ' AS code, '浙江省杭州市' AS address
  UNION ALL SELECT '成都', 'LEGACY-CD', '四川省成都市'
  UNION ALL SELECT '沈阳', 'LEGACY-SY', '辽宁省沈阳市'
  UNION ALL SELECT '昆明', 'LEGACY-KM', '云南省昆明市'
  UNION ALL SELECT '青岛', 'LEGACY-QD', '山东省青岛市'
  UNION ALL SELECT '武汉', 'LEGACY-WH', '湖北省武汉市'
  UNION ALL SELECT '郑州', 'LEGACY-ZZ', '河南省郑州市'
  UNION ALL SELECT '重庆', 'LEGACY-CQ', '重庆市'
) AS v
WHERE NOT EXISTS (SELECT 1 FROM location l WHERE l.level='city' AND l.name=v.city);

-- 1.2 这 8 个城市的招工方（一个城市一个，没有面试点也能按城市答）
INSERT INTO employer (tenant_id, vertical_id, employer_code, display_name, short_name, location_id, status, data_json)
SELECT 1, (SELECT id FROM vertical WHERE tenant_id=1 AND code='subway'),
       v.code, v.name, v.short_name,
       (SELECT l.id FROM location l WHERE l.level='city' AND l.name=v.city LIMIT 1),
       'enabled', '{}'
FROM (
  SELECT 'SUB-HZ-001' AS code, '杭州地铁安检' AS name, '杭州安检' AS short_name, '杭州' AS city
  UNION ALL SELECT 'SUB-CD-001', '成都地铁安检', '成都安检', '成都'
  UNION ALL SELECT 'SUB-SY-001', '沈阳地铁安检', '沈阳安检', '沈阳'
  UNION ALL SELECT 'SUB-KM-001', '昆明地铁安检', '昆明安检', '昆明'
  UNION ALL SELECT 'SUB-QD-001', '青岛地铁安检', '青岛安检', '青岛'
  UNION ALL SELECT 'SUB-WH-001', '武汉地铁安检', '武汉安检', '武汉'
  UNION ALL SELECT 'SUB-ZZ-001', '郑州地铁安检', '郑州安检', '郑州'
  UNION ALL SELECT 'SUB-CQ-001', '重庆地铁安检', '重庆安检', '重庆'
) AS v
WHERE NOT EXISTS (SELECT 1 FROM employer e WHERE e.tenant_id=1 AND e.employer_code = v.code);

-- 1.3 12 个城市各补一条「工资多少」（新城市还没有这一行）
INSERT INTO kb_faq (tenant_id, vertical_id, scope_level, scope_employer_id, question, keywords, answer, priority, status)
SELECT 1, (SELECT id FROM vertical WHERE tenant_id=1 AND code='subway'),
       'employer', e.id, '工资多少',
       '["工资","薪资","多少钱","一个班","待遇","收入","工价","挣多少"]',
       '', 12, 'enabled'
FROM employer e
WHERE e.tenant_id = 1
  AND e.employer_code IN (
    'SUB-HZ-001','SUB-NN-001','SUB-FS-001','SUB-FS-002','SUB-GZ-001','SUB-CD-001',
    'SUB-SY-001','SUB-KM-001','SUB-QD-001','SUB-WH-001','SUB-ZZ-001','SUB-CQ-001','SUB-SZ-001')
  AND NOT EXISTS (
    SELECT 1 FROM kb_faq k
    WHERE k.tenant_id=1 AND k.scope_level='employer' AND k.scope_employer_id=e.id AND k.question='工资多少'
  );

-- 1.4 工资架构：答案用话术文档原文，班次/在岗时间/吃住/实习转正单价/保底一次说全
UPDATE kb_faq
SET answer = (
  SELECT m.answer FROM (
    SELECT 'SUB-HZ-001' AS code,
           '早班 7:00-15:00，夜班 15:00-22:30。每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，月休 4 天也可以不休息，转正购买社保+节假日三薪。咱们是转正 125 元/班（5-6 小时）、250 元/天（9-10 小时），实习 90 元/班、180 元/天。转正 1-3 个月可以申请提前转正，个别员工 1 个月就能转。试用期内 20 天班保底工资 3600，剩下 10 天自由安排，按班次计算，多劳多得。转正保底就已经 5000 了，到手保底都在 6000-7000 这样。' AS answer
    UNION ALL SELECT 'SUB-NN-001',
           '早班 7:00-15:00，夜班 15:00-22:30。每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，上 2 休 1 也可以不休息，转正购买社保+节假日三薪。咱们是转正 110 元/班、220 元/天，实习 80 元/班、160 元/天。转正 3 个月可以申请提前转正，看个人表现，转正不需要考核。试用期内 20 天班保底工资 3200，剩下 10 天自由安排。转正保底就已经 4400 了，到手保底都在 6000-7000 这样。'
    UNION ALL SELECT 'SUB-FS-001',
           '早班 7:00-15:00，夜班 15:00-22:30。每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，月休 4 天也可以不休息，转正购买社保+节假日三薪。咱们是转正 150 元/班、300 元/天，实习 110 元/班、220 元/天。转正 1-3 个月可以申请提前转正，个别员工 1 个月就能转。试用期内 20 天班保底工资 4400，剩下 10 天自由安排。转正保底就已经 6000 了，到手保底都在 6500-7000 这样。'
    UNION ALL SELECT 'SUB-FS-002',
           '早班 7:00-15:00，夜班 15:00-22:30。每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，月休 4 天也可以不休息，转正购买社保+节假日三薪。咱们是转正 150 元/班、300 元/天，实习 110 元/班、220 元/天。转正 1-3 个月可以申请提前转正，个别员工 1 个月就能转。试用期内 20 天班保底工资 4400，剩下 10 天自由安排。转正保底就已经 6000 了，到手保底都在 6500-7000 这样。'
    UNION ALL SELECT 'SUB-GZ-001',
           '早班 7:00-15:00，夜班 15:00-22:30。每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，上 2 休 1 也可以不休息，转正购买社保+节假日三薪。咱们是转正 175 元/班、350 元/天，实习 120 元/班、240 元/天，额外还有高峰补贴 30 元/次，上班就有。转正 1-2 个月可以申请提前转正，个别员工 1 个月就能转。试用期内 20 天班保底工资 4800，剩下 10 天自由安排，按班次计算，多劳多得。转正保底就已经 7000 了。'
    UNION ALL SELECT 'SUB-CD-001',
           '早班 6:00-14:30，夜班 14:30-23:00。每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，上 2 休 1 或上 1 休 1，也可以不休息，转正购买社保+节假日三薪。咱们是转正 110 元/班、220 元/天，实习 90 元/班、180 元/天。转正 1-2 个月可以申请提前转正，现在基本都是一个月内就能转。试用期内 20 天班保底工资 3600，剩下 10 天自由安排。'
    UNION ALL SELECT 'SUB-SY-001',
           '早班 8:00-17:00，中班 17:00-23:00。每班次 8 小时含吃饭休息时间，中间每工作 1 小时休息 10-20 分钟，实际在岗 7-8 小时。包吃三餐包住，上 2 休 1 也可以不休息，节假日三薪。咱们是转正 125 元/班（7-8 小时）、230 元/天（11-12 小时），实习 85 元/班、165 元/天。转正 3 个月可以申请提前转正，个别员工 1 个月就能转。试用期内 20 天班保底工资 3300，剩下 10 天自由安排。转正保底就已经 4600 了，到手保底都在 6000-7000 这样。'
    UNION ALL SELECT 'SUB-KM-001',
           '9:00-23:00，包含 4 小时吃饭时间，中间每工作 1 小时休息 15-20 分钟，实际在岗 9-10 小时。包吃三餐包住，上 1 休 1 也可以不休息，多劳多得，排班制，可以短期兼顾也可以长期做，自己选。转正后 190 元/天（9-10 小时），实习期 160 元/天。转正 1-2 个月可以申请提前转正，个别员工 1 个月就能转。在职队员基本都是一个月上 20 天，实习期内 20 天班保底工资 3200，剩下 10 天自由安排。转正 20 天保底就已经 3800 了，到手保底都在 6000+ 这样。你也可以一个月只上 15 天，剩下的时间做自己的事情，这边排班很人性化。'
    UNION ALL SELECT 'SUB-QD-001',
           '早班 7:00-15:00，夜班 15:00-22:30。每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，月休 4 天也可以不休息，转正购买社保+节假日三薪。咱们是转正 120 元/班、240 元/天，实习 90 元/班、180 元/天。转正 1-2 个月可以申请提前转正，现在基本都是一个月内就能转。试用期内 20 天班保底工资 3600，剩下 10 天自由安排。转正保底就已经 4800 了，到手保底都在 6000-7000 这样。'
    UNION ALL SELECT 'SUB-WH-001',
           '早班 7:00-14:00，夜班 14:00-22:30。每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，上 2 休 1 或上 1 休 1，也可以不休息，转正购买社保+节假日三薪。咱们是转正 125 元/班、250 元/天，实习 90 元/班、180 元/天。转正 1-3 个月可以申请提前转正，个别员工 1 个月就能转。试用期内 20 天班保底工资 3600，剩下 10 天自由安排。转正保底就已经 5000 了，到手保底都在 6000-7000 这样。'
    UNION ALL SELECT 'SUB-ZZ-001',
           '早班 7:00-14:00，夜班 14:00-21:30。每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，上 2 休 1 或上 1 休 1，也可以不休息，转正节假日三薪。咱们是转正 130 元/班、245 元/天，实习 90 元/班、180 元/天。转正 1-3 个月可以申请提前转正，个别员工 1 个月就能转。试用期内 20 天班保底工资 3600，剩下 10 天自由安排。转正保底就已经 4900 了，到手保底都在 6000-7000 这样。'
    UNION ALL SELECT 'SUB-CQ-001',
           '早班 7:00-14:00，夜班 14:00-22:30。每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，上 2 休 1 或上 1 休 1，也可以不休息，转正购买社保+节假日三薪。咱们是转正 125 元/班、250 元/天，实习 100 元/班、200 元/天。转正 1-2 个月可以申请提前转正，现在基本都是一个月内就能转。试用期内 20 天班保底工资 4400，剩下 10 天自由安排。转正保底就已经 5000 了，到手保底都在 6000-7000 这样。'
    UNION ALL SELECT 'SUB-SZ-001',
           '早班 6:30-15:00，夜班 15:00-22:30。每班次 8 小时，实际在岗 5-6 小时，中间每工作 1 小时休息 10-20 分钟。包吃三餐包住，上 2 休 1 也可以不休息，转正购买社保+节假日三薪。150 元/班（5-6 小时）、300 元/天（9-10 小时）。转正 1-2 个月可以申请提前转正，现在基本都是一个月内就能转。试用期内 20 天班保底工资 6000，剩下 10 天自由安排。想赚多点的话，剩下 10 天抽时间做个单班或者连班，综合下来都已经 7000+ 了。'
  ) AS m
  WHERE m.code = (SELECT e.employer_code FROM employer e WHERE e.id = kb_faq.scope_employer_id)
)
WHERE kb_faq.tenant_id = 1
  AND kb_faq.scope_level = 'employer'
  AND kb_faq.question = '工资多少'
  AND (SELECT e.employer_code FROM employer e WHERE e.id = kb_faq.scope_employer_id) IN (
    'SUB-HZ-001','SUB-NN-001','SUB-FS-001','SUB-FS-002','SUB-GZ-001','SUB-CD-001',
    'SUB-SY-001','SUB-KM-001','SUB-QD-001','SUB-WH-001','SUB-ZZ-001','SUB-CQ-001','SUB-SZ-001');

-- ══════════════════════════════════════════════════════════════
-- 二、地铁：8 组异议处理（品类级，12 个城市通用）
--     原文来自《地铁安检话术》前 41 段
-- ══════════════════════════════════════════════════════════════
INSERT INTO kb_faq (tenant_id, vertical_id, scope_level, question, keywords, answer, priority, status)
SELECT 1, (SELECT id FROM vertical WHERE tenant_id=1 AND code='subway'),
       'vertical', v.question, v.keywords, v.answer, v.priority, 'enabled'
FROM (
  SELECT '太远了过来不方便' AS question,
         '["太远","远","外宿","不方便","距离","地址远","过去不方便"]' AS keywords,
         '面试地址是可以直达的，面试好分岗分线路分发制服，后面你上班以及未来的考勤都在你就近的站点，我们的总基地你只需要过来一次即可。前期可以先到我们这边来住，包吃包住，被褥免费提供也很方便。' AS answer,
         11 AS priority
  UNION ALL SELECT '工资太低/待遇不清晰',
         '["工资低","太低","待遇","不清晰","挣得少","划算"]',
         '咱们这边每班次 8 小时，实际在岗 6 小时，中间每工作 1 小时休息 10-20 分钟，包吃三餐包住，月休 4 天也可以不休息，转正购买社保+节假日三薪。按班次计算工资，多劳多得，你想多赚钱的话一个月多上班也可以，看你自己。',
         10
  UNION ALL SELECT '连班时间太长/太累',
         '["连班","时间长","累","站岗","站多久","受不了","太辛苦"]',
         '站岗坐岗都是轮流，半小时轮岗一次，每小时又可以休息 10-20 分钟，一个班 8 小时含吃饭和休息时间在内，实际在岗时间才 5-6 个小时左右，两个班实际在岗时间也才 10-12 个小时。我们是坐着看监控和安检机，站点不是每时每刻都有人，一天下来其实没几个小时工作时间，还是很轻松的。',
         10
  UNION ALL SELECT '买社保吗',
         '["社保","五险","一金","保险","缴纳"]',
         '我们是转正后有缴纳社保的，现在社保是全国联网，不会断的，只要缴纳够年限就可以享用。节假日还有三薪。',
         10
  UNION ALL SELECT '有什么福利',
         '["福利","待遇","免费","补贴","好处"]',
         '福利一：上岗每个小时有轮流休息时间，持工作证全线路免费乘坐交通工具。福利二：实习 1-2 个月自动转正为正式工。福利三：线路就近安排上岗，包吃三餐包住宿，被褥和工服都是免费提供，面试当天可入住和饭堂吃饭。福利四：班次自由选择，工作轻松，不要求学历和工作经验。福利五：部分线路可周结，其他线路月结也可借支。福利六：安检基地直招，不收取任何一分钱费用。',
         9
  UNION ALL SELECT '保底工资到底多少',
         '["保底","到手","最低","试用期多少","实际拿到","净拿"]',
         '咱们是按班次计算工资，多劳多得。试用期内 20 天班有保底工资，剩下 10 天自由安排；转正后 20 天班保底再高一档，综合到手 6000-7000 这样。具体数字面试时我按你去的城市给你算清楚。',
         10
  UNION ALL SELECT '我再考虑一下',
         '["考虑","想想","再看看","犹豫","商量","回家问问"]',
         '我们安检是普通轻松的岗位，冬暖夏凉，不是高难度技术岗，也不是叫你去做苦力，面试后就上岗。你再找别的这种普通轻松岗位，不一定有这么高薪资还包吃住买社保。我们现在招的正式工不多，名额非常有限，安检基地直招，全程不收取任何费用。如果这几天没啥紧要事的话，可以先过来面试。',
         11
  UNION ALL SELECT '面试能不能过',
         '["能不能过","会不会刷","过不了","面试难","怕不过"]',
         '我们面试只看身高，还有你工作态度。你只要是认真找工作都可以通过，boss 上面已经给你问过了，你的条件是符合的，不用担心跑过来一趟面试不过。我们这边只要你是真心找工作都能通过的。面试结束当天就安排住宿，被褥也有提供，人过来即可。',
         10
) AS v
WHERE NOT EXISTS (
  SELECT 1 FROM kb_faq f
  WHERE f.tenant_id=1
    AND f.vertical_id=(SELECT id FROM vertical WHERE tenant_id=1 AND code='subway')
    AND f.scope_level='vertical' AND f.question=v.question
);

-- ══════════════════════════════════════════════════════════════
-- 三、工厂：异议处理（品类级）
--     原文来自《工厂话术》的工价疑问 / 地址疑问 / 考虑推进段落
-- ══════════════════════════════════════════════════════════════
INSERT INTO kb_faq (tenant_id, vertical_id, scope_level, question, keywords, answer, priority, status)
SELECT 1, (SELECT id FROM vertical WHERE tenant_id=1 AND code='factory'),
       'vertical', v.question, v.keywords, v.answer, v.priority, 'enabled'
FROM (
  SELECT '怀疑工价不真实' AS question,
         '["不真实","假的","骗人","真的吗","合同","靠谱"]' AS keywords,
         '合同签署是一致的，工价都写在合同里。你可以在企查查上查到我们公司的信息，名字和地址和我发给你的是一样的，到了厂门口也是直接联系我接待。' AS answer,
         11 AS priority
  UNION ALL SELECT '怀疑地址不真实',
         '["地址不真实","真的在","查不到","公司地址"]',
         '你可以直接企查查能查到我们公司信息，名字地址和我发给你的地址是一样的，到了厂门口也是直接联系我接待。',
         10
  UNION ALL SELECT '我再考虑一下',
         '["考虑","想想","再看看","犹豫","商量","回家问问"]',
         '这边面试直接到厂门口联系，可以看车间面试。现在岗位都有空缺，车间可以带手机，面试当天会进来车间看，觉得合适再入职。可以固定安排长白班岗位，包吃住，不需要自己出。',
         11
  UNION ALL SELECT '太远了过来不方便',
         '["太远","远","不方便","路费","距离"]',
         '这边可以外宿，也可以先住厂里过渡。现在开年有红包，路费可以报销。面试直接到厂门口联系我接待。',
         9
  UNION ALL SELECT '入职要不要交钱',
         '["交钱","费用","押金","工服费","介绍费"]',
         '入职没有任何费用，不需要你掏钱。饭卡工本费 50 是自己交的，因为饭堂外包给餐饮公司了，不属于厂里；离职不做直接去饭堂可以退回来，其他都不需要你自己掏钱，公司全包了。',
         10
  UNION ALL SELECT '面试能不能过',
         '["能不能过","会不会刷","过不了","面试难","怕不过"]',
         '今天面试很简单，只考察你的面试态度和身体是否健康，而且你过来都是我给你内定名额的。你先认真看我发给你的面试注意事项，确保自己面试通过，面试结束有啥问题随时问我。',
         10
) AS v
WHERE NOT EXISTS (
  SELECT 1 FROM kb_faq f
  WHERE f.tenant_id=1
    AND f.vertical_id=(SELECT id FROM vertical WHERE tenant_id=1 AND code='factory')
    AND f.scope_level='vertical' AND f.question=v.question
);

-- ══════════════════════════════════════════════════════════════
-- 四、流程模板：按客户真实发送顺序
--     工厂原文「先发12，回复了发3，回复了发45」= 注意事项分段发
-- ══════════════════════════════════════════════════════════════
UPDATE flow_template
SET steps_json = '[{"stage":"send_info","action":"render_position_card","note":"发送招聘信息：工价/吃住/班次/工作内容/住宿"},{"stage":"ask_interview","ask":"这两天能不能过来面试？能来的话我把名额给你留着。","note":"客户问细节时先答，松动后推进"},{"stage":"send_notice","action":"send_interview_notice","note":"面试注意事项分两段：先发前两条，回复了再发后三条"},{"stage":"collect","ask":"名字和电话发我一下，我给你先报名。"},{"stage":"done","action":"send_address"}]',
    version = 2
WHERE code = 'flow-factory-v1';

UPDATE flow_template
SET steps_json = '[{"stage":"ask_city","ask":"你打算去哪个城市？广州、佛山、深圳、南宁、南昌、杭州、成都、沈阳、昆明、青岛、武汉、郑州、重庆都在招。","skip_if":"city_known","note":"城市决定工资架构，必须先确认"},{"stage":"send_info","action":"send_wage_structure","note":"发送该城市工资架构：班次/实际在岗/吃住/实习与转正单价/保底"},{"stage":"answer_objection","action":"kb_faq_vertical","note":"嫌远/嫌低/嫌累/问社保福利时走品类级异议处理"},{"stage":"ask_interview","ask":"你明天上午/下午几点能到这边面试？面试结束当天就安排住宿，被褥也有提供，人过来即可。","note":"推进：面试只看身高和工作态度，认真找工作都能过"},{"stage":"collect","ask":"名字、电话、身高发我一下，我给你报上去。"},{"stage":"done","action":"send_address","note":"发面试地址 + 注意事项"}]',
    version = 2
WHERE code = 'flow-subway-v1';

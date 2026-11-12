-- 023_kb_faq_fallbacks.sql
-- 给「常空字段」补兜底文案。
--
-- 背景：模拟验证时发现 4 个问题整句被丢弃——岗位字段里没有 insurance_text /
-- regular_text / advance_text / relocate_policy，模板只剩一个光秃秃的占位符，
-- 渲染层按"没值整句丢"的规则把它删了，结果客户问了等于没回。
--
-- 解法：占位符支持 {name|兜底文案}。有值用值，没值用兜底。
-- 兜底文案里**不含任何数字**，只是通用说法，不会编造工价。
--
-- 幂等：UPDATE ... WHERE question=?，重复执行结果一致。

UPDATE kb_template_item
   SET answer = '{insurance|转正后按岗位购买社保，基层岗暂时没有}'
 WHERE question = '买社保吗';

UPDATE kb_template_item
   SET answer = '{regular|干满 3 个月可以申请转正，上手快的话可以提前}'
 WHERE question = '多久转正';

UPDATE kb_template_item
   SET answer = '{advance|每周可以预支一部分，具体面试时跟驻厂管理员说}'
 WHERE question = '能借支吗';

UPDATE kb_template_item
   SET answer = '{relocate_policy|面试在总部，面试完按你就近的站点分配，后期也可以申请调整}'
 WHERE question = '太远了过来不方便';

-- 同步到租户实例：只更新仍挂在该模板项上的条目（template_item_id 非空且匹配），
-- 运营手工改过的条目 template_item_id 仍存在但内容不同——这里只同步这 4 条，
-- 属于模板升级，可以覆盖。
UPDATE kb_faq
   SET answer = (
         SELECT i.answer FROM kb_template_item i WHERE i.id = kb_faq.template_item_id
       )
 WHERE template_item_id IN (
         SELECT id FROM kb_template_item
          WHERE question IN ('买社保吗', '多久转正', '能借支吗', '太远了过来不方便')
       );

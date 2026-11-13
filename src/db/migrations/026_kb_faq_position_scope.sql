-- 026_kb_faq_position_scope.sql
-- kb_faq 增加岗位级作用域。
--
-- 为什么需要：同一个厂不同工种工价差很多——华荻普工 24-26、焊工 35-40，
-- 客户问「焊工多少钱」，按厂存一条答案只能答一种，答错要赔钱。
--
-- scope_position_id 指向旧 service_positions.id（迁移期同一编号空间），
-- 与 024 的 position_location 保持一致，不进新表、不重复维护一套岗位主数据。
--
-- SQLite 的 ADD COLUMN 带 REFERENCES 时必须是可空列，这里满足。

ALTER TABLE kb_faq ADD COLUMN scope_position_id INTEGER REFERENCES service_positions(id);

CREATE INDEX IF NOT EXISTS idx_kb_faq_position ON kb_faq(tenant_id, scope_position_id, status);

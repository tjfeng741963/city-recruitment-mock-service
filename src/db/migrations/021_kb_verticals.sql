-- 021_kb_verticals.sql
-- 知识库 v3 结构地基：品类 / 位置树 / 招工方 / 场景问答 / 模板包。
-- 设计见 docs/知识库方案-流程驱动-20261113.md
--
-- 与旧表的关系：cities / factories / service_positions 全部保留不动，
-- 本迁移只新增表；回填由后续脚本完成，双读比对通过后再切主（文档 §六）。

-- ── 1. 品类：工厂 / 地铁 / 白领 / 保姆 / 船员，可任意新增 ──────────────
CREATE TABLE IF NOT EXISTS vertical (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  code TEXT NOT NULL,                      -- factory | subway | white_collar | domestic | maritime
  name TEXT NOT NULL,                      -- 工厂 | 地铁安检 | 白领 | 保姆 | 船员
  config_json TEXT NOT NULL DEFAULT '{}',  -- employer_label / location_levels / position_schema
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'enabled',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, code)
);

-- ── 2. 位置：开放层级树 ───────────────────────────────────────────
-- level 是开放字符串而非枚举：
--   工厂 province → city → district → park → point(面试点)
--   保姆 province → city → district → point(雇主家)
--   船员 province → city → point(港口)
CREATE TABLE IF NOT EXISTS location (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES location(id),
  level TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  lat REAL,
  lng REAL,
  address TEXT NOT NULL DEFAULT '',
  walk_guide TEXT NOT NULL DEFAULT '',     -- 「地铁2号线C出口，电梯上7楼A7-A8室」
  image_key TEXT NOT NULL DEFAULT '',      -- 客户端 C:\agent\media\xxx.jpg（不含扩展名）
  status TEXT NOT NULL DEFAULT 'enabled',
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(parent_id, level, name)
);
CREATE INDEX IF NOT EXISTS idx_location_level ON location(level, status);
CREATE INDEX IF NOT EXISTS idx_location_parent ON location(parent_id);

-- ── 3. 招工方：工厂 / 家庭 / 船东 的统一抽象 ──────────────────────
CREATE TABLE IF NOT EXISTS employer (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  vertical_id INTEGER NOT NULL REFERENCES vertical(id),
  employer_code TEXT NOT NULL,             -- 稳定编码 GZ-PY-001，改名不影响引用
  display_name TEXT NOT NULL,              -- 松下万宝电子（广州）有限公司
  short_name TEXT NOT NULL DEFAULT '',     -- 松下万宝
  location_id INTEGER REFERENCES location(id),
  status TEXT NOT NULL DEFAULT 'enabled',
  data_json TEXT NOT NULL DEFAULT '{}',    -- 品类特有字段
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, employer_code)
);
CREATE INDEX IF NOT EXISTS idx_employer_loc ON employer(tenant_id, location_id, status);
CREATE INDEX IF NOT EXISTS idx_employer_vertical ON employer(tenant_id, vertical_id, status);

-- 客户口语 vs 系统全名：松下 / 万宝 / 狄原（错别字也收）
CREATE TABLE IF NOT EXISTS employer_alias (
  id INTEGER PRIMARY KEY,
  employer_id INTEGER NOT NULL REFERENCES employer(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 0,
  UNIQUE(employer_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_employer_alias_text ON employer_alias(alias);

-- ── 4. 岗位 ↔ 多地点（地铁一岗多城、船员一岗多港口）──────────────────
CREATE TABLE IF NOT EXISTS position_location (
  position_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL REFERENCES location(id),
  PRIMARY KEY(position_id, location_id)
);

-- ── 5. 场景问答：按 ID 绑定 scope，按 vertical 隔离 ─────────────────
CREATE TABLE IF NOT EXISTS kb_faq (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  vertical_id INTEGER REFERENCES vertical(id),   -- NULL = 所有品类通用
  scope_level TEXT NOT NULL DEFAULT 'global',    -- global | vertical | city | employer
  scope_location_id INTEGER REFERENCES location(id),
  scope_employer_id INTEGER REFERENCES employer(id),
  question TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',           -- JSON 数组
  answer TEXT NOT NULL,                          -- 可含 {wage} {welfare} {address} 等占位符
  media TEXT NOT NULL DEFAULT '[]',              -- JSON 数组，【图片:x】【视频:y】标记
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'enabled',
  template_item_id INTEGER,                      -- 来源模板项，升级时判断是否被手工改过
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kb_faq_scope ON kb_faq(tenant_id, vertical_id, scope_level, status);

-- ── 6. 模板包 / 流程模板 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kb_template (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,               -- faq-factory-v1
  name TEXT NOT NULL,
  vertical_code TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT 'labor-dispatch',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kb_template_item (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES kb_template(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  answer TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS flow_template (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,               -- flow-factory-v1
  vertical_code TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── 7. 初始品类：工厂 / 地铁 ──────────────────────────────────────
INSERT INTO vertical (tenant_id, code, name, config_json, sort_order)
SELECT 1, 'factory', '工厂',
       '{"employer_label":"工厂","location_levels":["province","city","district","park","point"],"position_schema":[{"key":"wage_text","label":"工价","type":"text","required":true},{"key":"hours_text","label":"班次","type":"text"},{"key":"welfare_text","label":"吃住","type":"text"},{"key":"age_text","label":"年龄","type":"text"},{"key":"tattoo_policy","label":"纹身要求","type":"text"}],"faq_pack":"faq-factory-v1","flow_template":"flow-factory-v1"}',
       1
WHERE NOT EXISTS (SELECT 1 FROM vertical WHERE tenant_id=1 AND code='factory');

INSERT INTO vertical (tenant_id, code, name, config_json, sort_order)
SELECT 1, 'subway', '地铁安检',
       '{"employer_label":"线路","location_levels":["province","city","point"],"position_schema":[{"key":"wage_text","label":"薪资","type":"text","required":true},{"key":"hours_text","label":"班次","type":"text"},{"key":"height_text","label":"身高要求","type":"text"},{"key":"tattoo_policy","label":"纹身要求","type":"text"},{"key":"line_text","label":"安排线路","type":"text"}],"faq_pack":"faq-subway-v1","flow_template":"flow-subway-v1"}',
       2
WHERE NOT EXISTS (SELECT 1 FROM vertical WHERE tenant_id=1 AND code='subway');

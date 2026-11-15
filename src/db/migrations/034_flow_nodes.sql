-- 节点化编排：把写死的五阶段改成可配置的节点图（2026-11-14）。
--
-- 背景：`flow_engine.step()` 是 if/elif 硬编码 ask_city → send_info →
-- ask_interview → collect → done。运营改不了顺序、加不了分支，每次调整都要改代码。
-- 目标是「在网页上搭节点，每个节点决定说什么，边决定什么条件下转到哪」。
--
-- 与现有结构的关系（不推翻已有数据）：
--   flow_template.steps_json 仍是「一条线性步骤序列」，保留不动；
--   本表是它的超集——节点是有向图的顶点，边是条件转移。
--   `flow_nodes.body` 为空时回退到 device_scripts（按 stage+city 的话术），
--   再回退到 flow_engine 的默认话术。三层兜底保证不会因为没配节点就不回话。
--
-- 为什么节点和边分两张表：同一个节点会被多条边指向（「问工价」可能从
-- 「发岗位」来，也可能从「介绍宿舍」来）。合并成一张表就得复制话术。

CREATE TABLE IF NOT EXISTS flow_nodes (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  -- 归属：空串 = 板块级模板（所有该板块设备共用）；非空 = 该设备专属覆盖
  device_code TEXT NOT NULL DEFAULT '',
  vertical_code TEXT NOT NULL DEFAULT '',    -- factory / subway / ...
  node_key TEXT NOT NULL,                    -- 稳定标识：greet / send_info / ask_city ...
  title TEXT NOT NULL DEFAULT '',            -- 运营看到的名字
  body TEXT NOT NULL DEFAULT '',             -- 话术正文，支持 {{factory}} {{wage}} 等占位符
  media TEXT NOT NULL DEFAULT '',            -- 媒体标记，如 【图片:广州面试点】
  -- 入口节点：新好友首个节点。每个 (device_code, vertical_code) 最多一个
  is_entry INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'enabled',
  sort_order INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, device_code, vertical_code, node_key)
);

CREATE INDEX IF NOT EXISTS idx_flow_nodes_scope
  ON flow_nodes(device_code, vertical_code, status);

CREATE TABLE IF NOT EXISTS flow_edges (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL DEFAULT 1,
  device_code TEXT NOT NULL DEFAULT '',
  vertical_code TEXT NOT NULL DEFAULT '',
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  -- always     无条件（按 priority 第一条命中即跳）
  -- keyword    命中 condition_value 里任一关键词（逗号分隔）
  -- regex      命中 condition_value 的正则
  -- collected  槽位 condition_value 非空（如 phone / name）
  -- intent     语义意图（预留，当前按 keyword 处理）
  condition_type TEXT NOT NULL DEFAULT 'always',
  condition_value TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,     -- 小者优先
  status TEXT NOT NULL DEFAULT 'enabled',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_flow_edges_from
  ON flow_edges(device_code, vertical_code, from_node, status, priority);

-- 把现有流程落成默认节点图（两个板块各一套）。
-- node_key 直接用 flow_engine 的 stage 常量，保证未配节点时能无缝回退到原有逻辑。
INSERT INTO flow_nodes (tenant_id, device_code, vertical_code, node_key, title, body, is_entry, sort_order)
SELECT 1, '', n.code, n.node_key, n.title, '', n.is_entry, n.sort_order
FROM (
  SELECT 'factory' AS code, 'send_info' AS node_key, '发岗位卡' AS title, 1 AS is_entry, 1 AS sort_order
  UNION ALL SELECT 'factory', 'ask_interview', '约面试', 0, 2
  UNION ALL SELECT 'factory', 'collect', '收姓名电话', 0, 3
  UNION ALL SELECT 'factory', 'done', '发地址', 0, 4
  UNION ALL SELECT 'subway', 'ask_city', '问城市', 1, 1
  UNION ALL SELECT 'subway', 'send_info', '发工资架构', 0, 2
  UNION ALL SELECT 'subway', 'ask_interview', '约面试', 0, 3
  UNION ALL SELECT 'subway', 'collect', '收姓名电话身高', 0, 4
  UNION ALL SELECT 'subway', 'done', '发地址', 0, 5
) AS n
WHERE NOT EXISTS (
  SELECT 1 FROM flow_nodes f
  WHERE f.tenant_id = 1 AND f.device_code = ''
    AND f.vertical_code = n.code AND f.node_key = n.node_key
);

-- 默认边：与 flow_engine 现有顺序一致
INSERT INTO flow_edges (tenant_id, device_code, vertical_code, from_node, to_node, condition_type, condition_value, priority)
SELECT 1, '', e.code, e.from_node, e.to_node, e.condition_type, e.condition_value, e.priority
FROM (
  SELECT 'factory' AS code, 'send_info' AS from_node, 'ask_interview' AS to_node,
         'keyword' AS condition_type, '面试,可以,行,好,去,什么时候,几点' AS condition_value, 10 AS priority
  UNION ALL SELECT 'factory', 'ask_interview', 'collect', 'keyword', '可以,行,好,能来,没问题,几点,到了', 10
  UNION ALL SELECT 'factory', 'ask_interview', 'done', 'keyword', '不去,不去了,算了,不合适,不要了', 5
  UNION ALL SELECT 'factory', 'collect', 'done', 'collected', 'phone', 10
  UNION ALL SELECT 'subway', 'ask_city', 'send_info', 'always', '', 100
  UNION ALL SELECT 'subway', 'send_info', 'ask_interview', 'keyword', '面试,可以,行,好,去,什么时候,几点', 10
  UNION ALL SELECT 'subway', 'ask_interview', 'collect', 'keyword', '可以,行,好,能来,没问题,几点', 10
  UNION ALL SELECT 'subway', 'ask_interview', 'done', 'keyword', '不去,不去了,算了,不合适,不要了', 5
  UNION ALL SELECT 'subway', 'collect', 'done', 'collected', 'phone', 10
) AS e
WHERE NOT EXISTS (
  SELECT 1 FROM flow_edges f
  WHERE f.tenant_id = 1 AND f.device_code = '' AND f.vertical_code = e.code
    AND f.from_node = e.from_node AND f.to_node = e.to_node
);

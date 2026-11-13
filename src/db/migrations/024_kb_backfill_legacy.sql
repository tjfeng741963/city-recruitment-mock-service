-- 024_kb_backfill_legacy.sql
-- P1-4 数据回填：把存量 cities / factories / service_positions 映射进 v3 结构。
-- 设计见 docs/知识库方案-流程驱动-20261113.md §六「旧表不删、双读比对」。
--
-- 原则：
-- 1. 只 INSERT，绝不改旧表 —— 回填失败可以整条删掉重来，旧链路零影响；
-- 2. 幂等：全部走 NOT EXISTS，重复跑不会产生重复行；
-- 3. 编码稳定：旧表 id → 新表编码，factory 用 LEGACY-F{旧id}，city 用
--    LEGACY-C{旧id}，改名不影响引用；显示名原样保留，便于人工核对。
-- 4. 省份按名称归并（cities.province 只是文本，会重复）。

-- ── 1. 位置：省份 → 城市 两级 ─────────────────────────────────────
-- 注意：NOT EXISTS 是逐行判定的，同一省份的多条 cities 行会互相看不见，
-- 所以先按省份名去重再插，否则「广东」会被插三次。
INSERT INTO location (parent_id, level, name, code, status)
SELECT NULL, 'province', p.name, '', 'enabled'
FROM (SELECT DISTINCT TRIM(province) AS name FROM cities WHERE TRIM(province) <> '') p
WHERE NOT EXISTS (SELECT 1 FROM location l WHERE l.parent_id IS NULL AND l.level='province' AND l.name=p.name);

INSERT INTO location (parent_id, level, name, code, status, data_json)
SELECT p.id, 'city', c.city_name, 'LEGACY-C' || c.id, c.recruitment_status,
       json_object('legacy_city_id', c.id)
FROM cities c
JOIN location p ON p.parent_id IS NULL AND p.level='province' AND p.name=TRIM(c.province) AND TRIM(c.province) <> ''
WHERE NOT EXISTS (
  SELECT 1 FROM location l
  WHERE l.parent_id = p.id AND l.level='city' AND l.name=c.city_name
);

-- 没有省份文本的城市：挂在顶层 city，不丢数据
INSERT INTO location (parent_id, level, name, code, status, data_json)
SELECT NULL, 'city', c.city_name, 'LEGACY-C' || c.id, c.recruitment_status,
       json_object('legacy_city_id', c.id)
FROM cities c
WHERE TRIM(c.province) = ''
  AND NOT EXISTS (SELECT 1 FROM location l WHERE l.parent_id IS NULL AND l.level='city' AND l.name=c.city_name);

-- ── 2. 招工方：factories → employer（品类 factory）─────────────────
-- location_id 取工厂所在城市的 location 行。
INSERT INTO employer (tenant_id, vertical_id, employer_code, display_name, short_name, location_id, status, data_json)
SELECT 1,
       (SELECT v.id FROM vertical v WHERE v.tenant_id=1 AND v.code='factory'),
       'LEGACY-F' || f.id,
       f.factory_name,
       f.factory_name,
       (SELECT l.id FROM location l
         JOIN cities c ON c.city_name = l.name
        WHERE l.level='city' AND c.id = f.city_id
        LIMIT 1),
       f.status,
       json_object('legacy_factory_id', f.id, 'legacy_city_id', f.city_id)
FROM factories f
WHERE NOT EXISTS (
  SELECT 1 FROM employer e WHERE e.tenant_id=1 AND e.employer_code='LEGACY-F' || f.id
);

-- ── 3. 别名：工厂全名本身也进别名表，便于按名称反查 ─────────────────
INSERT INTO employer_alias (employer_id, alias, weight)
SELECT e.id, e.display_name, 10
FROM employer e
WHERE e.tenant_id=1
  AND e.employer_code LIKE 'LEGACY-F%'
  AND NOT EXISTS (SELECT 1 FROM employer_alias a WHERE a.employer_id=e.id AND a.alias=e.display_name);

-- ── 4. 岗位 ↔ 地点：服务岗位挂到所属工厂的位置 ─────────────────────
-- position_location.position_id 复用旧 service_positions.id（迁移期同一编号空间）。
INSERT INTO position_location (position_id, location_id)
SELECT sp.id, e.location_id
FROM service_positions sp
JOIN employer e ON e.tenant_id=1 AND e.employer_code='LEGACY-F' || sp.factory_id
WHERE e.location_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM position_location pl WHERE pl.position_id=sp.id AND pl.location_id=e.location_id
  );

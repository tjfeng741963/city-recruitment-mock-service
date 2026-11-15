-- 周边城市关系去重 + 加唯一约束（2026-11-14）。
--
-- 背景：001_init.sql 建的 city_links 没有唯一约束，005_relations.sql 里那份
-- 带 PRIMARY KEY(city_id,linked_city_id) 的定义因为 "CREATE TABLE IF NOT EXISTS"
-- 撞上已存在的表，实际没生效。结果是「保存周边城市」每点一次就插一遍，
-- 线上 248 行里只有 2 个真实关系（广州→深圳、深圳→东莞各 124 份）。
--
-- 这里先删重复（保留 id 最小的一条），再补唯一索引，让重复写入变成 no-op。

DELETE FROM city_links
 WHERE id NOT IN (
   SELECT MIN(id) FROM city_links GROUP BY city_id, linked_city_id
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_city_links_pair
  ON city_links(city_id, linked_city_id);

import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { applyBackfillFile } from "../src/db/backfill.js";

// 只跑 024：028 灌的是客户真实工厂数据，会污染这里的计数断言
const backfill024 = (db: Parameters<typeof applyBackfillFile>[0]) =>
  applyBackfillFile(db, "migrations/024_kb_backfill_legacy.sql");

// P1-4 存量回填：cities / factories / service_positions → location / employer
// 契约：docs/知识库方案-流程驱动-20261113.md §六「旧表不删、双读比对」
describe("kb legacy backfill (024)", () => {
  const fresh = () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    return db;
  };

  it("inserts nothing when run before seed data exists", () => {
    const db = fresh();
    // 迁移里已经跑过一次（此时旧表为空）
    expect(db.prepare("SELECT COUNT(*) c FROM location").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM employer").get()).toMatchObject({ c: 0 });
    db.close();
  });

  it("maps cities into a province→city tree with stable codes", () => {
    const db = fresh();
    db.exec(`INSERT INTO cities(id,city_name,province,recruitment_status)
             VALUES (1,'广州','广东','enabled'),(2,'深圳','广东','enabled'),(3,'东莞','广东','enabled'),(4,'无省城','','enabled')`);
    backfill024(db);

    const provinces = db.prepare("SELECT name FROM location WHERE level='province' ORDER BY name").all();
    // 广东只出现一次，不是三条
    expect(provinces).toEqual([{ name: "广东" }]);

    const guangdongId = (db.prepare("SELECT id FROM location WHERE level='province' AND name='广东'").get() as { id: number }).id;
    const cities = db.prepare("SELECT parent_id,name,code FROM location WHERE level='city'").all();
    const byCode = Object.fromEntries((cities as Array<{ code: string; name: string; parent_id: number | null }>)
      .map((row) => [row.code, { name: row.name, parent_id: row.parent_id }]));
    expect(byCode).toEqual({
      "LEGACY-C1": { name: "广州", parent_id: guangdongId },
      "LEGACY-C2": { name: "深圳", parent_id: guangdongId },
      "LEGACY-C3": { name: "东莞", parent_id: guangdongId },
      // 没有省份文本的城市挂顶层，不丢
      "LEGACY-C4": { name: "无省城", parent_id: null },
    });
    db.close();
  });

  it("maps factories into employers with their city as location_id", () => {
    const db = fresh();
    db.exec("INSERT INTO cities(id,city_name,province) VALUES (1,'广州','广东'),(2,'深圳','广东')");
    db.exec(`INSERT INTO factories(id,factory_name,city_id,status)
             VALUES (1,'本地示例工厂',1,'enabled'),(2,'示例电子厂',2,'disabled')`);
    backfill024(db);

    const rows = db.prepare(
      "SELECT employer_code,display_name,short_name,status,location_id FROM employer ORDER BY employer_code",
    ).all() as Array<{ employer_code: string; display_name: string; location_id: number | null }>;
    expect(rows.map((r) => [r.employer_code, r.display_name])).toEqual([
      ["LEGACY-F1", "本地示例工厂"],
      ["LEGACY-F2", "示例电子厂"],
    ]);
    const gz = (db.prepare("SELECT id FROM location WHERE level='city' AND name='广州'").get() as { id: number }).id;
    expect(rows[0].location_id).toBe(gz);
    // 状态原样带过来，停用的工厂不会因为回填变成 enabled
    expect(db.prepare("SELECT status FROM employer WHERE employer_code='LEGACY-F2'").get()).toMatchObject({ status: "disabled" });
    // 工厂全名进别名表，便于按名称反查
    expect(db.prepare("SELECT alias FROM employer_alias ORDER BY alias").all().map((a: { alias: string }) => a.alias))
      .toEqual(["本地示例工厂", "示例电子厂"]);
    db.close();
  });

  it("is idempotent: running it repeatedly changes nothing", () => {
    const db = fresh();
    db.exec("INSERT INTO cities(id,city_name,province) VALUES (1,'广州','广东')");
    db.exec("INSERT INTO factories(id,factory_name,city_id) VALUES (1,'本地示例工厂',1)");
    backfill024(db);
    const snapshot = () => ({
      locations: db.prepare("SELECT COUNT(*) c FROM location").get(),
      employers: db.prepare("SELECT COUNT(*) c FROM employer").get(),
      aliases: db.prepare("SELECT COUNT(*) c FROM employer_alias").get(),
    });
    const first = snapshot();
    backfill024(db);
    backfill024(db);
    expect(snapshot()).toEqual(first);
    expect(first).toEqual({ locations: { c: 2 }, employers: { c: 1 }, aliases: { c: 1 } });
    db.close();
  });

  it("links service positions to their factory's location", () => {
    const db = fresh();
    db.exec("INSERT INTO cities(id,city_name,province) VALUES (1,'广州','广东')");
    db.exec("INSERT INTO factories(id,factory_name,city_id) VALUES (1,'本地示例工厂',1),(2,'无城市厂',NULL)");
    db.exec("INSERT INTO service_positions(id,position_name,factory_id) VALUES (1,'本地示例岗位',1),(2,'孤儿岗位',2)");
    backfill024(db);

    const gz = (db.prepare("SELECT id FROM location WHERE level='city' AND name='广州'").get() as { id: number }).id;
    // 有位置的岗位挂上；工厂没有城市的岗位不产生脏行
    expect(db.prepare("SELECT position_id,location_id FROM position_location ORDER BY position_id").all())
      .toEqual([{ position_id: 1, location_id: gz }]);
    db.close();
  });
});

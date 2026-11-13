import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import { applyBackfillFile } from "../src/db/backfill.js";

// 客户真实工厂数据导入（028）：6 家厂 / 11 个岗位 / 厂级问答 / 岗位级工价
// 数据来源：客户资料《岗位清单模板（工厂）.xlsx》+《工厂话术.docx》
describe("kb real factories (028)", () => {
  const seeded = () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    seedDatabase(db);
    applyBackfillFile(db, "migrations/024_kb_backfill_legacy.sql");
    applyBackfillFile(db, "backfill/028_kb_real_factories.sql");
    return db;
  };

  it("creates the 6 real factories with 11 positions", () => {
    const db = seeded();
    const names = db.prepare(
      "SELECT factory_name FROM factories ORDER BY factory_name",
    ).all() as Array<{ factory_name: string }>;
    const real = names.filter((n) => [
      "松下万宝美健生活电器(广州)有限公司", "松下·万宝(广州)电熨斗有限公司",
      "广州酒家集团利口福食品有限公司", "广州华荻科技有限公司",
      "广州华智汽车部件有限公司", "广州广汽商贸物流有限公司",
    ].includes(n.factory_name));
    expect(real).toHaveLength(6);

    const positions = db.prepare(
      `SELECT COUNT(*) c FROM service_positions sp JOIN factories f ON f.id=sp.factory_id
        WHERE f.factory_name IN ('广州华荻科技有限公司','广州华智汽车部件有限公司')`,
    ).get() as { c: number };
    expect(positions.c).toBe(6);
    db.close();
  });

  it("gives each factory its own answers so customers never get another plant's policy", () => {
    const db = seeded();
    const read = (code: string, question: string) =>
      (db.prepare(
        `SELECT f.answer FROM kb_faq f JOIN employer e ON e.id=f.scope_employer_id
          WHERE e.employer_code=? AND f.scope_level='employer' AND f.question=?`,
      ).get(code, question) as { answer: string } | undefined)?.answer;

    // 同一句「包吃住吗」，三家厂答案不同
    const songxia = read("GZ-PY-001", "包吃住吗");
    const huadi = read("GZ-PY-004", "包吃住吗");
    const huazhi = read("GZ-PY-005", "包吃住吗");
    expect(songxia).toBeTruthy();
    expect(huadi).toBeTruthy();
    expect(huazhi).toBeTruthy();
    expect(new Set([songxia, huadi, huazhi]).size).toBe(3);

    // 体检政策也必须分开：松下不体检，华荻自理，华智公司出钱
    expect(read("GZ-PY-001", "要不要体检")).toContain("不体检");
    expect(read("GZ-PY-004", "要不要体检")).toContain("自理");
    expect(read("GZ-PY-005", "要不要体检")).toContain("公司出钱");
    db.close();
  });

  it("keeps same-factory different-trade wages apart (普工 vs 焊工)", () => {
    const db = seeded();
    const wage = (factory: string, position: string) =>
      (db.prepare(
        `SELECT k.answer FROM kb_faq k
           JOIN service_positions sp ON sp.id = k.scope_position_id
           JOIN factories f ON f.id = sp.factory_id
          WHERE f.factory_name=? AND sp.position_name=? AND k.scope_level='position'`,
      ).get(factory, position) as { answer: string } | undefined)?.answer;

    // 华荻：普工 24-26、焊工 35-40、叉车需要证
    expect(wage("广州华荻科技有限公司", "普工")).toContain("24-26");
    expect(wage("广州华荻科技有限公司", "焊工")).toContain("35-40");
    expect(wage("广州华荻科技有限公司", "叉车工")).toContain("叉车证");
    // 华智焊工 30-33，和普工 24-26 不是一个数
    expect(wage("广州华智汽车部件有限公司", "焊工")).toContain("30-33");
    expect(wage("广州华智汽车部件有限公司", "普工")).toContain("24-26");
    db.close();
  });

  it("gives every imported position a wage answer — no job goes unanswered", () => {
    const db = seeded();
    const missing = db.prepare(
      `SELECT f.factory_name, sp.position_name FROM service_positions sp
         JOIN factories f ON f.id = sp.factory_id
        WHERE f.factory_name IN (
          '松下万宝美健生活电器(广州)有限公司','松下·万宝(广州)电熨斗有限公司',
          '广州酒家集团利口福食品有限公司','广州华荻科技有限公司',
          '广州华智汽车部件有限公司','广州广汽商贸物流有限公司')
          AND NOT EXISTS (
            SELECT 1 FROM kb_faq k WHERE k.scope_level='position' AND k.scope_position_id=sp.id
          )`,
    ).all();
    expect(missing).toEqual([]);
    db.close();
  });

  it("is idempotent: re-running the import adds nothing", () => {
    const db = seeded();
    const snapshot = () => ({
      factories: (db.prepare("SELECT COUNT(*) c FROM factories").get() as { c: number }).c,
      positions: (db.prepare("SELECT COUNT(*) c FROM service_positions").get() as { c: number }).c,
      employers: (db.prepare("SELECT COUNT(*) c FROM employer").get() as { c: number }).c,
      faqs: (db.prepare("SELECT COUNT(*) c FROM kb_faq").get() as { c: number }).c,
      aliases: (db.prepare("SELECT COUNT(*) c FROM employer_alias").get() as { c: number }).c,
    });
    const first = snapshot();
    applyBackfillFile(db, "backfill/028_kb_real_factories.sql");
    applyBackfillFile(db, "backfill/028_kb_real_factories.sql");
    expect(snapshot()).toEqual(first);
    // 种子自带 2 家示例厂，加上导入的 6 家真实厂 = 8
    expect(db.prepare("SELECT COUNT(*) c FROM employer WHERE employer_code LIKE 'GZ-PY-%'").get()).toMatchObject({ c: 6 });
    db.close();
  });
});

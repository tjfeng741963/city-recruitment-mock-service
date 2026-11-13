import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import { applyBackfillFile } from "../src/db/backfill.js";

// 客户真实地铁安检数据（029）：5 个城市 / 6 个面试点
// 数据来源：《11.9全国安检输送集合信息+薪资表.xlsx》
describe("kb real subway (029)", () => {
  const seeded = () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    seedDatabase(db);
    applyBackfillFile(db, "migrations/024_kb_backfill_legacy.sql");
    applyBackfillFile(db, "backfill/029_kb_real_subway.sql");
    return db;
  };

  it("creates the 6 interview points as point-level locations under their city", () => {
    const db = seeded();
    const points = db.prepare(
      `SELECT l.name, p.name AS city FROM location l JOIN location p ON p.id=l.parent_id
        WHERE l.level='point' ORDER BY l.name`,
    ).all() as Array<{ name: string; city: string }>;
    // SQLite 对中文按码点排序，不能依赖 ORDER BY 的顺序，改成按名称建映射
    const byName = Object.fromEntries(points.map((row) => [row.name, row.city]));
    expect(byName).toEqual({
      冠宇商务中心: "广州",
      万通国际: "佛山",
      百花广场: "佛山",
      财富大厦: "南昌",
      固戍站面试点: "深圳",
      钻石广场: "南宁",
    });
    // 面试地址是「发地址」直接用的原文，不能为空
    const addresses = db.prepare("SELECT address FROM location WHERE level='point'").all() as Array<{ address: string }>;
    for (const row of addresses) expect(row.address.trim()).not.toBe("");
    db.close();
  });

  it("creates one employer per interview point, all under the subway vertical", () => {
    const db = seeded();
    const subwayId = (db.prepare("SELECT id FROM vertical WHERE code='subway'").get() as { id: number }).id;
    const rows = db.prepare(
      "SELECT employer_code, display_name, location_id FROM employer WHERE vertical_id=? ORDER BY employer_code",
    ).all(subwayId) as Array<{ employer_code: string; display_name: string; location_id: number | null }>;
    expect(rows.map((r) => r.employer_code)).toEqual([
      "SUB-FS-001", "SUB-FS-002", "SUB-GZ-001", "SUB-NC-001", "SUB-NN-001", "SUB-SZ-001",
    ]);
    // 每个面试点都绑到了一个 point 级位置
    for (const row of rows) {
      expect(row.location_id, row.display_name).toBeTruthy();
      const loc = db.prepare("SELECT level FROM location WHERE id=?").get(row.location_id) as { level: string };
      expect(loc.level).toBe("point");
    }
    db.close();
  });

  it("gives each city its own wage — 深圳 150/班 vs 南宁 80/班", () => {
    const db = seeded();
    const wage = (code: string) =>
      (db.prepare(
        `SELECT k.answer FROM kb_faq k JOIN employer e ON e.id=k.scope_employer_id
          WHERE e.employer_code=? AND k.scope_level='employer' AND k.question='工资多少'`,
      ).get(code) as { answer: string } | undefined)?.answer;

    expect(wage("SUB-SZ-001")).toContain("150 元/班");
    expect(wage("SUB-NN-001")).toContain("80 元/班");
    expect(wage("SUB-GZ-001")).toContain("120 元/班");
    expect(wage("SUB-NC-001")).toContain("80 元/班");
    db.close();
  });

  it("separates the two 佛山 interview points (different days, different captains)", () => {
    const db = seeded();
    const read = (code: string, question: string) =>
      (db.prepare(
        `SELECT k.answer FROM kb_faq k JOIN employer e ON e.id=k.scope_employer_id
          WHERE e.employer_code=? AND k.scope_level='employer' AND k.question=?`,
      ).get(code, question) as { answer: string } | undefined)?.answer;

    // 万通周六休息、百花周日休息 —— 同一城市不能给同一答案
    expect(read("SUB-FS-001", "什么时候面试")).toContain("周六休息");
    expect(read("SUB-FS-002", "什么时候面试")).toContain("周日休息");
    expect(read("SUB-FS-001", "找谁")).toContain("19878700086");
    expect(read("SUB-FS-002", "找谁")).toContain("13757925510");
    db.close();
  });

  it("answers address questions with the real interview location, not a placeholder", () => {
    const db = seeded();
    const address = (code: string) =>
      (db.prepare(
        `SELECT k.answer FROM kb_faq k JOIN employer e ON e.id=k.scope_employer_id
          WHERE e.employer_code=? AND k.scope_level='employer' AND k.question='在哪里面试'`,
      ).get(code) as { answer: string } | undefined)?.answer;

    expect(address("SUB-GZ-001")).toContain("冠宇商务中心");
    expect(address("SUB-GZ-001")).toContain("车陂南站");
    expect(address("SUB-NN-001")).toContain("钻石广场");
    for (const code of ["SUB-GZ-001", "SUB-FS-001", "SUB-FS-002", "SUB-NC-001", "SUB-SZ-001", "SUB-NN-001"]) {
      const answer = address(code);
      expect(answer, code).toBeTruthy();
      // 地址类答案里绝不能出现未渲染的占位符
      expect(answer!, code).not.toMatch(/\{[a-z_]+\}/);
    }
    db.close();
  });

  it("does not leak factory answers into subway devices", () => {
    const db = seeded();
    const subwayId = (db.prepare("SELECT id FROM vertical WHERE code='subway'").get() as { id: number }).id;
    const subwayAnswers = db.prepare(
      "SELECT answer FROM kb_faq WHERE vertical_id=? AND scope_level='employer'",
    ).all(subwayId) as Array<{ answer: string }>;
    for (const row of subwayAnswers) expect(row.answer).not.toContain("华荻");
    db.close();
  });

  it("is idempotent: re-running the import adds nothing", () => {
    const db = seeded();
    const snapshot = () => ({
      points: (db.prepare("SELECT COUNT(*) c FROM location WHERE level='point'").get() as { c: number }).c,
      employers: (db.prepare("SELECT COUNT(*) c FROM employer WHERE employer_code LIKE 'SUB-%'").get() as { c: number }).c,
      positions: (db.prepare("SELECT COUNT(*) c FROM service_positions WHERE position_name='安检员'").get() as { c: number }).c,
      faqs: (db.prepare("SELECT COUNT(*) c FROM kb_faq WHERE vertical_id=? AND scope_level='employer'").get(subwayIdOf(db)) as { c: number }).c,
    });
    const first = snapshot();
    applyBackfillFile(db, "backfill/029_kb_real_subway.sql");
    applyBackfillFile(db, "backfill/029_kb_real_subway.sql");
    expect(snapshot()).toEqual(first);
    expect(first.points).toBe(6);
    expect(first.employers).toBe(6);
    expect(first.positions).toBe(6);
    db.close();
  });
});

function subwayIdOf(db: ReturnType<typeof openDatabase>): number {
  return (db.prepare("SELECT id FROM vertical WHERE code='subway'").get() as { id: number }).id;
}

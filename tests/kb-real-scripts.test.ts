import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import { applyBackfillFile } from "../src/db/backfill.js";

// 客户话术原文编码（030）：12 城市工资架构 + 异议处理 + 真实流程顺序
// 数据来源：《地铁安检话术》《工厂话术》两份 docx
describe("kb real scripts (030)", () => {
  type Db = ReturnType<typeof openDatabase>;

  const seeded = () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    seedDatabase(db);
    applyBackfillFile(db, "migrations/024_kb_backfill_legacy.sql");
    applyBackfillFile(db, "backfill/029_kb_real_subway.sql");
    applyBackfillFile(db, "backfill/030_kb_real_scripts.sql");
    return db;
  };

  const answerOf = (db: Db, verticalCode: string, question: string, employerCode?: string) =>
    (db.prepare(
      `SELECT k.answer FROM kb_faq k
         JOIN vertical v ON v.id = k.vertical_id
         LEFT JOIN employer e ON e.id = k.scope_employer_id
        WHERE v.code=? AND k.question=? AND k.scope_level=?
          AND (? IS NULL OR e.employer_code=?)
        ORDER BY k.id DESC LIMIT 1`,
    ).get(
      verticalCode,
      question,
      employerCode ? "employer" : "vertical",
      employerCode ?? null,
      employerCode ?? null,
    ) as { answer: string } | undefined)?.answer;

  it("covers all 14 subway employers (5 from 029 + 8 new cities + 南昌)", () => {
    const db = seeded();
    const list = (db.prepare(
      "SELECT employer_code FROM employer WHERE employer_code LIKE 'SUB-%'",
    ).all() as Array<{ employer_code: string }>).map((r) => r.employer_code);
    for (const code of [
      "SUB-GZ-001", "SUB-FS-001", "SUB-FS-002", "SUB-SZ-001", "SUB-NN-001", "SUB-NC-001",
      "SUB-HZ-001", "SUB-CD-001", "SUB-SY-001", "SUB-KM-001", "SUB-QD-001",
      "SUB-WH-001", "SUB-ZZ-001", "SUB-CQ-001",
    ]) {
      expect(list, code).toContain(code);
    }
    db.close();
  });

  it("quotes the document's wage architecture instead of a shortened version", () => {
    const db = seeded();
    const gz = answerOf(db, "subway", "工资多少", "SUB-GZ-001");
    // 原文：转正 175/班、350/天；实习 120/班、240/天；保底 4800 / 7000
    expect(gz).toContain("175");
    expect(gz).toContain("350");
    expect(gz).toContain("120");
    expect(gz).toContain("4800");
    expect(gz).toContain("高峰补贴");

    const hz = answerOf(db, "subway", "工资多少", "SUB-HZ-001");
    expect(hz).toContain("125");
    expect(hz).toContain("3600");
    expect(hz).toContain("5000");

    // 昆明是唯一按天计薪、且在岗 9-10 小时的城市
    const km = answerOf(db, "subway", "工资多少", "SUB-KM-001");
    expect(km).toContain("190");
    expect(km).toContain("160");
    expect(km).toContain("9-10 小时");
    db.close();
  });

  it("encodes the objection handlers 025 did not have", () => {
    const db = seeded();
    for (const question of [
      "太远了过来不方便", "工资太低/待遇不清晰", "连班时间太长/太累",
      "有什么福利", "保底工资到底多少", "我再考虑一下", "面试能不能过",
    ]) {
      expect(answerOf(db, "subway", question), question).toBeTruthy();
    }
    for (const question of [
      "怀疑工价不真实", "怀疑地址不真实", "我再考虑一下",
      "太远了过来不方便", "入职要不要交钱", "面试能不能过",
    ]) {
      expect(answerOf(db, "factory", question), question).toBeTruthy();
    }
    db.close();
  });

  it("uses the customer's own wording for the hardest objection (嫌远)", () => {
    const db = seeded();
    const answer = answerOf(db, "subway", "太远了过来不方便");
    // 原文：总基地只需来一次 / 后续就近站点 / 可先住基地
    expect(answer).toContain("只需要过来一次");
    expect(answer).toContain("就近的站点");
    expect(answer).toContain("包吃包住");
    db.close();
  });

  it("keeps objection handlers city-agnostic so every city can use them", () => {
    const db = seeded();
    const subwayId = (db.prepare("SELECT id FROM vertical WHERE code='subway'").get() as { id: number }).id;
    const rows = db.prepare(
      "SELECT scope_employer_id, scope_location_id FROM kb_faq WHERE vertical_id=? AND scope_level='vertical'",
    ).all(subwayId) as Array<{ scope_employer_id: number | null; scope_location_id: number | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      expect(row.scope_employer_id).toBeNull();
      expect(row.scope_location_id).toBeNull();
    }
    db.close();
  });

  it("records the real send order in the flow templates", () => {
    const db = seeded();
    const factory = JSON.parse(
      (db.prepare("SELECT steps_json FROM flow_template WHERE code='flow-factory-v1'").get() as { steps_json: string }).steps_json,
    ) as Array<{ stage: string; note?: string }>;
    // 原文「先发12，回复了发3，回复了发45」
    const notice = factory.find((s) => s.stage === "send_notice");
    expect(notice?.note).toContain("先发前两条");
    expect(notice?.note).toContain("后三条");

    const subway = JSON.parse(
      (db.prepare("SELECT steps_json FROM flow_template WHERE code='flow-subway-v1'").get() as { steps_json: string }).steps_json,
    ) as Array<{ stage: string }>;
    expect(subway.map((s) => s.stage)).toEqual([
      "ask_city", "send_info", "answer_objection", "ask_interview", "collect", "done",
    ]);
    db.close();
  });

  it("is idempotent: re-running adds no rows and keeps answers intact", () => {
    const db = seeded();
    const snapshot = () => ({
      cities: (db.prepare("SELECT COUNT(*) c FROM cities").get() as { c: number }).c,
      employers: (db.prepare("SELECT COUNT(*) c FROM employer").get() as { c: number }).c,
      faqs: (db.prepare("SELECT COUNT(*) c FROM kb_faq").get() as { c: number }).c,
      gz: answerOf(db, "subway", "工资多少", "SUB-GZ-001"),
    });
    const first = snapshot();
    applyBackfillFile(db, "backfill/030_kb_real_scripts.sql");
    applyBackfillFile(db, "backfill/030_kb_real_scripts.sql");
    expect(snapshot()).toEqual(first);
    db.close();
  });
});

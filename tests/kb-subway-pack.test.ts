import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";

// 地铁安检模板包（025）+ 与工厂包的隔离
// 契约：docs/知识库方案-流程驱动-20261113.md §二 品类隔离
describe("subway faq pack (025)", () => {
  const fresh = () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    return db;
  };

  it("seeds the subway template with 18 items and a flow template", () => {
    const db = fresh();
    const pack = db.prepare("SELECT id,code,vertical_code FROM kb_template WHERE code='faq-subway-v1'").get() as
      | { id: number; vertical_code: string }
      | undefined;
    expect(pack).toBeTruthy();
    expect(pack!.vertical_code).toBe("subway");
    expect(db.prepare("SELECT COUNT(*) c FROM kb_template_item WHERE template_id=?").get(pack!.id)).toMatchObject({ c: 18 });

    const flow = db.prepare("SELECT steps_json FROM flow_template WHERE code='flow-subway-v1'").get() as { steps_json: string } | undefined;
    expect(flow).toBeTruthy();
    const steps = JSON.parse(flow!.steps_json) as Array<{ stage: string }>;
    expect(steps.map((s) => s.stage)).toEqual(["ask_city", "send_info", "ask_interview", "collect", "done"]);
    db.close();
  });

  it("imports the pack into kb_faq scoped to the subway vertical only", () => {
    const db = fresh();
    const subwayId = (db.prepare("SELECT id FROM vertical WHERE code='subway'").get() as { id: number }).id;
    const factoryId = (db.prepare("SELECT id FROM vertical WHERE code='factory'").get() as { id: number }).id;

    expect(db.prepare("SELECT COUNT(*) c FROM kb_faq WHERE vertical_id=?").get(subwayId)).toMatchObject({ c: 18 });
    // 工厂包不受影响，仍是 15 条
    expect(db.prepare("SELECT COUNT(*) c FROM kb_faq WHERE vertical_id=?").get(factoryId)).toMatchObject({ c: 15 });
    expect(subwayId).not.toBe(factoryId);
    db.close();
  });

  it("keeps volatile facts in placeholders instead of hard-coded text", () => {
    const db = fresh();
    const rows = db
      .prepare("SELECT question,answer FROM kb_template_item i JOIN kb_template t ON t.id=i.template_id WHERE t.code='faq-subway-v1'")
      .all() as Array<{ question: string; answer: string }>;
    // 工价、班次、月休、年龄、身高、线路、民族限制必须走占位符：换城市不用改话术
    const expected: Record<string, string> = {
      工资多少: "wage", 上班时间: "shift", 月休几天: "rest",
      年龄要求: "age", 身高要求: "height", 安排在哪个站: "line", 什么民族不招: "ethnicity",
    };
    for (const [question, key] of Object.entries(expected)) {
      const row = rows.find((r) => r.question === question);
      expect(row, question).toBeTruthy();
      expect(row!.answer, question).toContain(`{${key}`);
      // 答案里不能出现写死的数字（工价/休几天/身高），否则换城市就错了
      expect(row!.answer.replace(/\{[^}]*\}/g, ""), question).not.toMatch(/\d/);
    }
    db.close();
  });

  it("gives every single-placeholder answer a fallback so it never renders empty", () => {
    const db = fresh();
    const rows = db
      .prepare("SELECT question,answer FROM kb_template_item i JOIN kb_template t ON t.id=i.template_id WHERE t.code='faq-subway-v1'")
      .all() as Array<{ question: string; answer: string }>;
    for (const row of rows) {
      // 整句只有一个占位符时，没值又没兜底 → 回复为空，等于不回答
      const bare = row.answer.match(/^\{([a-z_]+)\}$/);
      if (!bare) continue;
      const hasFallback = /\{[a-z_]+\|.+\}/.test(row.answer);
      const hasValueSource = ["wage", "shift", "rest", "age", "height", "line", "ethnicity", "tattoo_policy", "cert"].includes(bare[1]);
      expect(hasFallback || hasValueSource, `${row.question} → ${row.answer} 可能渲染为空`).toBe(true);
    }
    db.close();
  });
});

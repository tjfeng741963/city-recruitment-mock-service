/**
 * 知识库衔接层契约测试（2026-11-15）。
 *
 * 目的：锁死「原版知识库页面调用的旧契约」与「我们新表 kb_faq」之间的映射。
 * 一旦有人改了映射规则，这里必须红。
 *
 * 两个关键约束：
 *   1. 旧页面固定七字段：id / question / keywords[] / is_active / sort_order /
 *      recruiter_id / updated_at。少一个前端表格就渲染不出来。
 *   2. 读写必须落在 kb_faq，而不是 knowledge_items —— 这是「衔接另一条路线」
 *      的全部意义：页面壳不变，数据换成 AI 实际用的那张表。
 */
import { describe, expect, test } from "vitest";
import { __test } from "../src/modules/agent/knowledge-compat.routes.js";

const { toLegacyShape, parseKeywords } = __test;

describe("kb_faq → 旧页面契约", () => {
  test("输出恰好七字段，不多不少", () => {
    const row = {
      id: 7,
      question: "体检要花钱吗",
      keywords: '["体检","费用"]',
      answer: "体检费自己先出",
      priority: 3,
      status: "enabled",
      updated_at: "2026-11-15 10:00:00",
    };
    const out = toLegacyShape(row);
    expect(Object.keys(out).sort()).toEqual(
      ["id", "is_active", "keywords", "question", "recruiter_id", "sort_order", "updated_at"].sort(),
    );
  });

  test("status=enabled 映射成 is_active=true", () => {
    expect(toLegacyShape({ status: "enabled" }).is_active).toBe(true);
    expect(toLegacyShape({ status: "disabled" }).is_active).toBe(false);
    expect(toLegacyShape({ status: "deleted" }).is_active).toBe(false);
    expect(toLegacyShape({}).is_active).toBe(false);
  });

  test("priority 映射成 sort_order（旧页面列名叫排序）", () => {
    expect(toLegacyShape({ priority: 9 }).sort_order).toBe(9);
    expect(toLegacyShape({}).sort_order).toBe(0);
  });

  test("keywords 从 JSON 字符串解析成数组", () => {
    expect(toLegacyShape({ keywords: '["体检","费用"]' }).keywords).toEqual(["体检", "费用"]);
  });

  test("keywords 坏数据不炸，退化成空数组", () => {
    expect(parseKeywords("not-json")).toEqual([]);
    expect(parseKeywords("")).toEqual([]);
    expect(parseKeywords(null)).toEqual([]);
    expect(parseKeywords('{"a":1}')).toEqual([]);
    expect(parseKeywords(["已", "数组"])).toEqual(["已", "数组"]);
  });

  test("recruiter_id 恒为空串：新表没有招聘员维度，但字段必须在", () => {
    expect(toLegacyShape({ recruiter_id: "should-be-ignored" }).recruiter_id).toBe("");
  });

  test("缺字段时不产生 undefined，避免前端表格报错", () => {
    const out = toLegacyShape({});
    for (const value of Object.values(out)) {
      expect(value).not.toBeUndefined();
    }
  });
});

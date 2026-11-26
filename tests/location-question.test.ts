import { describe, expect, it } from "vitest";
import { asksForLocation } from "../src/modules/agent/agent-chat.routes.js";

/**
 * 客户问路时能不能拿到位置卡（2026-11-26）。
 *
 * 事故：客户问「我要导航 / 面试地点在哪」，服务端只是把文字发出去，
 * 网页端看到的也是纯文字，客户在企微里拿不到能点开导航的定位。
 * 原因有两层：① 这里的关键词只认「定位/地址/导航」，最常说的
 * 「面试地点」没命中；② 客户端 brain.py 没把 location_card 透传出去。
 * 这份用例盯住第①层，第②层在 backend/tests/test_brain_location_card.py。
 */
describe("asksForLocation", () => {
  it("matches the ways candidates actually ask for the address", () => {
    for (const question of [
      "我要导航",
      "面试地点在哪",
      "面试地址发我一下",
      "地址呢",
      "怎么过去",
      "怎么走啊",
      "公司在哪",
      "发个定位",
      "坐地铁怎么到",
      "到哪个站下，路线怎么走",
      "冠宇商务中心在哪里",
    ]) {
      expect(asksForLocation(question), question).toBe(true);
    }
  });

  it("does not fire on questions that merely contain 在哪", () => {
    for (const question of [
      "宿舍在哪里",
      "住宿在哪",
      "工资在哪里发",
      "食堂在哪",
      "待遇怎么样",
      "包吃住吗",
      "一天上几个小时",
    ]) {
      expect(asksForLocation(question), question).toBe(false);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

/**
 * 后台配置 → AI 回复 的两处断链回归：
 * 1) 城市识别：新增 GET /api/v1/agent/cities，让运营新建的城市能被念出来。
 * 2) 字段映射：后台表单写 base_sections，回复层读 wage_text/hours_text/welfare_text，
 *    中间必须有映射，否则表单建的岗位会被当成「空壳」丢掉。
 */
describe("agent jobs feed mapping", () => {
  let app: FastifyInstance;
  let token = "";
  const svc = { "x-profile-token": "svc-profile-token" };

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_PROFILE_TOKEN = "svc-profile-token";
    app = buildServer();
    await app.ready();
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
  });

  afterAll(async () => {
    delete process.env.REA_PROFILE_TOKEN;
    await app.close();
  });

  // 必须是函数：token 在 beforeAll 里才拿到，describe 阶段求值会固定成空串。
  const admin = () => ({ authorization: `Bearer ${token}` });

  it("serves the city list with districts and requires service auth", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/agent/cities" });
    expect(anonymous.statusCode).toBe(403);

    const res = await app.inject({ method: "GET", url: "/api/v1/agent/cities", headers: svc });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ city_name: "广州", districts: expect.arrayContaining(["番禺区"]) })]),
    );
    expect(body.total).toBe(body.items.length);

    // 停用的城市不该出现在识别清单里：识别到就会去查岗位，查不到又是「帮你问问」
    await app.inject({ method: "PATCH", url: "/api/v1/cities/2/status", headers: admin(), payload: { recruitment_status: "paused" } });
    const after = await app.inject({ method: "GET", url: "/api/v1/agent/cities", headers: svc });
    expect(after.json().items.map((c: { city_name: string }) => c.city_name)).not.toContain("深圳");
  });

  it("maps admin base_sections onto the fields the reply layer reads", async () => {
    const city = await app.inject({ method: "POST", url: "/api/v1/cities", headers: admin(), payload: { city_name: "北京", province: "北京" } });
    expect(city.statusCode).toBe(200);
    const cityId = city.json().id;
    const factory = await app.inject({ method: "POST", url: "/api/v1/factories", headers: admin(), payload: { factory_name: "北京示例厂", city_id: cityId } });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/service-positions",
      headers: admin(),
      payload: {
        position_name: "普工",
        city_id: cityId,
        factory_id: factory.json().id,
        is_active: true,
        age_range: "18-45 岁",
        base_sections: {
          salary_detail: "25 元/小时，月结",
          work_hours: "早八晚八，两班倒",
          meal_dorm: "包吃包住，4 人间",
        },
      },
    });
    expect(created.statusCode).toBe(200);

    const jobs = await app.inject({ method: "GET", url: "/api/v1/agent/jobs?city=北京", headers: svc });
    expect(jobs.statusCode).toBe(200);
    const items = jobs.json().items as Array<Record<string, string>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      factory_name: "北京示例厂",
      job_title: "普工",
      wage_text: "25 元/小时，月结",
      hours_text: "早八晚八，两班倒",
      welfare_text: "包吃包住，4 人间",
      age_text: "18-45 岁",
      city: "北京",
    });
  });

  it("keeps positions without a factory in the feed", async () => {
    const city = await app.inject({ method: "POST", url: "/api/v1/cities", headers: admin(), payload: { city_name: "测试孤儿城", province: "广东" } });
    await app.inject({
      method: "POST",
      url: "/api/v1/service-positions",
      headers: admin(),
      payload: { position_name: "未挂厂岗位", city_id: city.json().id, is_active: true, base_sections: { salary_detail: "20 元/小时" } },
    });
    const jobs = await app.inject({ method: "GET", url: "/api/v1/agent/jobs?city=测试孤儿城", headers: svc });
    const items = jobs.json().items as Array<Record<string, string>>;
    expect(items.map((j) => j.job_title)).toContain("未挂厂岗位");
  });

  it("matches backoffice knowledge so what operators type is actually used", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge",
      headers: admin(),
      payload: { question: "体检要自己出钱吗", answer: "体检费先自己垫，入职满一个月报销", keywords: ["体检"] },
    });
    expect(created.statusCode).toBe(200);

    const anonymous = await app.inject({ method: "GET", url: "/api/v1/agent/kb-match?text=体检要钱吗" });
    expect(anonymous.statusCode).toBe(403);

    const hit = await app.inject({ method: "GET", url: "/api/v1/agent/kb-match?text=体检要钱吗", headers: svc });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().hit).toMatchObject({ content: expect.stringContaining("体检费") });

    // 匹配不上的问法必须返回 null，不能随便塞一条
    const miss = await app.inject({ method: "GET", url: "/api/v1/agent/kb-match?text=今天天气怎么样", headers: svc });
    expect(miss.json().hit).toBeNull();
  });
});

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

  it("exposes city_links as neighbors and falls back to a neighbor when the city has no jobs", async () => {
    const neighborCity = await app.inject({ method: "POST", url: "/api/v1/cities", headers: admin(), payload: { city_name: "测试邻城甲", province: "广东" } });
    const emptyCity = await app.inject({ method: "POST", url: "/api/v1/cities", headers: admin(), payload: { city_name: "测试空城乙", province: "广东" } });
    const neighborId = neighborCity.json().id;
    const emptyId = emptyCity.json().id;

    const factory = await app.inject({ method: "POST", url: "/api/v1/factories", headers: admin(), payload: { factory_name: "邻城厂", city_id: neighborId } });
    await app.inject({
      method: "POST",
      url: "/api/v1/service-positions",
      headers: admin(),
      payload: { position_name: "邻城普工", city_id: neighborId, factory_id: factory.json().id, is_active: true, base_sections: { salary_detail: "22 元/小时" } },
    });

    // 后台「周边城市设置」：空城 → 邻城
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/city-links/batch",
      headers: admin(),
      payload: { city_id: emptyId, linked_city_ids: [neighborId] },
    });
    expect(saved.statusCode).toBe(201);

    const cities = await app.inject({ method: "GET", url: "/api/v1/agent/cities", headers: svc });
    const emptyEntry = (cities.json().items as Array<{ city_name: string; neighbors: string[] }>).find((c) => c.city_name === "测试空城乙");
    expect(emptyEntry?.neighbors).toEqual(["测试邻城甲"]);

    // 本城 0 岗位 → 自动取邻城，并在返回里标明 cross_city
    const jobs = await app.inject({ method: "GET", url: "/api/v1/agent/jobs?city=测试空城乙", headers: svc });
    const body = jobs.json();
    expect(body.cross_city).toBe("测试邻城甲");
    expect((body.items as Array<Record<string, string>>).map((j) => j.job_title)).toEqual(["邻城普工"]);
    expect(body.items[0].cross_city).toBe(true);
    expect(body.items[0].city).toBe("测试邻城甲");
  });

  it("reports the real position count in city-links options", async () => {
    // 岗位响应不带 city_id，直接用 /agent/jobs 按城市取条数作为基准
    const jobs = await app.inject({ method: "GET", url: "/api/v1/agent/jobs?city=广州", headers: svc });
    const enabled = (jobs.json().items as unknown[]).length;
    expect(enabled).toBeGreaterThan(0);

    const options = await app.inject({ method: "GET", url: "/api/v1/city-links/options", headers: admin() });
    const entry = (options.json().options as Array<{ city: string; count: number }>).find((o) => o.city === "广州");
    // 过去这列数的是 city_links 行数（重复行会把它放大），现在必须是真实在招岗位数
    expect(entry?.count).toBe(enabled);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("position interview materials from the admin form", () => {
  let app: FastifyInstance;
  let token: string;
  let cityId: number;
  let factoryId: number;
  const service = { "x-profile-token": "materials-profile-token" };
  const admin = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_PROFILE_TOKEN = "materials-profile-token";
    app = buildServer();
    await app.ready();
    token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
    cityId = (await app.inject({ method: "POST", url: "/api/v1/cities", headers: admin(), payload: { city_name: "材料核对城" } })).json().id;
    factoryId = (await app.inject({ method: "POST", url: "/api/v1/factories", headers: admin(), payload: { city_id: cityId, factory_name: "同厂不同基地" } })).json().id;
  });

  afterAll(async () => {
    delete process.env.REA_PROFILE_TOKEN;
    await app.close();
  });

  async function create(name: string, fields: Record<string, unknown>) {
    const response = await app.inject({ method: "POST", url: "/api/v1/service-positions", headers: admin(), payload: {
      position_name: name, city_id: cityId, factory_id: factoryId, is_active: true, ...fields,
    } });
    expect(response.statusCode).toBe(200);
    return response.json().id as number;
  }

  async function jobs() {
    const response = await app.inject({ method: "GET", url: "/api/v1/agent/jobs?city=材料核对城", headers: service });
    expect(response.statusCode).toBe(200);
    return response.json().items as Array<Record<string, unknown>>;
  }

  it("reads newly saved material fields from the form and keeps two bases separate", async () => {
    const a = await create("竹料材料测试", { base_sections: { salary_detail: "本岗工资", interview_notice: "原面试通知", cert_text: "待更新" } });
    const b = await create("陈村材料测试", { base_sections: { salary_detail: "另一岗位工资", cert_text: "身份证原件及本岗要求的复印件" } });
    const saved = await app.inject({ method: "PUT", url: `/api/v1/service-positions/${a}`, headers: admin(), payload: {
      position_name: "竹料材料测试", city_id: cityId, factory_id: factoryId, is_active: true,
      base_sections: { salary_detail: "本岗工资", interview_notice: "原面试通知", cert_text: "无犯罪证明+已体检即可" },
    } });
    expect(saved.statusCode).toBe(200);
    // 通过网页读回，再提交一次，模拟下一次只改其他字段的正常编辑。
    const read = (await app.inject({ method: "GET", url: `/api/v1/service-positions/${a}`, headers: admin() })).json();
    expect(read.base_sections.cert_text).toBe("无犯罪证明+已体检即可");
    expect((await app.inject({ method: "PUT", url: `/api/v1/service-positions/${a}`, headers: admin(), payload: read })).statusCode).toBe(200);
    const items = await jobs();
    expect(items.find((j) => j.position_id === a)).toMatchObject({ cert_text: "无犯罪证明+已体检即可", wage_text: "本岗工资" });
    expect(items.find((j) => j.position_id === b)).toMatchObject({ cert_text: "身份证原件及本岗要求的复印件", wage_text: "另一岗位工资" });
  });

  it("preserves explicit position materials over form fields", async () => {
    const id = await create("独立字段优先", { cert_text: "本岗正式材料", base_sections: { cert_text: "旧模板材料" } });
    expect((await jobs()).find((j) => j.position_id === id)?.cert_text).toBe("本岗正式材料");
  });

  it("leaves missing materials empty instead of parsing a notice or borrowing another base", async () => {
    const id = await create("材料待确认", { cert_text: "", base_sections: { cert_text: "", interview_notice: "携带资料：历史通知，尚未核对" } });
    expect((await jobs()).find((j) => j.position_id === id)?.cert_text).toBe("");
  });

  it.each([false, true])("keeps facts hidden from the form when saving materials (legacy nesting: %s)", async (nested) => {
    const facts = { wage_text: "原独立工资", line_text: "原线路", rest_text: "原月休", place: "原面试地点", medical_text: "原体检要求", base_sections: { salary_detail: "原工资模板" } };
    const id = await create(`原事实保留-${nested}`, nested ? { data_json: facts } : facts);
    const saved = await app.inject({ method: "PUT", url: `/api/v1/service-positions/${id}`, headers: admin(), payload: {
      position_name: `原事实保留-${nested}`, base_sections: { salary_detail: "原工资模板", cert_text: "本岗新材料" },
    } });
    expect(saved.statusCode).toBe(200);
    expect((await jobs()).find((j) => j.position_id === id)).toMatchObject({ wage_text: "原独立工资", line_text: "原线路", rest_text: "原月休", place: "原面试地点", medical_text: "原体检要求", cert_text: "本岗新材料" });
    // 明确清空有值字段必须生效，保留逻辑不能把旧值填回来。
    const read = saved.json();
    read.base_sections.cert_text = "";
    expect((await app.inject({ method: "PUT", url: `/api/v1/service-positions/${id}`, headers: admin(), payload: read })).statusCode).toBe(200);
    expect((await jobs()).find((j) => j.position_id === id)?.cert_text).toBe("");
  });
});

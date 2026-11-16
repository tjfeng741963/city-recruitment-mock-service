import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

/**
 * 设备 → 工厂「多选」绑定（契约：factory_ids 存在 agent_devices.data_json）。
 *
 * 一个微信号同时接几个厂的单是常态（同城 2~3 个厂），所以：
 * - 设备绑了厂 → 岗位/城市只出这些厂的，避免拿 A 厂的口径去说 B 厂；
 * - 没绑（或没传 device_code / 设备根本不存在）→ 原「按城市全量」逻辑不能变，
 *   否则客户端会因为没配厂而收不到任何岗位；
 * - 脏数据（重复 / 非整数 / 已删除的厂）一律忽略而不是整单 422。
 */
describe("device ↔ factories multi-binding", () => {
  let app: FastifyInstance;
  let token = "";
  const svc = { "x-profile-token": "svc-factory-binding" };

  const ids: { cityA: number; cityB: number; factoryA: number; factoryB: number; factoryC: number; factoryD: number } = {
    cityA: 0, cityB: 0, factoryA: 0, factoryB: 0, factoryC: 0, factoryD: 0,
  };

  const admin = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_PROFILE_TOKEN = "svc-factory-binding";
    app = buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
    token = login.json().access_token;

    const mkCity = async (cityName: string) => {
      const res = await app.inject({ method: "POST", url: "/api/v1/cities", headers: admin(), payload: { city_name: cityName, province: "广东" } });
      expect(res.statusCode).toBe(200);
      return Number(res.json().id);
    };
    const mkFactory = async (factoryName: string, cityId: number) => {
      const res = await app.inject({ method: "POST", url: "/api/v1/factories", headers: admin(), payload: { factory_name: factoryName, city_id: cityId } });
      expect(res.statusCode).toBe(200);
      return Number(res.json().id);
    };
    const mkJob = async (positionName: string, cityId: number, factoryId: number) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/service-positions",
        headers: admin(),
        payload: { position_name: positionName, city_id: cityId, factory_id: factoryId, is_active: true, base_sections: { salary_detail: "22 元/小时" } },
      });
      expect(res.statusCode).toBe(200);
    };

    ids.cityA = await mkCity("绑定测试城甲");
    ids.cityB = await mkCity("绑定测试城乙");
    ids.factoryA = await mkFactory("绑定甲厂", ids.cityA);
    ids.factoryB = await mkFactory("绑定乙厂", ids.cityA);
    ids.factoryC = await mkFactory("绑定丙厂", ids.cityA);
    ids.factoryD = await mkFactory("绑定丁厂", ids.cityB);
    await mkJob("甲厂普工", ids.cityA, ids.factoryA);
    await mkJob("乙厂普工", ids.cityA, ids.factoryB);
    await mkJob("丙厂普工", ids.cityA, ids.factoryC);
    await mkJob("丁厂普工", ids.cityB, ids.factoryD);
  });

  afterAll(async () => {
    delete process.env.REA_PROFILE_TOKEN;
    await app.close();
  });

  const createDevice = async (code: string) => {
    const res = await app.inject({ method: "POST", url: "/api/v1/agent/devices", headers: admin(), payload: { device_code: code, device_name: code } });
    expect(res.statusCode).toBe(200);
    return Number(res.json().id);
  };

  const bind = async (id: number, payload: Record<string, unknown>) => {
    const res = await app.inject({ method: "PUT", url: `/api/v1/agent/devices/${id}`, headers: admin(), payload });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.json().data_json) as Record<string, unknown>;
  };

  const jobFactories = async (city: string, deviceCode?: string) => {
    const url = `/api/v1/agent/jobs?city=${encodeURIComponent(city)}${deviceCode ? `&device_code=${encodeURIComponent(deviceCode)}` : ""}`;
    const res = await app.inject({ method: "GET", url, headers: svc });
    expect(res.statusCode).toBe(200);
    return (res.json().items as Array<{ factory_name: string }>).map((item) => item.factory_name);
  };

  // 岗位 SQL 没有 ORDER BY，只比集合不比顺序。
  const expectFactories = (actual: string[], expected: string[]) => {
    expect([...actual].sort()).toEqual([...expected].sort());
  };

  it("returns factory_ids and factories on the device list", async () => {
    const id = await createDevice("pc-bind-01");
    await bind(id, { factory_ids: [ids.factoryA, ids.factoryB] });
    const res = await app.inject({ method: "GET", url: "/api/v1/agent/devices", headers: admin() });
    expect(res.statusCode).toBe(200);
    const row = (res.json().items as Array<Record<string, unknown>>).find((item) => item.device_code === "pc-bind-01");
    expect(row).toMatchObject({
      factory_ids: [ids.factoryA, ids.factoryB],
      factories: [
        { id: ids.factoryA, name: "绑定甲厂", city_name: "绑定测试城甲" },
        { id: ids.factoryB, name: "绑定乙厂", city_name: "绑定测试城甲" },
      ],
    });
  });

  it("filters jobs down to the bound factories only", async () => {
    const id = await createDevice("pc-bind-02");
    await bind(id, { factory_ids: [ids.factoryA, ids.factoryB] });
    // 同城三个厂都有岗，绑了两个 → 只该出这两个
    expectFactories(await jobFactories("绑定测试城甲", "pc-bind-02"), ["绑定甲厂", "绑定乙厂"]);
  });

  it("keeps the city-wide feed when the device binds no factory", async () => {
    const id = await createDevice("pc-bind-03");
    await bind(id, { factory_ids: [] });
    expectFactories(await jobFactories("绑定测试城甲", "pc-bind-03"), ["绑定甲厂", "绑定乙厂", "绑定丙厂"]);
  });

  it("keeps the city-wide feed for an unknown device_code / no device_code", async () => {
    expect(await jobFactories("绑定测试城甲", "pc-does-not-exist")).toHaveLength(3);
    expect(await jobFactories("绑定测试城甲")).toHaveLength(3);
  });

  it("drops duplicate, non-integer and unknown factory ids instead of failing the request", async () => {
    const id = await createDevice("pc-bind-04");
    // 1.5 / "abc" / null 不是整数，999999 库里没有，重复项只留一份
    const data = await bind(id, { factory_ids: [ids.factoryA, ids.factoryA, 1.5, "abc", null, 999999, String(ids.factoryA)] });
    expect(data.factory_ids).toEqual([ids.factoryA]);
    expectFactories(await jobFactories("绑定测试城甲", "pc-bind-04"), ["绑定甲厂"]);
  });

  it("accepts an empty array as 'bound to nothing' after having factories", async () => {
    const id = await createDevice("pc-bind-05");
    await bind(id, { factory_ids: [ids.factoryA, ids.factoryB] });
    await bind(id, { factory_ids: [] });
    expect(await jobFactories("绑定测试城甲", "pc-bind-05")).toHaveLength(3);
  });

  it("narrows the city list to the bound factories' cities", async () => {
    const bound = await createDevice("pc-bind-06");
    await bind(bound, { factory_ids: [ids.factoryA, ids.factoryB] });
    const narrowed = await app.inject({ method: "GET", url: "/api/v1/agent/cities?device_code=pc-bind-06", headers: svc });
    expect(narrowed.statusCode).toBe(200);
    expect(narrowed.json().items.map((item: { city_name: string }) => item.city_name)).toEqual(["绑定测试城甲"]);

    const free = await createDevice("pc-bind-07");
    await bind(free, { factory_ids: [] });
    const full = await app.inject({ method: "GET", url: "/api/v1/agent/cities?device_code=pc-bind-07", headers: svc });
    const names = full.json().items.map((item: { city_name: string }) => item.city_name);
    expect(names).toContain("绑定测试城甲");
    expect(names).toContain("绑定测试城乙");
  });

  it("exposes factory_ids/factories in the config feed and zeroes employer_id for multiple factories", async () => {
    const id = await createDevice("pc-bind-08");
    await bind(id, { factory_ids: [ids.factoryA, ids.factoryD], factory_name: "绑定甲厂" });
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-bind-08/pair", headers: admin() });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bridge/devices/pc-bind-08/config",
      headers: { authorization: `Bearer ${pair.json().device_token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.factory_ids).toEqual([ids.factoryA, ids.factoryD]);
    expect(body.factories).toEqual([{ id: ids.factoryA, name: "绑定甲厂" }, { id: ids.factoryD, name: "绑定丁厂" }]);
    // 多厂且没显式配 employer_id：宁可回 0 走 global，也不拿甲厂的 KB 去答丁厂的客户
    expect(body.employer_id).toBe(0);
  });

  it("still resolves employer_id from factory_name for a single-factory device", async () => {
    const verticalId = (app.db.prepare("SELECT id FROM vertical WHERE code='factory'").get() as { id: number }).id;
    app.db.prepare("INSERT INTO employer(tenant_id,vertical_id,employer_code,display_name,short_name) VALUES (1,?,?,?,?)")
      .run(verticalId, "TEST-BIND-001", "绑定丙厂", "丙厂");
    const employerId = Number((app.db.prepare("SELECT id FROM employer WHERE employer_code='TEST-BIND-001'").get() as { id: number }).id);

    const id = await createDevice("pc-bind-09");
    await bind(id, { factory_ids: [ids.factoryC], factory_name: "绑定丙厂" });
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/pc-bind-09/pair", headers: admin() });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bridge/devices/pc-bind-09/config",
      headers: { authorization: `Bearer ${pair.json().device_token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ factory_ids: [ids.factoryC], employer_id: employerId });
  });
});

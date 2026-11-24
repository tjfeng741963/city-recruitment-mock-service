import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("岗位收藏位置卡与接待预览", () => {
  let server: ReturnType<typeof buildServer>;
  let headers: { authorization: string };
  let positionId: number;
  let cityId: number;

  beforeAll(async () => {
    const previous = process.env.REA_DATABASE_PATH;
    process.env.REA_DATABASE_PATH = ":memory:";
    try { server = buildServer(); }
    finally {
      if (previous === undefined) delete process.env.REA_DATABASE_PATH;
      else process.env.REA_DATABASE_PATH = previous;
    }
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: {
      username: "local-admin", password: "local-demo-only",
    } });
    expect(login.statusCode).toBe(200);
    headers = { authorization: `Bearer ${login.json().access_token}` };
    const city = await server.inject({ method: "POST", url: "/api/v1/cities", headers, payload: { city_name: "验收市" } });
    cityId = city.json().id;
    const position = await server.inject({ method: "POST", url: "/api/v1/service-positions", headers, payload: {
      city_id: cityId, position_name: "验收岗位", interview_points: [
        { name: "南门面试点", address: "南路1号", favorite_title: "  广汽本田龙华店  ", favorite_delay_ms: 2500 },
        { name: "北门面试点", address: "北路2号" },
      ],
    } });
    expect(position.statusCode).toBe(200);
    positionId = position.json().id;
  });

  afterAll(async () => { await server?.close(); });

  async function preview(engine: "agent" | "dify", text: string) {
    const response = await server.inject({
      method: "POST", headers, url: engine === "agent" ? "/api/v1/agent/chat" : "/api/v1/dify/preview",
      payload: { position_id: positionId, dry: true, text },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it("岗位保存后可读回规范化名称，两个引擎只返回预览结果", async () => {
    const read = await server.inject({ url: `/api/v1/service-positions/${positionId}`, headers });
    expect(read.json().interview_points[0].favorite_title).toBe("广汽本田龙华店");
    for (const engine of ["agent", "dify"] as const) {
      const result = await preview(engine, "发一下南门面试点的定位");
      expect(result.favorite_location_preview).toEqual({
        status: "windows_unavailable", point_name: "南门面试点", favorite_title: "广汽本田龙华店",
        ...(engine === "dify" && { trigger: "navigation_requested", after_address_delay_ms: 2500 }),
      });
      expect(result).not.toHaveProperty("action_id");
      if (engine === "dify") expect(result.inputs.position_data).not.toContain("广汽本田龙华店");
      else expect(JSON.stringify(result.messages)).not.toContain("广汽本田龙华店");
    }
  });

  it("多个点先提示选择，明确选中未绑定的点时不会用其他点的卡", async () => {
    for (const engine of ["agent", "dify"] as const) {
      expect((await preview(engine, "发个定位")).favorite_location_preview).toEqual({
        status: "needs_point", point_names: ["南门面试点", "北门面试点"],
      });
      expect((await preview(engine, "给我北门面试点的定位")).favorite_location_preview).toEqual({
        status: "not_configured", point_name: "北门面试点",
      });
      expect((await preview(engine, "不要发定位")).favorite_location_preview).toBeUndefined();
      expect((await preview(engine, "发个宿舍定位")).favorite_location_preview).toBeUndefined();
      expect((await preview(engine, "工资多少")).favorite_location_preview).toBeUndefined();
    }
  });

  it("保存画布的位置卡顺序和等待时间，旧客户端仍只收到可执行的消息", async () => {
    const paired = await server.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/pair", headers });
    expect(paired.statusCode).toBe(200);
    server.db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.position_id',?,'$.agent_position_id',?) WHERE json_extract(data_json,'$.device_code')=?")
      .run(positionId, positionId, "local-device-001");
    const flow = {
      position_id: positionId, status: "enabled", entry_key: "send_info",
      nodes: [{ node_key: "send_info", node_type: "text", parts: [
        { kind: "text", body: "面试地点在南门。", delay_ms: 1200 },
        { kind: "favorite_location", interview_point: "南门面试点", delay_before_ms: 3500, delay_ms: 0 },
        { kind: "text", body: "到了请联系我。", delay_ms: 500 },
      ] }],
      edges: [{ from_key: "send_info", to_key: "", trigger: "default" }],
    };
    const request = { method: "PUT" as const, url: "/api/v1/agent-flow", headers };
    const saved = await server.inject({ ...request, payload: flow });
    expect(saved.statusCode).toBe(200);
    const adminRead = await server.inject({ url: `/api/v1/agent-flow?position_id=${positionId}`, headers });
    expect(adminRead.json().nodes[0].parts).toMatchObject(flow.nodes[0].parts);
    const runtime = await server.inject({ url: "/api/v1/agent/flow?device_code=local-device-001", headers: {
      authorization: `Bearer ${paired.json().device_token}`,
    } });
    expect(runtime.json().nodes[0].parts).toMatchObject([flow.nodes[0].parts[0], flow.nodes[0].parts[2]]);

    for (const point of ["北门面试点", "另一岗位面试点"]) {
      const parts = [flow.nodes[0].parts[0], { ...flow.nodes[0].parts[1], interview_point: point }];
      expect((await server.inject({ ...request, payload: { ...flow, nodes: [{ ...flow.nodes[0], parts }] } })).statusCode).toBe(422);
    }
    const onlyLocation = { ...flow, nodes: [{ ...flow.nodes[0], parts: [flow.nodes[0].parts[1]] }] };
    expect((await server.inject({ ...request, payload: onlyLocation })).statusCode).toBe(422);
    expect((await server.inject({ ...request, payload: { ...onlyLocation, status: "disabled" } })).statusCode).toBe(200);
  });

  it("拒绝无效标题并允许关闭绑定，旧面试点格式仍能保存", async () => {
    const url = `/api/v1/service-positions/${positionId}`;
    const invalid = await server.inject({ url, method: "PUT", headers, payload: {
      interview_points: [{ name: "南门面试点", favorite_title: "有\n换行" }],
    } });
    expect(invalid.statusCode).toBe(422);
    const cleared = await server.inject({ url, method: "PUT", headers, payload: {
      interview_points: [{ name: "南门面试点", address: "南路1号", favorite_title: "   " }, "北门面试点"],
    } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().interview_points).toEqual([{ name: "南门面试点", address: "南路1号" }, "北门面试点"]);
    expect((await preview("agent", "发一下南门面试点的定位")).favorite_location_preview).toEqual({
      status: "not_configured", point_name: "南门面试点",
    });
  });
});

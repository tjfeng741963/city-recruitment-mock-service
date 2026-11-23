import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { buildArchiveNoticeLine } from "../src/modules/agent/archive-notify.js";

// 面试登记备注（remark）与群通知一行文案。
//
// 需求（2026-11-23）：有人答应面试就往群里发**一条**，
// 姓名后面紧跟客户微信名称（备注优先），再是手机 / 工厂 / 岗位 / 日期 / 时间 / 面试点。
describe("面试登记备注与群通知", () => {
  const app = (() => {
    process.env.REA_DATABASE_PATH = ":memory:";
    return buildServer();
  })();
  let headers: Record<string, string>;

  const setGroupChat = (value: string) => {
    const row = app.db
      .prepare("SELECT id, data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')='local-device-001'")
      .get() as { id: number; data_json: string } | undefined;
    if (!row) throw new Error("seed device missing");
    const data = { ...(JSON.parse(row.data_json || "{}") as Record<string, unknown>), group_chat: value };
    app.db.prepare("UPDATE agent_devices SET data_json=? WHERE id=?").run(JSON.stringify(data), row.id);
  };

  beforeAll(async () => {
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    headers = { authorization: `Bearer ${res.json().access_token}` };
    setGroupChat("面试通知群");
  });
  afterAll(() => app.close());

  it("一行文案：姓名 备注 手机 工厂 岗位 日期 时间 面试点", () => {
    const line = buildArchiveNoticeLine(app.db, {
      name: "张三",
      remark: "微信名字",
      nickname: "不该出现的昵称",
      phone: "13800138000",
      positionId: 1,
      interviewDate: "2026-11-24",
      interviewTime: "09:00",
      place: "龙华面试点",
    });
    // 种子数据里岗位 1 = 本地示例岗位 / 工厂 = 本地示例工厂
    expect(line).toBe("张三 微信名字 13800138000 本地示例工厂 本地示例岗位 11/24 09:00 龙华面试点");
  });

  it("没填备注就用客户企微昵称，缺项自动省略", () => {
    const withNickname = buildArchiveNoticeLine(app.db, {
      name: "张三",
      nickname: "阿三",
      phone: "13800138000",
      interviewDate: "2026-11-24",
      interviewTime: "09:00",
    });
    expect(withNickname).toBe("张三 阿三 13800138000 11/24 09:00");
    const onlyName = buildArchiveNoticeLine(app.db, { name: "张三", phone: "", interviewDate: "", interviewTime: "" });
    expect(onlyName).toBe("张三");
  });

  it("手动登记带备注：落库并在群指令里发一行", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/archive/manual",
      headers,
      payload: {
        name: "李四",
        phone: "13900139000",
        remark: "微信名叫小李",
        position_id: 1,
        interview_date: "2026-11-25",
        interview_time: "14:00",
        city: "深圳",
        device_code: "local-device-001",
      },
    });
    expect(res.statusCode).toBe(200);
    const key = res.json().session_key as string;
    const archive = app.db.prepare("SELECT remark FROM agent_archive WHERE session_key=?").get(key) as { remark: string };
    expect(archive.remark).toBe("微信名叫小李");
    const command = app.db
      .prepare("SELECT content FROM bridge_commands WHERE device_code='local-device-001' AND idempotency_key=?")
      .get(`group-notify:${key}`) as { content: string } | undefined;
    expect(command?.content).toBe("李四 微信名叫小李 13900139000 本地示例工厂 本地示例岗位 11/25 14:00");
  });

  it("备注可以改，清单里读得到", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/archive/manual",
      headers,
      payload: { name: "王五", phone: "13700137000", interview_date: "2026-11-26", interview_time: "10:00" },
    });
    const key = res.json().session_key as string;
    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/agent/archive/${encodeURIComponent(key)}/remark`,
      headers,
      payload: { remark: "客户昵称是广告词，改叫王师傅" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ ok: true, remark: "客户昵称是广告词，改叫王师傅" });
    const list = (await app.inject({ url: "/api/v1/agent/archive/list", headers })).json().items as Array<Record<string, unknown>>;
    expect(list.find((row) => row.session_key === key)).toMatchObject({ remark: "客户昵称是广告词，改叫王师傅" });
    const missing = await app.inject({ method: "PUT", url: "/api/v1/agent/archive/nope/remark", headers, payload: { remark: "x" } });
    expect(missing.statusCode).toBe(404);
  });
});

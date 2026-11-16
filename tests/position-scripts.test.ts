import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

/**
 * 按岗位配置话术（迁移 030）的四端契约回归：
 * - POST 是同 (position_id, stage) 覆盖，不是新增；
 * - GET ?position_id= 只回该岗位；
 * - /bridge/devices/:code/config 只下发绑定工厂的岗位话术；
 * - /agent/jobs 透出 media 且丢弃库里不存在的资源。
 *
 * 夹具（REA_SEED_FIXTURES=1）：岗位 1 = 本地示例岗位（工厂 1，广州），
 * 岗位 2 = 示例产线岗位（工厂 2，深圳）。
 */

// 1x1 透明 PNG：用真实图片字节，顺带验证 sha256 与 Content-Type
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("position scripts", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let svc: Record<string, string>;
  let mediaRoot = "";
  const saved = { ...process.env };

  beforeAll(async () => {
    mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rea-position-scripts-"));
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MEDIA_DIR = mediaRoot;
    process.env.REA_PROFILE_TOKEN = "svc-profile-token";
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    svc = { "x-profile-token": "svc-profile-token" };
  });

  afterAll(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MEDIA_DIR", "REA_PROFILE_TOKEN"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    if (mediaRoot) fs.rmSync(mediaRoot, { recursive: true, force: true });
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/v1/position-scripts", headers: admin, payload });
  const upload = (name: string, kind = "image") =>
    app.inject({ method: "POST", url: "/api/v1/media", headers: admin, payload: { name, kind, data_base64: PNG_BASE64 } });
  const configOf = async (code: string) => {
    const pair = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${code}/pair`, headers: admin });
    expect(pair.statusCode).toBe(200);
    return app.inject({
      method: "GET", url: `/api/v1/bridge/devices/${code}/config`,
      headers: { authorization: `Bearer ${pair.json().device_token}` },
    });
  };

  it("upserts the same (position_id, stage) instead of inserting a second row", async () => {
    const first = await post({ position_id: 1, stage: "greet", title: "v1", content: "你好 {{factory}}" });
    expect(first.statusCode).toBe(200);
    const id = first.json().id;
    expect(id).toBeGreaterThan(0);
    expect(first.json()).toMatchObject({ position_id: 1, stage: "greet", status: "enabled", media: [] });

    const second = await post({
      position_id: 1, stage: "greet", title: "v2", content: "您好，{{factory}} 在招 {{job_title}}",
      media: [{ name: "厂门.png", kind: "image" }],
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(id);
    expect(app.db.prepare("SELECT COUNT(*) n FROM position_scripts WHERE position_id=1 AND stage='greet'").get())
      .toMatchObject({ n: 1 });
    expect(app.db.prepare("SELECT title,content FROM position_scripts WHERE id=?").get(id))
      .toMatchObject({ title: "v2", content: "您好，{{factory}} 在招 {{job_title}}" });
    // 对外 media 必须是数组（不是 JSON 字符串）：后台可看到「配了但没传文件」的名字
    expect(second.json().media).toEqual([{ name: "厂门.png", kind: "image" }]);

    // 非法 stage / 不存在的岗位必须 422，不能落脏行
    expect((await post({ position_id: 1, stage: "bogus", content: "x" })).statusCode).toBe(422);
    expect((await post({ position_id: 99999, stage: "greet", content: "x" })).statusCode).toBe(422);
    expect((await post({ stage: "greet", content: "x" })).statusCode).toBe(422);
  });

  it("lists scripts filtered by position_id", async () => {
    await post({ position_id: 2, stage: "send_info", title: "深圳岗", content: "深圳的岗位" });
    const onlyOne = await app.inject({ method: "GET", url: "/api/v1/position-scripts?position_id=1", headers: admin });
    expect(onlyOne.statusCode).toBe(200);
    expect(onlyOne.json().items).toHaveLength(1);
    expect(onlyOne.json().items[0]).toMatchObject({ position_id: 1, stage: "greet" });
    // media 是数组而不是字符串
    expect(Array.isArray(onlyOne.json().items[0].media)).toBe(true);

    const all = await app.inject({ method: "GET", url: "/api/v1/position-scripts", headers: admin });
    expect(all.json().items.map((item: { position_id: number }) => item.position_id).sort()).toEqual([1, 2]);
    expect(all.json().total).toBe(2);

    // 非管理员读不到配置
    expect((await app.inject({ method: "GET", url: "/api/v1/position-scripts" })).statusCode).toBe(403);
  });

  it("only distributes scripts of the device's bound factories and resolves media", async () => {
    const uploaded = await upload("厂门.png");
    expect(uploaded.statusCode).toBe(200);
    const sha256 = uploaded.json().sha256 as string;

    // 岗位 1（工厂 1）：启用的 greet + 停用的 send_info；媒体含一个不存在的名字
    await post({
      position_id: 1, stage: "greet", title: "广州岗问候", content: "你好 {{factory}}",
      media: [{ name: "厂门.png", kind: "image" }, { name: "不存在.png", kind: "image" }],
    });
    await post({ position_id: 1, stage: "send_info", title: "停用话术", content: "不该下发", status: "disabled" });
    // 岗位 2（工厂 2）
    await post({ position_id: 2, stage: "greet", title: "深圳岗问候", content: "深圳你好" });

    // 只绑工厂 1 的设备：只能看到岗位 1 的 enabled 话术
    app.db.prepare("UPDATE agent_devices SET data_json=? WHERE json_extract(data_json,'$.device_code')='local-device-001'")
      .run(JSON.stringify({ device_code: "local-device-001", factory_ids: [1] }));
    const bound = await configOf("local-device-001");
    expect(bound.statusCode).toBe(200);
    const boundScripts = bound.json().position_scripts as Array<Record<string, unknown>>;
    expect(boundScripts).toHaveLength(1);
    expect(boundScripts[0]).toMatchObject({
      position_id: 1, stage: "greet", title: "广州岗问候", content: "你好 {{factory}}",
    });
    // 查不到的资源被丢弃，查到的补 sha256
    expect(boundScripts[0].media).toEqual([{ name: "厂门.png", kind: "image", sha256 }]);

    // 没绑厂的设备：全部 enabled 话术（停用的仍然不下发）
    const created = await app.inject({
      method: "POST", url: "/api/v1/agent/devices", headers: admin,
      payload: { device_code: "dev-no-factory", device_name: "未绑厂设备" },
    });
    expect(created.statusCode).toBe(200);
    const unbound = await configOf("dev-no-factory");
    const unboundScripts = unbound.json().position_scripts as Array<Record<string, unknown>>;
    // 夹具里岗位 1 有 greet/send_info，岗位 2 有 greet/send_info（上一条用例建的）
    expect(unboundScripts.map((item) => `${item.position_id}:${item.stage}`).sort())
      .toEqual(["1:greet", "2:greet", "2:send_info"]);
    expect(unboundScripts.some((item) => item.title === "停用话术")).toBe(false);
  });

  it("exposes media on /agent/jobs and drops assets that do not exist", async () => {
    const uploaded = await upload("岗位图.png");
    const sha256 = uploaded.json().sha256 as string;
    app.db.prepare("UPDATE service_positions SET data_json=? WHERE id=1").run(JSON.stringify({
      media: [
        { name: "岗位图.png", kind: "image" },
        { name: "已删除的图.png", kind: "image" },
      ],
    }));

    const res = await app.inject({
      method: "GET", url: "/api/v1/agent/jobs?city=%E5%B9%BF%E5%B7%9E", headers: svc,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    const job = items.find((item) => item.position_id === 1);
    expect(job).toBeTruthy();
    expect(job?.media).toEqual([{ name: "岗位图.png", kind: "image", sha256 }]);

    // 没配媒体的岗位：空数组，绝不 undefined
    const other = items.find((item) => item.position_id !== 1);
    if (other) expect(other.media).toEqual([]);
  });

  it("saves, reads, updates and disables the general welcome without creating duplicate rows", async () => {
    const content = "你好，欢迎咨询招聘岗位。\n---\n我先帮你了解一下。\n---\n请问你现在在哪个城市？";
    const first = await post({ position_id: 0, stage: "greet", title: "测试欢迎语", content });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ position_id: 0, stage: "greet", content, status: "enabled" });
    const read = await app.inject({ method: "GET", url: "/api/v1/position-scripts?position_id=0", headers: admin });
    expect(read.statusCode).toBe(200);
    expect(read.json().items).toHaveLength(1);
    expect(read.json().items[0].content).toBe(content);

    const config = await configOf("local-device-001");
    expect(config.json().position_scripts).toEqual(expect.arrayContaining([
      expect.objectContaining({ position_id: 0, stage: "greet", content }),
    ]));
    const updated = await post({ position_id: 0, stage: "greet", content: "新版欢迎语", status: "disabled" });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().id).toBe(first.json().id);
    expect((await configOf("local-device-001")).json().position_scripts.some((row: { position_id: number }) => row.position_id === 0)).toBe(false);
    const reread = await app.inject({ method: "GET", url: "/api/v1/position-scripts?position_id=0", headers: admin });
    expect(reread.json().items).toHaveLength(1);
    expect(reread.json().items[0]).toMatchObject({ content: "新版欢迎语", status: "disabled" });
  });

  it("restricts the general entry to explicit zero, welcome stage and nonblank enabled text", async () => {
    for (const position_id of [null, false, "", -1, 0.5]) {
      expect((await post({ position_id, stage: "greet", content: "欢迎" })).statusCode).toBe(422);
    }
    expect((await post({ position_id: 0, stage: "booked", content: "不能配置通用面试承诺" })).statusCode).toBe(422);
    expect((await post({ position_id: 0, stage: "greet", content: "\n---\n " })).statusCode).toBe(422);
    const denied = await app.inject({ method: "POST", url: "/api/v1/position-scripts", payload: { position_id: 0, stage: "greet", content: "欢迎" } });
    expect(denied.statusCode).toBe(403);
  });
});

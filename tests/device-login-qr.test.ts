import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 企微登录二维码：设备在云端掉登录时，客户端截下扫码窗传上来，用户在网页上扫。
//
// 这条链路有三个必须成立的约束：
// 1. 上传只认设备自己的桥接令牌 —— 二维码等同于登录凭证，拿到就能顶替账号登录；
// 2. 每个设备只留最新一张 —— 二维码两分钟就过期，留历史帧只会撑爆库；
// 3. 网页读取走用户鉴权 —— 不是公开接口。
describe("device login QR relay", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;
  const saved = { ...process.env };
  const CODE = "local-device-001";

  // 1x1 PNG，够验证"存进去再取出来字节没变"，不必真截屏
  const TINY_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const SECOND_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const pair = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${CODE}/pair`, headers: admin });
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const upload = (payload: Record<string, unknown>, headers?: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: `/api/v1/bridge/devices/${CODE}/login-qr`,
      ...(headers ? { headers } : { headers: device }),
      payload,
    });
  const read = (code: string = CODE, headers?: Record<string, string>) =>
    app.inject({
      method: "GET",
      url: `/api/v1/agent/devices/${code}/login-qr`,
      ...(headers ? { headers } : { headers: admin }),
    });

  it("returns unavailable before the device uploads anything", async () => {
    const res = await read();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, login_status: "waiting_for_qr" });
  });

  it("stores the image and serves it back as a data URL", async () => {
    const put = await upload({
      image_b64: TINY_PNG,
      width: 228,
      height: 312,
      captured_at: "2026-11-15T10:05:00+08:00",
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ok: true });

    const body = (await read()).json();
    expect(body.available).toBe(true);
    expect(body.image).toBe(`data:image/png;base64,${TINY_PNG}`);
    expect(body.width).toBe(228);
    expect(body.height).toBe(312);
    expect(body.captured_at).toBe("2026-11-15T10:05:00+08:00");
  });

  it("keeps only the latest frame per device", async () => {
    await upload({ image_b64: TINY_PNG, width: 1, height: 1, captured_at: "2026-11-15T10:00:00+08:00" });
    await upload({ image_b64: SECOND_PNG, width: 2, height: 2, captured_at: "2026-11-15T10:01:00+08:00" });

    const body = (await read()).json();
    expect(body.image).toBe(`data:image/png;base64,${SECOND_PNG}`);
    expect(body.width).toBe(2);
    expect(body.captured_at).toBe("2026-11-15T10:01:00+08:00");
  });

  it("rejects uploads without a valid device token", async () => {
    const wrong = await upload({ image_b64: TINY_PNG, width: 1, height: 1 }, { authorization: "Bearer wrong-token" });
    expect(wrong.statusCode).toBe(401);
    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/bridge/devices/${CODE}/login-qr`,
      payload: { image_b64: TINY_PNG },
    });
    expect(missing.statusCode).toBe(401);
  });

  it("rejects an empty or oversized image", async () => {
    const empty = await upload({ image_b64: "", width: 1, height: 1 });
    expect(empty.statusCode).toBe(422);

    // 超 2MB 说明客户端传的是整屏截图或原始位图，不该进库。
    // 注意：这么大的 body 在到达路由前就被 Fastify 的 bodyLimit 挡成 413，
    // 路由里那道 422 只是第二道兜底（bodyLimit 调大时才会走到）。
    const huge = await upload({ image_b64: "A".repeat(2_000_001), width: 1, height: 1 });
    expect([413, 422]).toContain(huge.statusCode);
    // 无论哪一道挡的，都不能真的写进库
    expect((await read()).json()).toEqual({ available: false, login_status: "waiting_for_qr" });
  });

  it("clears the stored frame when the device reports recovery", async () => {
    await upload({ image_b64: TINY_PNG, width: 1, height: 1, captured_at: "2026-11-15T10:00:00+08:00" });
    expect((await read()).json().available).toBe(true);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/bridge/devices/${CODE}/login-qr`,
      headers: device,
    });
    expect(del.statusCode).toBe(200);
    expect((await read()).json()).toEqual({ available: false, login_status: "waiting_for_qr" });
  });

  it("confirms login after the device clears the frame and reports a fresh heartbeat", async () => {
    await upload({ image_b64: TINY_PNG, width: 1, height: 1 });
    const heartbeat = await app.inject({
      method: "POST", url: "/api/v1/bridge/devices/" + CODE + "/heartbeat",
      headers: device, payload: { state: "online", account_id: "fixture" },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect((await read()).json()).toMatchObject({ available: true, login_status: "waiting_for_scan" });
    const clear = await app.inject({ method: "DELETE", url: "/api/v1/bridge/devices/" + CODE + "/login-qr", headers: device });
    expect(clear.statusCode).toBe(200);
    expect((await read()).json()).toEqual({ available: false, login_status: "logged_in" });
  });

  it("does not claim success from an expired heartbeat or return an expired frame", async () => {
    await upload({ image_b64: TINY_PNG, width: 1, height: 1 });
    app.db.prepare("UPDATE bridge_devices SET state='online',heartbeat_at=? WHERE device_code=?").run(Date.now() - 61000, CODE);
    app.db.prepare("UPDATE device_login_qr SET updated_at='2020-01-01 00:00:00' WHERE device_code=?").run(CODE);
    expect((await read()).json()).toEqual({ available: false, login_status: "disconnected" });
  });

  it("distinguishes waiting for a QR from a stale one while Win still needs login", async () => {
    await app.inject({
      method: "POST", url: "/api/v1/bridge/devices/" + CODE + "/heartbeat",
      headers: device, payload: { state: "scanning" },
    });
    expect((await read()).json()).toEqual({ available: false, login_status: "waiting_for_qr" });
    await upload({ image_b64: TINY_PNG, width: 1, height: 1 });
    app.db.prepare("UPDATE device_login_qr SET updated_at='2020-01-01 00:00:00' WHERE device_code=?").run(CODE);
    expect((await read()).json()).toEqual({ available: false, login_status: "qr_expired" });
  });
  it("requires user authentication to read", async () => {
    await upload({ image_b64: TINY_PNG, width: 1, height: 1, captured_at: "2026-11-15T10:00:00+08:00" });
    // 带 header 鉴权的路由由 preHandler 统一拦：没有 token 回 403（不是 401）,
    // 与 /api/v1/agent/devices 其他接口一致。
    const anonymous = await app.inject({ method: "GET", url: `/api/v1/agent/devices/${CODE}/login-qr` });
    expect([401, 403]).toContain(anonymous.statusCode);
    expect(anonymous.json()).not.toHaveProperty("image");
  });
});

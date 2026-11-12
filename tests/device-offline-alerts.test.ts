import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { DeviceBridgeStore } from "../src/modules/messaging/device-bridge.js";
import { createStreamNotifier, EventBus, type StreamEvent, type StreamNotifier } from "../src/modules/messaging/stream-events.js";

/**
 * 掉线提醒链路（契约：掉线提醒与历史补录）：
 * - heartbeat 状态变化落 device_events(reason='reported') 并推 device.updated
 * - sweepStale 把 60s 无心跳的在线设备翻成 offline，恰好落一条 heartbeat_timeout
 * - device.updated 对 offline/scanning 做 5 分钟节流（基准在 DB，重启不丢）
 * - device_code=all 全局订阅仅 admin
 */

interface StreamHandle { close: () => void; state: { text: string } }

/** 只录事件的假总线：节流逻辑在 notifier 内部，这里只看它最终广播了什么。 */
function recordingBus(frames: StreamEvent[]): EventBus {
  return { publish: (_code: string, event: StreamEvent) => { frames.push(event); return 1; } } as unknown as EventBus;
}

describe("device offline alerts", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  const saved = { ...process.env };
  const CODE = "local-device-001";
  const deviceTokens: Record<string, string> = {};
  const streams: StreamHandle[] = [];

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    const pair = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${CODE}/pair`, headers: admin });
    expect(pair.statusCode).toBe(200);
    deviceTokens[CODE] = pair.json().device_token;
  });

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const heartbeat = (code: string, state: string) => app.inject({
    method: "POST", url: `/api/v1/bridge/devices/${code}/heartbeat`,
    headers: { authorization: `Bearer ${deviceTokens[code]}` },
    // 契约校验：online 必须带 account_id，其余状态可省略
    payload: state === "online" ? { state, account_id: "wx-owner" } : { state },
  });

  describe("heartbeat sweeper", () => {
    it("flips a stale online device exactly once: one event, one push; a repeat sweep is a no-op", () => {
      let now = Date.now();
      const pushes: Array<{ code: string; state: string; reason?: string }> = [];
      const spy: StreamNotifier = {
        messageCreated: () => {},
        commandUpdated: () => {},
        deviceUpdated: (code, state, reason) => pushes.push({ code, state, reason }),
      };
      const store = new DeviceBridgeStore(app.db, () => now, spy);
      store.heartbeat(CODE, "online", "wx-owner");
      expect(pushes).toEqual([{ code: CODE, state: "online", reason: "reported" }]);

      now += 90_000; // heartbeat_at 停在 T，已超过 60s 阈值
      const swept = store.sweepStale();
      expect(swept).toEqual([CODE]);
      // server.ts 定时器的行为：扫到的设备逐个推送
      for (const code of swept) spy.deviceUpdated(code, "offline", "heartbeat_timeout");

      expect(store.status(CODE)).toMatchObject({ state: "offline" });
      const offlineEvents = app.db.prepare("SELECT device_code,event_type,reason FROM device_events WHERE event_type='offline'").all();
      expect(offlineEvents).toEqual([{ device_code: CODE, event_type: "offline", reason: "heartbeat_timeout" }]);
      expect(pushes).toEqual([
        { code: CODE, state: "online", reason: "reported" },
        { code: CODE, state: "offline", reason: "heartbeat_timeout" },
      ]);

      // 重复扫描：条件 UPDATE rowcount=0 → 无事件、无推送
      expect(store.sweepStale()).toEqual([]);
      expect(app.db.prepare("SELECT COUNT(*) n FROM device_events WHERE event_type='offline'").get()).toMatchObject({ n: 1 });
      expect(pushes).toHaveLength(2);
    });

    it("leaves fresh devices alone and sweeps several stale devices in one pass", () => {
      let now = Date.now();
      const store = new DeviceBridgeStore(app.db, () => now);
      store.heartbeat(CODE, "online", "wx-owner");
      now += 30_000; // 只停了 30s，未超时
      expect(store.sweepStale()).toEqual([]);
      expect(app.db.prepare("SELECT COUNT(*) n FROM device_events WHERE event_type='offline'").get()).toMatchObject({ n: 0 });

      for (const code of ["extra-a", "extra-b"]) {
        app.db.prepare("INSERT INTO bridge_devices(device_code,token_hash,state,heartbeat_at) VALUES (?,?,'online',?)")
          .run(code, "x".repeat(64), now);
      }
      now += 61_000;
      expect(store.sweepStale().sort()).toEqual(["extra-a", "extra-b", CODE]);
      expect(app.db.prepare("SELECT COUNT(*) n FROM device_events WHERE event_type='offline' AND reason='heartbeat_timeout'").get()).toMatchObject({ n: 3 });
    });
  });

  describe("device.updated throttle", () => {
    const T0 = 1_800_000_000_000;
    let now = T0;
    let frames: StreamEvent[];
    let store: DeviceBridgeStore;

    beforeEach(() => {
      now = T0;
      frames = [];
      const notifier = createStreamNotifier(app.db, recordingBus(frames), () => {}, () => now);
      store = new DeviceBridgeStore(app.db, () => now, notifier);
    });

    const deviceFrames = () => frames.filter((frame) => frame.type === "device.updated").map((frame) => frame.data as DeviceFrame);
    const offlineStates = () => deviceFrames().filter((frame) => frame.wecom_state === "offline");

    it("pushes only the first offline within five minutes while both transitions land in device_events", () => {
      store.heartbeat(CODE, "online", "wx-owner");
      now = T0 + 60_000;
      store.heartbeat(CODE, "offline"); // 第一次掉线：推送
      now = T0 + 120_000;
      store.heartbeat(CODE, "online", "wx-owner");
      now = T0 + 180_000;
      store.heartbeat(CODE, "offline"); // 5 分钟内的第二次掉线：节流

      expect(deviceFrames().map((frame) => frame.wecom_state)).toEqual(["online", "offline", "online"]);
      expect(deviceFrames()[1]).toEqual({ device_code: CODE, online: false, wecom_state: "offline", reason: "reported" });
      // 节流只拦推送，事件本身照常写库
      expect(app.db.prepare("SELECT COUNT(*) n FROM device_events WHERE device_code=? AND event_type='offline'").get(CODE)).toMatchObject({ n: 2 });
    });

    it("does not reset the throttle window when an online comes in between", () => {
      store.heartbeat(CODE, "online", "wx-owner");
      now = T0 + 60_000;
      store.heartbeat(CODE, "offline"); // 掉线 #1，窗口基准 = T0+1min
      now = T0 + 240_000;
      store.heartbeat(CODE, "online", "wx-owner"); // online 不节流，也不重置 offline 窗口
      now = T0 + 270_000;
      store.heartbeat(CODE, "offline"); // 距基准 3.5 分钟 → 节流（窗口若被 online 重置就会放行）
      now = T0 + 330_000;
      store.heartbeat(CODE, "online", "wx-owner");
      now = T0 + 360_000;
      store.heartbeat(CODE, "offline"); // 距上一次 offline 转移仅 1.5 分钟 → 仍节流
      expect(offlineStates()).toHaveLength(1);
      expect(deviceFrames().filter((frame) => frame.wecom_state === "online")).toHaveLength(3);
    });

    it("never throttles online recovery pushes", () => {
      store.heartbeat(CODE, "online", "wx-owner"); // 恢复 #1
      now = T0 + 30_000;
      store.heartbeat(CODE, "offline");
      now = T0 + 60_000;
      store.heartbeat(CODE, "online", "wx-owner"); // 恢复 #2，离 #1 仅 1 分钟
      expect(deviceFrames().filter((frame) => frame.wecom_state === "online")).toHaveLength(2);
    });
  });

  describe("device_code=all global subscription", () => {
    // app.inject() 读不到永不结束的 SSE 响应，与 agent-stream.test.ts 一样走真 socket。
    let baseUrl: string;
    let token: string;

    beforeEach(async () => {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-admin", password: "local-demo-only" } })).json().access_token;
      for (const code of ["extra-a", "extra-b"]) {
        app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES (?,'enabled',?)")
          .run(code, JSON.stringify({ device_code: code }));
        const pair = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${code}/pair`, headers: admin });
        expect(pair.statusCode).toBe(200);
        deviceTokens[code] = pair.json().device_token;
      }
    });

    const openStream = async (query: string): Promise<StreamHandle> => {
      const controller = new AbortController();
      const state = { text: "" };
      const response = await fetch(`${baseUrl}/api/v1/agent/stream?${query}`, { signal: controller.signal, headers: { accept: "text/event-stream" } });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            state.text += decoder.decode(value, { stream: true });
          }
        } catch { /* aborted by the test */ }
      })();
      const handle: StreamHandle = { close: () => controller.abort(), state };
      streams.push(handle);
      return handle;
    };

    const waitFor = async (check: () => boolean, describeFailure: () => string, timeoutMs = 4000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(describeFailure());
    };

    it("rejects device_code=all for a scoped non-admin user but keeps single-device access", async () => {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "local-recruiter", password: "local-demo-only" } });
      const recruiterToken = login.json().access_token;
      const forbidden = await app.inject({ method: "GET", url: `/api/v1/agent/stream?token=${recruiterToken}&device_code=all` });
      expect(forbidden.statusCode).toBe(403);
      // 单设备订阅行为不变：白名单内的设备照常建立连接
      const stream = await openStream(`token=${recruiterToken}&device_code=${CODE}`);
      await waitFor(() => stream.state.text.includes("event: ready"), () => `no ready frame: ${stream.state.text}`);
    });

    it("broadcasts every device event to an admin all-subscriber", async () => {
      const all = await openStream(`token=${token}&device_code=all`);
      await waitFor(() => all.state.text.includes("event: ready"), () => "no ready frame");
      expect(all.state.text).toContain('"device_code":"all"');

      await heartbeat(CODE, "online");
      await heartbeat("extra-a", "online");
      await waitFor(() => all.state.text.includes(CODE) && all.state.text.includes("extra-a"), () => `missing device events: ${all.state.text}`);
      const deviceUpdatedChunks = all.state.text.split("\n\n").filter((chunk) => chunk.startsWith("event: device.updated"));
      expect(deviceUpdatedChunks).toHaveLength(2);
      expect(deviceUpdatedChunks[0]).toContain(`"device_code":"${CODE}"`);
    });

    it("keeps a single-device subscription isolated from other devices", async () => {
      const single = await openStream(`token=${token}&device_code=${CODE}`);
      await waitFor(() => single.state.text.includes("event: ready"), () => "no ready frame");
      await heartbeat("extra-b", "online"); // 别的设备：不得串台
      await heartbeat(CODE, "online"); // 本设备的 barrier
      await waitFor(() => single.state.text.includes(CODE), () => `no own device event: ${single.state.text}`);
      expect(single.state.text).not.toContain("extra-b");
    });
  });
});

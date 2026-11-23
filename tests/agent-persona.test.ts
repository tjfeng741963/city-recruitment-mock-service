import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 岗位人设 + 开场条目（src/modules/agent/agent-persona.routes.ts，迁移 038）
//
// 这里守的是「配置能不能正确落库」，不是前端长什么样：
//   - 一个岗位只能有一份人设（重复保存是覆盖，不是新增）；
//   - 开场按 seq 递增追加，delay 下限 2000；
//   - 文本必须有正文、图片视频必须有素材名；
//   - 重排只接受本岗位的条目。
describe("agent persona & opening routes", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  let positionId: number;
  let otherPositionId: number;
  const saved = { ...process.env };

  const login = async (username: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "local-demo-only" },
    });
    expect(res.statusCode).toBe(200);
    return { authorization: `Bearer ${res.json().access_token}` };
  };

  const createPosition = (name: string) => {
    const row = app.db
      .prepare("INSERT INTO service_positions(position_name,status) VALUES (?,'enabled') RETURNING id")
      .get(name) as { id: number };
    return Number(row.id);
  };

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    admin = await login("local-admin");
    customer = await login("local-customer");
    positionId = createPosition("地铁安检员");
    otherPositionId = createPosition("普工");
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe("人设", () => {
    it("一个岗位只有一份，重复保存是覆盖", async () => {
      const first = await app.inject({
        method: "PUT",
        url: "/api/v1/agent-persona",
        headers: admin,
        payload: { position_id: positionId, content: "你是陈姐。" },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().content).toBe("你是陈姐。");

      const second = await app.inject({
        method: "PUT",
        url: "/api/v1/agent-persona",
        headers: admin,
        payload: { position_id: positionId, content: "你是李姐。" },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().content).toBe("你是李姐。");

      const rows = app.db
        .prepare("SELECT COUNT(*) AS n FROM agent_persona WHERE position_id=?")
        .get(positionId) as { n: number };
      expect(Number(rows.n)).toBe(1);
    });

    it("岗位不存在时拒绝保存", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/agent-persona",
        headers: admin,
        payload: { position_id: 99999, content: "x" },
      });
      expect(res.statusCode).toBe(422);
    });

    it("非管理员不能读写", async () => {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/agent-persona?position_id=${positionId}`,
            headers: customer,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/v1/agent-persona",
            headers: customer,
            payload: { position_id: positionId, content: "x" },
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  describe("开场", () => {
    const addText = (content: string, delay?: number) =>
      app.inject({
        method: "POST",
        url: "/api/v1/agent-opening",
        headers: admin,
        payload: { position_id: positionId, kind: "text", content, delay_ms: delay },
      });

    it("opening_version is stable across persona edits and changes for every executable opening change", async () => {
      const deviceCode = "opening-version-device";
      app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES ('版本测试设备','enabled',?)")
        .run(JSON.stringify({ device_code: deviceCode, position_id: positionId }));
      const pair = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${deviceCode}/pair`, headers: admin });
      const headers = { authorization: `Bearer ${pair.json().device_token}` };
      const read = async () => {
        const persona = await app.inject({ method: "GET", url: `/api/v1/agent-persona?position_id=${positionId}`, headers: admin });
        const opening = await app.inject({ method: "GET", url: `/api/v1/agent/opening?device_code=${deviceCode}`, headers });
        expect(persona.statusCode).toBe(200);
        expect(opening.statusCode).toBe(200);
        expect(persona.json().opening_version).toMatch(/^[a-f0-9]{64}$/);
        expect(opening.json().opening_version).toBe(persona.json().opening_version);
        return persona.json().opening_version as string;
      };
      let version = await read();
      expect(await read()).toBe(version);
      const otherEmpty = await app.inject({ method: "GET", url: `/api/v1/agent-persona?position_id=${otherPositionId}`, headers: admin });
      expect(otherEmpty.json().opening_version).not.toBe(version);
      const first = await addText("第一条", 2000);
      expect(first.statusCode).toBe(200);
      const firstId = first.json().id;
      let changed = await read(); expect(changed).not.toBe(version); version = changed;
      await app.inject({ method: "PUT", url: "/api/v1/agent-persona", headers: admin, payload: { position_id: positionId, content: "更新人设" } });
      expect(await read()).toBe(version);
      const second = await addText("第二条", 2000);
      const secondId = second.json().id;
      changed = await read(); expect(changed).not.toBe(version); version = changed;
      await app.inject({ method: "POST", url: "/api/v1/agent-opening/reorder", headers: admin, payload: { position_id: positionId, ids: [secondId, firstId] } });
      changed = await read(); expect(changed).not.toBe(version); version = changed;
      await app.inject({ method: "PUT", url: `/api/v1/agent-opening/${firstId}`, headers: admin, payload: { content: "第一条已修改" } });
      changed = await read(); expect(changed).not.toBe(version); version = changed;
      await app.inject({ method: "PUT", url: `/api/v1/agent-opening/${firstId}`, headers: admin, payload: { delay_ms: 4500 } });
      changed = await read(); expect(changed).not.toBe(version); version = changed;
      await app.inject({ method: "PUT", url: `/api/v1/agent-opening/${firstId}`, headers: admin, payload: { kind: "image", media_name: "素材甲.jpg" } });
      changed = await read(); expect(changed).not.toBe(version); version = changed;
      await app.inject({ method: "PUT", url: `/api/v1/agent-opening/${firstId}`, headers: admin, payload: { media_name: "素材乙.jpg" } });
      changed = await read(); expect(changed).not.toBe(version); version = changed;
      await app.inject({ method: "PUT", url: `/api/v1/agent-opening/${firstId}`, headers: admin, payload: { status: "disabled" } });
      changed = await read(); expect(changed).not.toBe(version); version = changed;
      await app.inject({ method: "DELETE", url: `/api/v1/agent-opening/${secondId}`, headers: admin });
      changed = await read(); expect(changed).not.toBe(version);
      expect(await read()).toBe(changed);
    });

    it("按 seq 递增追加，delay 下限被夹到 2000", async () => {
      const first = await addText("第一条", 0);
      expect(first.statusCode).toBe(200);
      expect(first.json().seq).toBe(1);
      expect(first.json().delay_ms).toBe(2000);

      const second = await addText("第二条", 500);
      expect(second.json().seq).toBe(2);
      expect(second.json().delay_ms).toBe(2000);

      const third = await addText("第三条", 5000);
      expect(third.json().seq).toBe(3);
      expect(third.json().delay_ms).toBe(5000);
    });

    it("文本必须有正文，图片必须有素材名", async () => {
      const emptyText = await app.inject({
        method: "POST",
        url: "/api/v1/agent-opening",
        headers: admin,
        payload: { position_id: positionId, kind: "text", content: "   " },
      });
      expect(emptyText.statusCode).toBe(422);

      const noMedia = await app.inject({
        method: "POST",
        url: "/api/v1/agent-opening",
        headers: admin,
        payload: { position_id: positionId, kind: "image" },
      });
      expect(noMedia.statusCode).toBe(422);
    });

    it("图片素材未上传时仍可保存，但标记文件不存在", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent-opening",
        headers: admin,
        payload: { position_id: positionId, kind: "image", media_name: "还没传.jpg" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().media_exists).toBe(false);
    });

    it("重排只接受本岗位的条目", async () => {
      const mine = (await addText("我的")).json();
      const other = (
        await app.inject({
          method: "POST",
          url: "/api/v1/agent-opening",
          headers: admin,
          payload: { position_id: otherPositionId, kind: "text", content: "别家的" },
        })
      ).json();

      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/agent-opening/reorder",
        headers: admin,
        payload: { position_id: positionId, ids: [mine.id, other.id] },
      });
      expect(rejected.statusCode).toBe(422);

      const second = (await addText("第二条")).json();
      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/agent-opening/reorder",
        headers: admin,
        payload: { position_id: positionId, ids: [second.id, mine.id] },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().items.map((row: { id: number }) => row.id)).toEqual([second.id, mine.id]);
    });


    it("批量删除只移除当前岗位选中的开场并保留其余顺序", async () => {
      const first = (await addText("保留第一条")).json();
      const second = (await addText("删除第二条")).json();
      const third = (await addText("删除第三条")).json();
      const last = (await addText("保留最后一条")).json();
      const listUrl = `/api/v1/agent-persona?position_id=${positionId}`;
      const before = (await app.inject({ url: listUrl, headers: admin })).json();
      const result = await app.inject({
        method: "POST",
        url: "/api/v1/agent-opening/batch-delete",
        headers: admin,
        payload: { position_id: positionId, ids: [second.id, third.id], revision: before.opening_revision },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().deleted_count).toBe(2);
      expect(result.json().items.map((item: { id: number }) => item.id)).toEqual([first.id, last.id]);
      const after = (await app.inject({ url: listUrl, headers: admin })).json();
      expect(after.openings.map((item: { id: number }) => item.id)).toEqual([first.id, last.id]);
      expect(after.opening_version).not.toBe(before.opening_version);
      expect(after.opening_revision).not.toBe(before.opening_revision);
    });

    it("批量删除拒绝跨岗位、过期列表和非管理员请求", async () => {
      const mine = (await addText("本岗位开场")).json();
      const theirs = (await app.inject({
        method: "POST",
        url: "/api/v1/agent-opening",
        headers: admin,
        payload: { position_id: otherPositionId, kind: "text", content: "其他岗位开场" },
      })).json();
      const listUrl = `/api/v1/agent-persona?position_id=${positionId}`;
      const before = (await app.inject({ url: listUrl, headers: admin })).json();
      const remove = (ids: number[], headers = admin) => app.inject({
        method: "POST",
        url: "/api/v1/agent-opening/batch-delete",
        headers,
        payload: { position_id: positionId, ids, revision: before.opening_revision },
      });

      expect((await remove([mine.id], customer)).statusCode).toBe(403);
      expect((await remove([])).statusCode).toBe(422);
      expect((await remove([mine.id, mine.id])).statusCode).toBe(422);
      expect((await remove([mine.id, theirs.id])).statusCode).toBe(422);
      await addText("其它窗口新增的开场");
      expect((await remove([mine.id])).statusCode).toBe(409);
      const after = (await app.inject({ url: listUrl, headers: admin })).json();
      expect(after.openings.map((item: { content: string }) => item.content)).toEqual(["本岗位开场", "其它窗口新增的开场"]);
    });

    it("删除后再读取就少一条", async () => {
      const row = (await addText("待删")).json();
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/agent-opening/${row.id}`,
        headers: admin,
      });
      expect(del.statusCode).toBe(200);

      const list = await app.inject({
        method: "GET",
        url: `/api/v1/agent-persona?position_id=${positionId}`,
        headers: admin,
      });
      expect(list.json().openings).toHaveLength(0);
    });

    it("不带 position_id 时返回全量摘要，供列表页显示已配条数", async () => {
      await addText("一");
      await addText("二");
      await app.inject({
        method: "PUT",
        url: "/api/v1/agent-persona",
        headers: admin,
        payload: { position_id: positionId, content: "人设" },
      });

      const res = await app.inject({ method: "GET", url: "/api/v1/agent-persona", headers: admin });
      expect(res.statusCode).toBe(200);
      const row = res.json().items.find((item: { position_id: number }) => item.position_id === positionId);
      expect(row).toMatchObject({ has_persona: true, opening_count: 2 });
    });
  });
});

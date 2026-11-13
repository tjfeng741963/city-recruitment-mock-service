import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 知识库 v3 配置接口（src/modules/agent/kb-v3.routes.ts）
// 契约：docs/知识库方案-流程驱动-20261113.md §配置层
describe("kb v3 config routes", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
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

  beforeEach(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
    admin = await login("local-admin");
    customer = await login("local-customer");
  });

  afterEach(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  describe("品类 vertical", () => {
    it("lists the two seeded verticals with parsed config", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/verticals", headers: customer });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBeGreaterThanOrEqual(2);
      const codes = body.items.map((row: { code: string }) => row.code);
      expect(codes).toEqual(expect.arrayContaining(["factory", "subway"]));
      // config_json 被解析成对象，前端不用再 JSON.parse
      for (const item of body.items) expect(typeof item.config).toBe("object");
    });

    it("rejects writes from non-admins and unauthenticated callers", async () => {
      const payload = { code: "test-vertical", name: "测试品类" };
      expect((await app.inject({ method: "POST", url: "/api/v1/verticals", headers: customer, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/v1/verticals", payload })).statusCode).toBe(403);
      expect(app.db.prepare("SELECT COUNT(*) n FROM vertical WHERE code='test-vertical'").get()).toMatchObject({ n: 0 });
    });

    it("creates a vertical and rejects duplicates and missing fields", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/verticals",
        headers: admin,
        payload: { code: "nanny", name: "保姆", config_json: { need_house: true }, sort_order: 9 },
      });
      expect(created.statusCode).toBe(201);
      const row = created.json();
      expect(row).toMatchObject({ code: "nanny", name: "保姆", sort_order: 9 });
      expect(row.config).toEqual({ need_house: true });

      expect((await app.inject({ method: "POST", url: "/api/v1/verticals", headers: admin, payload: { code: "nanny", name: "保姆2" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/v1/verticals", headers: admin, payload: { name: "缺编码" } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/api/v1/verticals", headers: admin, payload: { code: "x" } })).statusCode).toBe(422);
    });

    it("updates only the fields sent", async () => {
      const list = await app.inject({ method: "GET", url: "/api/v1/verticals", headers: admin });
      const factory = list.json().items.find((row: { code: string }) => row.code === "factory");
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/verticals/${factory.id}`,
        headers: admin,
        payload: { name: "工厂招工" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: factory.id, name: "工厂招工", code: "factory" });
      expect(res.json().config).toEqual(factory.config);
    });

    it("blocks deleting a vertical that still has employers, and 404s an unknown id", async () => {
      const list = await app.inject({ method: "GET", url: "/api/v1/verticals", headers: admin });
      const factory = list.json().items.find((row: { code: string }) => row.code === "factory");
      await app.inject({
        method: "POST",
        url: "/api/v1/employers",
        headers: admin,
        payload: { employer_code: "TEST-EMP-901", display_name: "测试厂", vertical_id: factory.id },
      });
      const blocked = await app.inject({ method: "DELETE", url: `/api/v1/verticals/${factory.id}`, headers: admin });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().blocking.employers).toBeGreaterThan(0);
      // 被引用时不能删，数据还在
      expect(app.db.prepare("SELECT id FROM vertical WHERE id=?").get(factory.id)).toBeTruthy();

      expect((await app.inject({ method: "DELETE", url: "/api/v1/verticals/999999", headers: admin })).statusCode).toBe(404);
    });
  });

  describe("位置树 location", () => {
    it("builds an open-level tree and filters by level / parent_id", async () => {
      const city = await app.inject({
        method: "POST",
        url: "/api/v1/locations",
        headers: admin,
        payload: { level: "city", name: "广州", code: "GZ", address: "广东省广州市" },
      });
      expect(city.statusCode).toBe(201);
      const cityId = city.json().id;
      const district = await app.inject({
        method: "POST",
        url: "/api/v1/locations",
        headers: admin,
        payload: { level: "district", name: "番禺区", parent_id: cityId },
      });
      expect(district.statusCode).toBe(201);
      const point = await app.inject({
        method: "POST",
        url: "/api/v1/locations",
        headers: admin,
        payload: { level: "point", name: "钟村面试点", parent_id: district.json().id, lat: 22.95, lng: 113.3 },
      });
      expect(point.statusCode).toBe(201);
      expect(point.json()).toMatchObject({ lat: 22.95, lng: 113.3, level: "point" });

      // 029 已经用 point 级建了 6 个真实面试点，这里只断言自己新建的那个进去了
      const points = await app.inject({ method: "GET", url: "/api/v1/locations?level=point", headers: admin });
      expect(points.json().items.map((row: { name: string }) => row.name)).toContain("钟村面试点");
      const children = await app.inject({ method: "GET", url: `/api/v1/locations?parent_id=${cityId}`, headers: admin });
      expect(children.json().items.map((row: { name: string }) => row.name)).toEqual(["番禺区"]);
      // parent_id=-1 等价于“只取顶层”
      const roots = await app.inject({ method: "GET", url: "/api/v1/locations?parent_id=-1", headers: admin });
      expect(roots.json().items.map((row: { name: string }) => row.name)).toContain("广州");
    });

    it("rejects a duplicate sibling but allows the same name under another parent", async () => {
      const a = (await app.inject({ method: "POST", url: "/api/v1/locations", headers: admin, payload: { level: "city", name: "深圳" } })).json();
      const b = (await app.inject({ method: "POST", url: "/api/v1/locations", headers: admin, payload: { level: "city", name: "东莞" } })).json();
      expect((await app.inject({ method: "POST", url: "/api/v1/locations", headers: admin, payload: { level: "city", name: "深圳" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/v1/locations", headers: admin, payload: { level: "district", name: "龙华区", parent_id: a.id } })).statusCode).toBe(201);
      const underB = await app.inject({ method: "POST", url: "/api/v1/locations", headers: admin, payload: { level: "district", name: "龙华区", parent_id: b.id } });
      expect(underB.statusCode).toBe(201);
    });

    it("blocks deleting a node with children, and after children are gone deletes fine", async () => {
      const parent = (await app.inject({ method: "POST", url: "/api/v1/locations", headers: admin, payload: { level: "city", name: "佛山" } })).json();
      const child = (await app.inject({ method: "POST", url: "/api/v1/locations", headers: admin, payload: { level: "district", name: "南海区", parent_id: parent.id } })).json();

      const blocked = await app.inject({ method: "DELETE", url: `/api/v1/locations/${parent.id}`, headers: admin });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().blocking.children).toBe(1);

      expect((await app.inject({ method: "DELETE", url: `/api/v1/locations/${child.id}`, headers: admin })).json()).toEqual({ success: true });
      expect((await app.inject({ method: "DELETE", url: `/api/v1/locations/${parent.id}`, headers: admin })).json()).toEqual({ success: true });
    });

    it("requires level and name", async () => {
      expect((await app.inject({ method: "POST", url: "/api/v1/locations", headers: admin, payload: { name: "无层级" } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/api/v1/locations", headers: admin, payload: { level: "city" } })).statusCode).toBe(422);
    });
  });

  describe("招工方 employer", () => {
    it("creates with aliases and returns them on list and update", async () => {
      const verticals = (await app.inject({ method: "GET", url: "/api/v1/verticals", headers: admin })).json();
      const factoryId = verticals.items.find((row: { code: string }) => row.code === "factory").id;

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/employers",
        headers: admin,
        payload: {
          employer_code: "TEST-EMP-001",
          display_name: "松下万宝(广州)压缩机有限公司",
          short_name: "松下",
          vertical_id: factoryId,
          aliases: ["松下", "万宝", "狄原"],
        },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;

      const listed = await app.inject({ method: "GET", url: "/api/v1/employers?vertical_id=" + factoryId, headers: admin });
      const row = listed.json().items.find((item: { id: number }) => item.id === id);
      expect(row).toMatchObject({ employer_code: "TEST-EMP-001", short_name: "松下" });
      expect(row.aliases.sort()).toEqual(["万宝", "松下", "狄原"].sort());

      // 别名全量替换：传了就按传入的来
      await app.inject({ method: "PUT", url: `/api/v1/employers/${id}`, headers: admin, payload: { aliases: ["万宝压缩机"] } });
      const after = await app.inject({ method: "GET", url: "/api/v1/employers", headers: admin });
      expect(after.json().items.find((item: { id: number }) => item.id === id).aliases).toEqual(["万宝压缩机"]);

      // 不传 aliases 时保持原样
      await app.inject({ method: "PUT", url: `/api/v1/employers/${id}`, headers: admin, payload: { short_name: "松下万宝" } });
      const kept = await app.inject({ method: "GET", url: "/api/v1/employers", headers: admin });
      expect(kept.json().items.find((item: { id: number }) => item.id === id)).toMatchObject({
        short_name: "松下万宝",
        aliases: ["万宝压缩机"],
      });
    });

    it("validates employer_code, display_name and vertical_id", async () => {
      const payload = { employer_code: "X-1", display_name: "某厂", vertical_id: 1 };
      expect((await app.inject({ method: "POST", url: "/api/v1/employers", headers: admin, payload: { ...payload, employer_code: "" } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/api/v1/employers", headers: admin, payload: { ...payload, display_name: "" } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/api/v1/employers", headers: admin, payload: { ...payload, vertical_id: 0 } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/api/v1/employers", headers: admin, payload: { ...payload, vertical_id: 99999 } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/api/v1/employers", headers: customer, payload })).statusCode).toBe(403);
    });

    it("409s when deleting an employer that still has scoped FAQ rows, and 404s an unknown id", async () => {
      const created = (await app.inject({
        method: "POST",
        url: "/api/v1/employers",
        headers: admin,
        payload: { employer_code: "TEST-EMP-777", display_name: "有问答的厂", vertical_id: 1 },
      })).json();
      await app.inject({
        method: "POST",
        url: "/api/v1/kb-faqs",
        headers: admin,
        payload: {
          vertical_id: 1,
          scope_level: "employer",
          scope_employer_id: created.id,
          question: "包吃住吗",
          answer: "包吃包住",
        },
      });
      const blocked = await app.inject({ method: "DELETE", url: `/api/v1/employers/${created.id}`, headers: admin });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().blocking.faqs).toBe(1);

      expect((await app.inject({ method: "DELETE", url: "/api/v1/employers/999999", headers: admin })).statusCode).toBe(404);
    });
  });

  describe("场景问答 kb_faq", () => {
    it("requires scope_level and the matching scope id together", async () => {
      const post = (payload: object) => app.inject({ method: "POST", url: "/api/v1/kb-faqs", headers: admin, payload });
      expect((await post({ question: "问", answer: "" })).statusCode).toBe(422);
      expect((await post({ question: "", answer: "答" })).statusCode).toBe(422);
      expect((await post({ question: "问", answer: "答", scope_level: "bogus" })).statusCode).toBe(422);
      // employer 级必须带 scope_employer_id，否则检索永远命中不到
      expect((await post({ question: "问", answer: "答", scope_level: "employer" })).statusCode).toBe(422);
      expect((await post({ question: "问", answer: "答", scope_level: "city" })).statusCode).toBe(422);
    });

    it("creates scoped rows, lists them by vertical/scope, and parses keywords", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/kb-faqs",
        headers: admin,
        payload: {
          vertical_id: 1,
          scope_level: "global",
          question: "有夜班吗",
          keywords: ["夜班", "两班倒"],
          answer: "{shift}",
          priority: 5,
        },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;

      const listed = await app.inject({ method: "GET", url: "/api/v1/kb-faqs?vertical_id=1&page_size=100", headers: admin });
      expect(listed.statusCode).toBe(200);
      const row = listed.json().items.find((item: { id: number }) => item.id === id);
      expect(row.keywords).toEqual(["夜班", "两班倒"]);
      expect(row.priority).toBe(5);
      expect(listed.json().total).toBeGreaterThan(0);
    });

    it("unlinks the template on a manual edit", async () => {
      const seeded = app.db.prepare(
        "SELECT id, template_item_id FROM kb_faq WHERE template_item_id IS NOT NULL LIMIT 1",
      ).get() as { id: number; template_item_id: number | null } | undefined;
      expect(seeded?.template_item_id).not.toBeNull();

      const edited = await app.inject({
        method: "PUT",
        url: `/api/v1/kb-faqs/${seeded!.id}`,
        headers: admin,
        payload: { answer: "运营手改的答案" },
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toMatchObject({ answer: "运营手改的答案", template_item_id: null });

      expect((await app.inject({ method: "PUT", url: "/api/v1/kb-faqs/999999", headers: admin, payload: {} })).statusCode).toBe(404);
    });

    it("deletes a FAQ row and 404s the second time", async () => {
      const created = (await app.inject({
        method: "POST",
        url: "/api/v1/kb-faqs",
        headers: admin,
        payload: { vertical_id: 1, question: "能带家属吗", answer: "这个得面试时问" },
      })).json();
      expect((await app.inject({ method: "DELETE", url: `/api/v1/kb-faqs/${created.id}`, headers: admin })).json()).toEqual({ success: true });
      expect((await app.inject({ method: "DELETE", url: `/api/v1/kb-faqs/${created.id}`, headers: admin })).statusCode).toBe(404);
    });
  });

  describe("模板包 kb_template", () => {
    it("lists template packs with item counts", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kb-templates", headers: admin });
      expect(res.statusCode).toBe(200);
      const factory = res.json().items.find((row: { code: string }) => row.code === "faq-factory-v1");
      expect(factory.item_count).toBe(15);
    });

    it("returns one pack with parsed keywords and media", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/kb-templates/faq-factory-v1", headers: admin });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(15);
      for (const item of body.items) {
        expect(Array.isArray(item.keywords)).toBe(true);
        expect(Array.isArray(item.media)).toBe(true);
      }
      expect((await app.inject({ method: "GET", url: "/api/v1/kb-templates/nope", headers: admin })).statusCode).toBe(404);
    });

    it("imports a pack once and skips existing questions on re-import", async () => {
      const template = app.db.prepare("INSERT INTO kb_template(code,name,vertical_code) VALUES ('test-pack','测试包','factory') RETURNING id").get() as { id: number };
      const insertItem = app.db.prepare(
        "INSERT INTO kb_template_item(template_id,question,keywords,answer,media,priority,sort_order) VALUES (?,?,?,?,?,?,?)",
      );
      insertItem.run(template.id, "测试问题一", '["测试1"]', "答案一", "[]", 1, 1);
      insertItem.run(template.id, "测试问题二", "[]", "答案二", "[]", 0, 2);

      const first = await app.inject({ method: "POST", url: "/api/v1/kb-templates/test-pack/import", headers: admin });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ success: true, imported: 2, skipped: 0, template: "test-pack" });
      expect(app.db.prepare("SELECT COUNT(*) n FROM kb_faq WHERE question LIKE '测试问题%'").get()).toMatchObject({ n: 2 });

      // 第二次全部跳过，不重复插入
      const second = await app.inject({ method: "POST", url: "/api/v1/kb-templates/test-pack/import", headers: admin });
      expect(second.json()).toMatchObject({ imported: 0, skipped: 2 });
      expect(app.db.prepare("SELECT COUNT(*) n FROM kb_faq WHERE question LIKE '测试问题%'").get()).toMatchObject({ n: 2 });
    });

    it("rejects import from non-admins and for unknown packs", async () => {
      expect((await app.inject({ method: "POST", url: "/api/v1/kb-templates/faq-factory-v1/import", headers: customer })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/v1/kb-templates/nope/import", headers: admin })).statusCode).toBe(404);
    });
  });
});

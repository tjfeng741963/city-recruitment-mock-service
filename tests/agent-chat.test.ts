import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// Agent 会话接口（src/modules/agent/agent-chat.routes.ts）
//
// 只测不依赖网络的路径：上下文读取、dry 模式的 prompt 拼装、
// 以及「没配 key 时返回结构化的失败」——真实模型调用不放进单测。
describe("agent chat routes", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  let positionId: number;
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
    delete process.env.AGENT_LLM_API_KEY;
    app = buildServer();
    await app.ready();
    admin = await login("local-admin");
    customer = await login("local-customer");

    const row = app.db
      .prepare("INSERT INTO service_positions(position_name,status,data_json) VALUES (?,?,?) RETURNING id")
      .get(
        "地铁安检员",
        "enabled",
        JSON.stringify({ wage_text: "22元/小时", place: "陈村基地", hours_text: "两班倒" }),
      ) as { id: number };
    positionId = Number(row.id);
  });

  afterEach(async () => {
    await app?.close();
    for (const key of [
      "REA_DATABASE_PATH",
      "REA_MESSAGE_CHANNEL_PROVIDER",
      "REA_DIFY_PROVIDER",
      "AGENT_LLM_API_KEY",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("上下文把岗位事实整理成 facts，空字段不出现", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agent/context?position_id=${positionId}`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.facts).toMatchObject({ job_title: "地铁安检员", wage_text: "22元/小时", place: "陈村基地" });
    // data_json 里没写的键不能凭空出现
    expect(body.facts.interview_time).toBeUndefined();
    expect(body.opening).toEqual([]);
    expect(body.llm.configured).toBe(false);
  });

  it("非管理员读不到上下文，也调不了对话", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/agent/context?position_id=${positionId}`,
          headers: customer,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/agent/chat",
          headers: customer,
          payload: { position_id: positionId, text: "多少钱" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("dry 模式不调模型，返回 system + 历史 + 当前这句", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: {
        position_id: positionId,
        text: "有没有夜班",
        dry: true,
        history: [
          { role: "customer", text: "多少钱一小时" },
          { role: "agent", text: "22 一小时" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dry).toBe(true);
    expect(body.messages[0].role).toBe("system");
    // 事实必须真的进了 system，而不是只在接口响应里
    expect(body.messages[0].content).toContain("22元/小时");
    expect(body.messages[1]).toEqual({ role: "user", content: "多少钱一小时" });
    expect(body.messages[2].role).toBe("assistant");
    // assistant 历史装回完整 JSON 信封（与输出规范同构：含 capture/interview
    // 占位，模型才不会把字段丢掉）
    expect(body.messages[2].content).toBe(
      JSON.stringify({
        messages: [{ type: "text", content: "22 一小时" }],
        capture: {},
        interview: {},
        handoff: false,
        done: false,
      }),
    );
    expect(body.messages[3]).toEqual({ role: "user", content: "有没有夜班" });
  });

  it("dry prompt 包含可用素材和完整面试事实，不混入其他岗位素材", async () => {
    const interviewFacts = {
      interview_time_text: "周一至周六上午9点到下午4点，周日休息",
      interview_address: "深圳测试基地一楼面试室",
      interview_material: "携带身份证和无犯罪证明",
      basic_requirements: "身体健康，无外露纹身",
      onboarding_notes: "面试通过后统一安排住宿",
    };
    app.db.prepare("UPDATE service_positions SET data_json=? WHERE id=?")
      .run(JSON.stringify({ wage_text: "22元/小时", ...interviewFacts }), positionId);
    const otherPosition = app.db.prepare("INSERT INTO service_positions(position_name,status) VALUES (?,?) RETURNING id")
      .get("其他城市安检员", "enabled") as { id: number };
    const addMedia = app.db.prepare(`INSERT INTO media_assets(name,kind,storage_path,sha256,position_id,status)
      VALUES (?,?,?,?,?,?)`);
    for (const [name, kind] of [["通用工作照片.jpg", "image"], ["通用宿舍照片.jpg", "image"], ["通用安检视频.mp4", "video"]]) {
      addMedia.run(name, kind, `test/${name}`, "test-sha", 0, "enabled");
    }
    addMedia.run("深圳专属面试地点.jpg", "image", "test/shenzhen.jpg", "test-sha", positionId, "enabled");
    addMedia.run("深圳专属面试说明.mp4", "video", "test/shenzhen.mp4", "test-sha", positionId, "enabled");
    addMedia.run("其他岗位面试地点.jpg", "image", "test/other.jpg", "test-sha", Number(otherPosition.id), "enabled");
    addMedia.run("已停用通用图片.jpg", "image", "test/disabled.jpg", "test-sha", 0, "disabled");

    const response = await app.inject({
      method: "POST", url: "/api/v1/agent/chat", headers: admin,
      payload: { position_id: positionId, session_key: "S:dry-full-facts", text: "发下宿舍和面试地点图，什么时候面试？", dry: true },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.dry).toBe(true);
    expect(result.facts).toMatchObject({
      ...interviewFacts,
      media_catalog: "通用工作照片.jpg、通用宿舍照片.jpg、通用安检视频.mp4",
      interview_address_image: "深圳专属面试地点.jpg",
      interview_video: "深圳专属面试说明.mp4",
    });
    const systemPrompt = result.messages[0].content as string;
    for (const [field, value] of Object.entries({
      ...interviewFacts,
      media_catalog: result.facts.media_catalog,
      interview_address_image: result.facts.interview_address_image,
      interview_video: result.facts.interview_video,
    })) {
      expect(systemPrompt).toContain(`（${field}）：${value}`);
    }
    expect(systemPrompt).not.toContain("其他岗位面试地点.jpg");
    expect(systemPrompt).not.toContain("已停用通用图片.jpg");
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM agent_session").get()).toEqual({ n: 0 });
  });

  it("没配 key 时返回结构化失败，不抛 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: { position_id: positionId, text: "多少钱" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no_api_key");
    expect(String(body.error)).toContain("AGENT_LLM_API_KEY");
  });

  it("开场序列注入为 assistant 历史：客户问「第二条说的工资」时模型看得到", async () => {
    app.db
      .prepare(
        `INSERT INTO position_opening(position_id, seq, kind, content, media_name, delay_ms, status)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(positionId, 1, "text", "招聘要求：男女不限，18-35岁", "", 2000, "enabled");
    app.db
      .prepare(
        `INSERT INTO position_opening(position_id, seq, kind, content, media_name, delay_ms, status)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(positionId, 2, "image", "", "宿舍照片.jpg", 2000, "enabled");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: { position_id: positionId, text: "你发的第二条是什么", dry: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // system 之后紧跟开场序列（assistant JSON 信封），再才是当前这句
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].content).toBe(
      JSON.stringify({
        messages: [{ type: "text", content: "招聘要求：男女不限，18-35岁" }],
        capture: {},
        interview: {},
        handoff: false,
        done: false,
      }),
    );
    expect(body.messages[2].role).toBe("assistant");
    expect(body.messages[2].content).toBe(
      JSON.stringify({
        messages: [{ type: "image", name: "宿舍照片.jpg" }],
        capture: {},
        interview: {},
        handoff: false,
        done: false,
      }),
    );
    expect(body.messages[3]).toEqual({ role: "user", content: "你发的第二条是什么" });
  });

  it("session_key 模式：上下文存服务端，成功后累积、失败不写", async () => {
    // 没配 key：失败不入会话
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: { position_id: positionId, session_key: "S:test-session", text: "多少钱" },
    });
    expect(first.json().ok).toBe(false);
    expect(
      app.db.prepare("SELECT COUNT(*) AS n FROM agent_session").get(),
    ).toEqual({ n: 0 });

    // dry 不写会话，但能看到当前（空）上下文
    const dry = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: { position_id: positionId, session_key: "S:test-session", text: "在吗", dry: true },
    });
    expect(dry.json().session_key).toBe("S:test-session");
    expect(
      app.db.prepare("SELECT COUNT(*) AS n FROM agent_session").get(),
    ).toEqual({ n: 0 });
  });

  it("session_key 绑到别的岗位时上下文重置，不串会话", async () => {
    app.db
      .prepare(
        "INSERT INTO agent_session(session_key, position_id, context_json, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
      )
      .run(
        "S:other-pos",
        positionId + 1,
        JSON.stringify([{ role: "customer", text: "旧会话的这句话" }]),
      );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: { position_id: positionId, session_key: "S:other-pos", text: "你好", dry: true },
    });
    expect(res.statusCode).toBe(200);
    // 旧上下文不该出现：messages 里只有 system + 当前这句
    const body = res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({ role: "user", content: "你好" });
  });

  it("岗位不存在时 404", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/agent/context?position_id=99999",
          headers: admin,
        })
      ).statusCode,
    ).toBe(404);
  });
});

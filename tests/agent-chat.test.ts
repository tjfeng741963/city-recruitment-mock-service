import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("only plans images and video when the model adopts the unique matched FAQ", async () => {
    process.env.AGENT_LLM_API_KEY = "fixture-only";
    const sha = "b".repeat(64);
    const insert = app.db.prepare("INSERT INTO media_assets(name,kind,storage_path,sha256,bytes,status,position_id) VALUES (?,?,?,?,1,'enabled',?) RETURNING id");
    const video = insert.get("现场.mp4", "video", "b.mp4", sha, positionId) as { id: number };
    const picture = insert.get("现场.png", "image", "b.png", sha, 0) as { id: number };
    const answer = "请看现场实拍。";
    const faq = await app.inject({ method: "POST", url: "/api/v1/kb-faqs", headers: admin, payload: {
      question: "现场什么样？", answer, keywords: ["实拍"], media: [`asset:${video.id}:${sha}`, `asset:${picture.id}:${sha}`],
      scope_level: "position", scope_position_id: positionId,
    } });
    expect(faq.statusCode).toBe(201);
    let modelAnswer = answer;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ model: "deepseek-chat", choices: [{ message: {
      content: JSON.stringify({ messages: [{ type: "text", content: modelAnswer }] }),
    } }] })));
    try {
      const preview = async () => (await app.inject({ method: "POST", url: "/api/v1/agent/chat", headers: admin,
        payload: { position_id: positionId, text: "实拍", preview: true } })).json();
      const adopted = await preview();
      expect(adopted.reply.faq).toMatchObject({ id: faq.json().id });
      expect(adopted.reply.messages.map((message: { type: string }) => message.type)).toEqual(["text", "image", "video"]);
      modelAnswer = "请先确认你想看的地点。";
      expect((await preview()).reply).not.toHaveProperty("faq");
      modelAnswer = answer;
      app.db.prepare("UPDATE media_assets SET status='disabled' WHERE id=?").run(video.id);
      expect((await preview()).reply.messages).toEqual([{ type:"text", content:answer }]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("city defaults are copied once to new position facts read by the agent", async () => {
    const city = await app.inject({
      method: "POST",
      url: "/api/v1/cities",
      headers: admin,
      payload: {
        city_name: "模板测试城",
        salary: { raw: "22元/小时，综合月薪6500元" },
        work_hours: { raw: "两班倒，每天工作10小时" },
        requirements: { raw: "年龄18-40岁，身体健康" },
        social_insurances: "转正后缴纳五险",
        interview: { time: "周一至周六上午", location: "测试招聘点" },
      },
    });
    expect(city.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/service-positions",
      headers: admin,
      payload: {
        position_name: "模板岗位",
        city_id: city.json().id,
        age_range: "",
        address: "",
        interview_time: "",
        base_sections: { salary_detail: "", work_hours: "", requirements: "" },
      },
    });
    expect(created.statusCode).toBe(200);

    const context = await app.inject({
      method: "GET",
      url: `/api/v1/agent/context?position_id=${created.json().id}`,
      headers: admin,
    });
    expect(context.statusCode).toBe(200);
    expect(context.json().facts).toMatchObject({
      wage_text: "22元/小时，综合月薪6500元",
      hours_text: "两班倒，每天工作10小时",
      basic_requirements: "年龄18-40岁，身体健康",
      welfare_text: "转正后缴纳五险",
      interview_time: "周一至周六上午",
      interview_address: "测试招聘点",
    });
  });

  it("maps existing position form fields into the agent fact card", async () => {
    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/service-positions/${positionId}`,
      headers: admin,
      payload: {
        age_range: "18-38岁",
        height_require: "男170cm以上",
        accommodation: "包住，水电平摊",
        address: "广州市番禺区招聘点",
        base_sections: {
          salary_detail: "底薪3000元，综合月薪6500元",
          work_hours: "两班倒，每天10小时",
          requirements: "身体健康，无犯罪记录",
          work_content: "地铁站安全检查",
          dorm_env: "宿舍4人间，空调热水器齐全",
        },
      },
    });
    expect(updated.statusCode).toBe(200);

    const context = await app.inject({
      method: "GET",
      url: `/api/v1/agent/context?position_id=${positionId}`,
      headers: admin,
    });
    expect(context.json().facts).toMatchObject({
      age_text: "18-38岁",
      height_text: "男170cm以上",
      welfare_text: "包住，水电平摊",
      place: "广州市番禺区招聘点",
      wage_text: "底薪3000元，综合月薪6500元",
      hours_text: "两班倒，每天10小时",
      basic_requirements: "身体健康，无犯罪记录",
      job_content: "地铁站安全检查",
      additional_info: expect.stringContaining("宿舍4人间，空调热水器齐全"),
    });

    const dry = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: { position_id: positionId, text: "面试在哪里", dry: true },
    });
    expect(dry.json().messages[0].content).toContain("- 面试地址（interview_address）：广州市番禺区招聘点");
    expect(dry.json().messages[0].content).toContain("- 基本招聘要求（basic_requirements）：身体健康，无犯罪记录");
  });

  it("blocks live replies from a disabled position while allowing dry QA", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/v1/service-positions/${positionId}`,
      headers: admin,
      payload: { is_active: false },
    });
    const live = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: { position_id: positionId, text: "多少钱" },
    });
    expect(live.statusCode).toBe(409);
    expect(live.json().detail).toContain("已停用");
    const dry = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: admin,
      payload: { position_id: positionId, text: "多少钱", dry: true },
    });
    expect(dry.statusCode).toBe(200);
  });

  it("does not return opening messages for a disabled position", async () => {
    const deviceCode = "opening-disabled-test";
    app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES ('测试设备','enabled',?)")
      .run(JSON.stringify({ device_code: deviceCode, position_id: positionId }));
    app.db.prepare("INSERT INTO position_opening(position_id,seq,kind,content) VALUES (?,1,'text','欢迎了解岗位')")
      .run(positionId);

    const enabled = await app.inject({
      method: "GET",
      url: `/api/v1/agent/opening?device_code=${deviceCode}`,
      headers: admin,
    });
    expect(enabled.json().items).toHaveLength(1);

    await app.inject({
      method: "PUT",
      url: `/api/v1/service-positions/${positionId}`,
      headers: admin,
      payload: { is_active: false },
    });
    const disabled = await app.inject({
      method: "GET",
      url: `/api/v1/agent/opening?device_code=${deviceCode}`,
      headers: admin,
    });
    expect(disabled.json()).toMatchObject({ position_id: positionId, persona: "", items: [], detail: "岗位已停用" });
  });

  it("uses only applicable enabled FAQ knowledge and renders facts in dry QA", async () => {
    const insert = (scope: string, pid: number | null, question: string, answer: string, status = 'enabled') => {
      app.db.prepare("INSERT INTO kb_faq(tenant_id,scope_level,scope_position_id,question,answer,keywords,media,status) VALUES (1,?,?,?,?, '[]','[]',?)")
        .run(scope, pid, question, answer, status);
    };
    insert('global', null, '工资多少', '{wage_text}');
    insert('global', null, '怎么称呼', '叫我陈姐就好');
    insert('global', null, '旧错误工资', '工资999元');
    insert('position', positionId, '集合后做什么', '到岗先联系带队老师');
    const other = app.db.prepare("INSERT INTO service_positions(position_name) VALUES ('另一个岗位') RETURNING id").get() as { id: number };
    insert('position', other.id, '其他岗位', '另一个厂的秘密答案');
    insert('position', positionId, '停用答案', '此答案不能发送', 'disabled');
    insert('global', null, '缺失字段', '{height_text}');
    const res = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers: admin,
      payload: { position_id: positionId, text: '工资多少', dry: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().knowledge).toEqual(expect.arrayContaining([
      expect.objectContaining({ question: '工资多少', answer: '22元/小时' }),
      expect.objectContaining({ question: '集合后做什么', answer: '到岗先联系带队老师' }),
    ]));
    const prompt = res.json().messages[0].content;
    expect(prompt).toContain('叫我陈姐就好');
    expect(prompt).toContain('到岗先联系带队老师');
    for (const forbidden of ['另一个厂的秘密答案', '工资999元', '此答案不能发送', '缺失字段']) expect(prompt).not.toContain(forbidden);
  });

  it('requires admin for generated previews and never accepts a live session for preview', async () => {
    const res = await app.inject({method:'POST',url:'/api/v1/agent/chat',headers:admin,
      payload:{position_id:positionId,text:'你好',preview:true,session_key:'real-customer'}});
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain('模拟');
  });

  it('generates a preview without recording a session, archive or send command', async () => {
    process.env.AGENT_LLM_API_KEY = 'local-test-placeholder';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({model:'deepseek-chat',choices:[{message:{content:JSON.stringify({
      messages:[{type:'text',content:'先联系带队老师'}],capture:{name:'测试',phone:'13800000000'},
      interview:{date:'2026-12-01',time:'10:00',confirmed:true},handoff:false,done:false,
    })}}]}),{status:200}));
    const count = (table:string) => (app.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n;
    const tables=['agent_session','agent_archive','bridge_commands'];
    const before=tables.map(count);
    try {
      const res=await app.inject({method:'POST',url:'/api/v1/agent/chat',headers:admin,
        payload:{position_id:positionId,text:'集合后做什么',preview:true}});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ok:true,preview:true,reply:{messages:[{type:'text',content:'先联系带队老师'}]}});
      expect(tables.map(count)).toEqual(before);
    } finally { vi.unstubAllGlobals(); }
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

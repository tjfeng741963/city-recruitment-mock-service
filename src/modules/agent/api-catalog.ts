/**
 * 接口目录（给人看的版本）。
 *
 * 和 docs/API-接口清单.md 的分工：
 *   - 文档给「不看代码也想调接口」的人，含 curl 示例；
 *   - 本文件给 /dev 页面用，多两个字段：分类说明和请求体示例。
 *
 * 为什么要手写分类：自动收集的路由只有 method + url，看不出「这个接口干什么、
 * 参数怎么填」。分类和一句话说明必须人工写，但**路径必须真实存在**——
 * /api/v1/debug/catalog 会把目录和 onRoute 收集到的真实路由做差集，
 * 页面底部会列出「代码里有、目录里没写」的接口，防止这份目录悄悄过期。
 */

export type CatalogAuth = "admin" | "user" | "device" | "none";

export type CatalogEndpoint = {
  method: string;
  url: string;
  summary: string;
  auth: CatalogAuth;
  params?: string;
  body?: unknown;
  response?: unknown;
};

export type CatalogGroup = {
  group: string;
  note: string;
  endpoints: CatalogEndpoint[];
};

export const API_CATALOG: CatalogGroup[] = [
  {
    group: "账号",
    note: "所有后台接口都要带 Authorization: Bearer <token>，先从这里拿。",
    endpoints: [
      {
        method: "POST",
        url: "/api/v1/auth/login",
        summary: "账号密码换 access_token",
        auth: "none",
        body: { username: "local-admin", password: "local-demo-only" },
        response: { access_token: "eyJhbGciOi..." },
      },
    ],
  },
  {
    group: "人设与开场",
    note: "一个岗位一份人设；开场是岗位下按 seq 排序的条目，支持文本 / 图片 / 视频。",
    endpoints: [
      {
        method: "GET",
        url: "/api/v1/agent-persona",
        summary: "不带 position_id：全部岗位的摘要，用来在列表页显示「已配几条」",
        auth: "admin",
        params: "无",
        response: { items: [{ position_id: 1, has_persona: true, opening_count: 3 }], total: 1 },
      },
      {
        method: "GET",
        url: "/api/v1/agent-persona",
        summary: "带 position_id：这个岗位的人设全文 + 全部开场条目",
        auth: "admin",
        params: "query: position_id",
        response: {
          persona: { id: 1, position_id: 1, content: "你是陈姐……", status: "enabled" },
          openings: [{ id: 1, seq: 1, kind: "text", content: "你好", delay_ms: 2000 }],
          total: 1,
        },
      },
      {
        method: "PUT",
        url: "/api/v1/agent-persona",
        summary: "保存人设（按 position_id 覆盖，不会新增第二份）",
        auth: "admin",
        body: { position_id: 1, content: "你是陈姐，在广东做工厂招工十几年……" },
      },
      {
        method: "POST",
        url: "/api/v1/agent-opening",
        summary: "追加一条开场，自动排到末尾；delay_ms 会被夹到 [2000, 60000]",
        auth: "admin",
        body: { position_id: 1, kind: "text", content: "你好，我们这边在招普工", delay_ms: 2000 },
      },
      {
        method: "PUT",
        url: "/api/v1/agent-opening/:id",
        summary: "改一条开场；只传要改的字段",
        auth: "admin",
        params: "path: id",
        body: { content: "改过的正文", delay_ms: 3000 },
      },
      {
        method: "DELETE",
        url: "/api/v1/agent-opening/:id",
        summary: "删除一条开场（物理删除）",
        auth: "admin",
        params: "path: id",
      },
      {
        method: "POST",
        url: "/api/v1/agent-opening/reorder",
        summary: "按给定 id 顺序重排；只接受本岗位的条目",
        auth: "admin",
        body: { position_id: 1, ids: [2, 1] },
      },
    ],
  },
  {
    group: "Agent 会话",
    note: "输入是标准多轮 messages，输出是 JSON。金额必须能在岗位事实里找到，否则整条判失败。",
    endpoints: [
      {
        method: "GET",
        url: "/api/v1/agent/context",
        summary: "调试用：岗位事实 / 人设 / 开场 / 模型是否配了 key",
        auth: "admin",
        params: "query: position_id 或 device_code",
        response: { position: { id: 1, name: "普工" }, facts: { wage_text: "22元/小时" }, persona: "", opening: [] },
      },
      {
        method: "GET",
        url: "/api/v1/agent/opening",
        summary: "客户端用：按设备号取绑定岗位的开场清单 + 人设",
        auth: "device",
        params: "query: device_code",
        response: { position_id: 1, persona: "…", items: [{ seq: 1, kind: "text", content: "你好", delay_ms: 2000 }] },
      },
      {
        method: "POST",
        url: "/api/v1/agent/opening/log",
        summary: "客户端逐条回执，失败也记；不驱动流程，只留痕",
        auth: "device",
        body: { session_key: "S:10001", device_code: "pc-win-01", position_id: 1, seq: 1, kind: "text", status: "sent" },
      },
      {
        method: "POST",
        url: "/api/v1/agent/chat",
        summary: "一轮对话：system(人设+事实+输出格式) + 全量历史；dry=true 只看 prompt 不调模型",
        auth: "admin",
        body: { position_id: 1, text: "多少钱一小时", history: [], dry: true },
        response: {
          ok: true,
          reply: { messages: [{ type: "text", content: "22 一小时" }], capture: {}, handoff: false, done: false },
          model: "deepseek-chat",
          latency_ms: 1180,
        },
      },
    ],
  },
  {
    group: "素材",
    note: "开场里的图片 / 视频按名字引用，文件存在本地 media 目录，下载接口给客户端用。",
    endpoints: [
      {
        method: "GET",
        url: "/api/v1/media",
        summary: "素材库列表",
        auth: "admin",
        response: { items: [{ id: 1, name: "门头照.jpg", kind: "image", bytes: 102400 }], total: 1 },
      },
      {
        method: "POST",
        url: "/api/v1/media",
        summary: "上传素材，body 是 base64；单文件 ≤ 20MB",
        auth: "admin",
        body: { name: "门头照.jpg", kind: "image", data_base64: "data:image/jpeg;base64,..." },
      },
      {
        method: "DELETE",
        url: "/api/v1/media/:id",
        summary: "删除素材记录（文件按 sha256 复用，不删物理文件）",
        auth: "admin",
        params: "path: id",
      },
      {
        method: "GET",
        url: "/api/v1/agent/media/:name",
        summary: "客户端下载素材，响应头带 X-Content-SHA256",
        auth: "device",
        params: "path: name",
      },
    ],
  },
  {
    group: "岗位与设备",
    note: "设备绑定岗位（agent_devices.data_json.position_id），岗位再关联工厂与城市。",
    endpoints: [
      {
        method: "GET",
        url: "/api/v1/service-positions",
        summary: "岗位列表，前端取 id / 名称 / 工厂 / 城市",
        auth: "user",
        params: "query: page, page_size",
      },
      {
        method: "GET",
        url: "/api/v1/agent/devices",
        summary: "设备列表，含绑定品类、招工方、岗位、在线状态",
        auth: "admin",
      },
      {
        method: "GET",
        url: "/api/v1/agent/cities",
        summary: "在招城市清单，供流程识别客户说的地名",
        auth: "admin",
      },
    ],
  },
  {
    group: "知识库",
    note: "存量接口，知识库配置页在用。品类 / 区域 / 招工方 / 场景问答 / 模板包。",
    endpoints: [
      { method: "GET", url: "/api/v1/verticals", summary: "品类列表", auth: "user" },
      { method: "GET", url: "/api/v1/locations", summary: "区域树，可按 level / parent_id 过滤", auth: "user" },
      { method: "GET", url: "/api/v1/employers", summary: "招工方列表", auth: "user" },
      { method: "GET", url: "/api/v1/kb-faqs", summary: "场景问答列表，可按品类 / 作用域过滤", auth: "user" },
      { method: "GET", url: "/api/v1/kb-faqs/audit", summary: "问答治理检查：哪些共享层写死了厂规", auth: "admin" },
      { method: "GET", url: "/api/v1/kb-templates", summary: "模板包列表", auth: "user" },
      { method: "POST", url: "/api/v1/kb-templates/:code/import", summary: "导入模板包，已存在的同问题条目跳过", auth: "admin" },
      { method: "POST", url: "/api/v1/kb-publish/preview", summary: "发布预览：只算变更，不落库", auth: "admin" },
      { method: "POST", url: "/api/v1/kb-publish/apply", summary: "发布：带版本锁与摘要校验", auth: "admin" },
      { method: "GET", url: "/api/v1/kb-publish/history", summary: "发布历史", auth: "admin" },
    ],
  },
];

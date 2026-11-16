/**
 * 接口目录（/dev 页面用）。
 *
 * 每个接口写四样东西：**干什么、要什么权限、参数是什么、返回什么**。
 * 字段说明是人工写的，但路径必须真实存在——/api/v1/debug/catalog 会把
 * 这份目录和 onRoute 收集到的真实路由做差集，没写说明的接口会进「未归类」，
 * 页面底部直接能看见，不会悄悄过期。
 *
 * 与 docs/API-接口清单.md 的分工：文档偏「怎么调」（curl 示例、失败约定），
 * 这里偏「是什么」（每个字段的含义与约束）。
 */

export type CatalogAuth = "admin" | "user" | "device" | "none";

export type FieldDoc = {
  name: string;
  type: string;
  required?: boolean;
  desc: string;
};

export type CatalogEndpoint = {
  /** 同一 method + url 可能有多种用法（例如 persona 带不带 position_id），用 key 区分 */
  key?: string;
  method: string;
  url: string;
  /** 这个接口解决什么问题 */
  purpose: string;
  auth: CatalogAuth;
  pathParams?: FieldDoc[];
  queryParams?: FieldDoc[];
  bodyFields?: FieldDoc[];
  body?: unknown;
  responseFields?: FieldDoc[];
  response?: unknown;
  notes?: string[];
};

export type CatalogGroup = {
  group: string;
  note: string;
  endpoints: CatalogEndpoint[];
};

export const API_CATALOG: CatalogGroup[] = [
  {
    group: "账号",
    note: "后台所有接口都要带 Authorization: Bearer <token>。token 有效期 480 分钟，过期重新登录。",
    endpoints: [
      {
        key: "login",
        method: "POST",
        url: "/api/v1/auth/login",
        purpose: "用账号密码换 access_token。token 存在浏览器 localStorage.token，后台和 /dev 共用一份。",
        auth: "none",
        bodyFields: [
          { name: "username", type: "string", required: true, desc: "登录账号" },
          { name: "password", type: "string", required: true, desc: "密码" },
        ],
        body: { username: "local-admin", password: "local-demo-only" },
        responseFields: [
          { name: "access_token", type: "string", desc: "JWT，放进 Authorization 头" },
          { name: "token_type", type: "string", desc: "固定 bearer" },
        ],
        response: { access_token: "eyJhbGciOi...", token_type: "bearer" },
        notes: ["密码错返回 401，不告诉你是账号不存在还是密码错。"],
      },
    ],
  },
  {
    group: "人设与开场",
    note: "一个岗位一份人设；开场是这个岗位下按 seq 排序的条目，支持文本 / 图片 / 视频。设备通过 agent_devices.data_json.position_id 找到岗位。",
    endpoints: [
      {
        key: "persona-summary",
        method: "GET",
        url: "/api/v1/agent-persona",
        purpose: "不带 position_id：一次性拿全部岗位的配置摘要，用来在岗位列表上显示「人设配了没、开场几条」。一页几十行只发这一个请求。",
        auth: "admin",
        responseFields: [
          { name: "items[].position_id", type: "number", desc: "岗位 id" },
          { name: "items[].has_persona", type: "boolean", desc: "该岗位是否已配启用状态的人设" },
          { name: "items[].opening_count", type: "number", desc: "启用状态的开场条目数" },
          { name: "total", type: "number", desc: "涉及的岗位数（有配置的才算）" },
        ],
        response: { items: [{ position_id: 1, has_persona: true, opening_count: 3 }], total: 1 },
      },
      {
        key: "persona-detail",
        method: "GET",
        url: "/api/v1/agent-persona",
        purpose: "带 position_id：这个岗位的人设全文 + 全部开场条目，编辑页打开时调它。",
        auth: "admin",
        queryParams: [{ name: "position_id", type: "number", required: true, desc: "岗位 id" }],
        responseFields: [
          { name: "persona.id", type: "number", desc: "人设记录 id；没配过则为 null" },
          { name: "persona.position_id", type: "number", desc: "所属岗位" },
          { name: "persona.content", type: "string", desc: "人设全文，直接进模型的 system" },
          { name: "persona.status", type: "string", desc: "enabled / disabled" },
          { name: "openings[].id", type: "number", desc: "开场条目 id" },
          { name: "openings[].seq", type: "number", desc: "发送顺序，从 1 开始" },
          { name: "openings[].kind", type: "string", desc: "text / image / video" },
          { name: "openings[].content", type: "string", desc: "文本正文；图片视频为空" },
          { name: "openings[].media_name", type: "string", desc: "素材文件名；文本为空" },
          { name: "openings[].delay_ms", type: "number", desc: "发完这条至少等多久才发下一条" },
          { name: "openings[].status", type: "string", desc: "enabled / disabled" },
          { name: "openings[].media_exists", type: "boolean", desc: "素材库里有没有这个文件；配了没传时为 false" },
          { name: "total", type: "number", desc: "开场条目数" },
        ],
        response: {
          persona: { id: 1, position_id: 1, content: "你是陈姐……", status: "enabled" },
          openings: [
            { id: 1, position_id: 1, seq: 1, kind: "text", content: "你好", media_name: "", delay_ms: 2000, status: "enabled", media_exists: false },
          ],
          total: 1,
        },
      },
      {
        key: "persona-save",
        method: "PUT",
        url: "/api/v1/agent-persona",
        purpose: "保存人设。按 position_id 覆盖——一个岗位只会有这一份，重复保存不会新增第二行。",
        auth: "admin",
        bodyFields: [
          { name: "position_id", type: "number", required: true, desc: "岗位 id，必须存在" },
          { name: "content", type: "string", desc: "人设全文，最多 20000 字；可传空串表示还没写" },
          { name: "status", type: "string", desc: "enabled / disabled，默认 enabled" },
        ],
        body: { position_id: 1, content: "你是陈姐，在广东做工厂招工十几年……" },
        responseFields: [
          { name: "id", type: "number", desc: "人设记录 id" },
          { name: "position_id", type: "number", desc: "所属岗位" },
          { name: "content", type: "string", desc: "保存后的全文" },
          { name: "status", type: "string", desc: "启用状态" },
        ],
        notes: ["工价、地点这类事实不要写进人设：岗位数据一改，人设里的数字就对不上了。"],
      },
      {
        key: "opening-add",
        method: "POST",
        url: "/api/v1/agent-opening",
        purpose: "给岗位追加一条开场，自动排到末尾（seq 取当前最大值 +1）。",
        auth: "admin",
        bodyFields: [
          { name: "position_id", type: "number", required: true, desc: "岗位 id" },
          { name: "kind", type: "string", required: true, desc: "text / image / video" },
          { name: "content", type: "string", desc: "text 必填，最多 2000 字；可含 {{factory}} 等占位符" },
          { name: "media_name", type: "string", desc: "image / video 必填，素材文件名，不能带路径分隔符" },
          { name: "delay_ms", type: "number", desc: "发完这条等多久，默认 2000，低于 2000 会被夹到 2000，上限 60000" },
        ],
        body: { position_id: 1, kind: "text", content: "你好，我们这边在招普工", delay_ms: 2000 },
        responseFields: [
          { name: "id", type: "number", desc: "新条目 id" },
          { name: "seq", type: "number", desc: "排到的序号" },
          { name: "kind / content / media_name / delay_ms / status", type: "mixed", desc: "落库后的值" },
          { name: "media_exists", type: "boolean", desc: "素材库里有没有这个文件" },
        ],
        notes: ["一个岗位最多 30 条开场，超了返回 422。", "图片视频允许先填名字后传文件，此时 media_exists=false。"],
      },
      {
        key: "opening-update",
        method: "PUT",
        url: "/api/v1/agent-opening/:id",
        purpose: "修改一条开场。只传要改的字段，没传的保持原值。",
        auth: "admin",
        pathParams: [{ name: "id", type: "number", required: true, desc: "开场条目 id" }],
        bodyFields: [
          { name: "kind", type: "string", desc: "改类型时要同时把 content / media_name 改成匹配的值" },
          { name: "content", type: "string", desc: "正文" },
          { name: "media_name", type: "string", desc: "素材名" },
          { name: "delay_ms", type: "number", desc: "间隔，仍受 [2000, 60000] 限制" },
          { name: "status", type: "string", desc: "enabled / disabled" },
        ],
        body: { content: "改过的正文", delay_ms: 3000 },
        responseFields: [{ name: "（同新增）", type: "object", desc: "返回更新后的完整条目" }],
      },
      {
        key: "opening-delete",
        method: "DELETE",
        url: "/api/v1/agent-opening/:id",
        purpose: "删除一条开场。物理删除，不保留历史；要临时停发请改成 disabled。",
        auth: "admin",
        pathParams: [{ name: "id", type: "number", required: true, desc: "开场条目 id" }],
        responseFields: [{ name: "ok", type: "boolean", desc: "true 表示删除成功；id 不存在返回 404" }],
      },
      {
        key: "opening-reorder",
        method: "POST",
        url: "/api/v1/agent-opening/reorder",
        purpose: "按给定的 id 顺序重排全部开场。前端上移/下移后把完整顺序发过来，服务端在一个事务里重写 seq。",
        auth: "admin",
        bodyFields: [
          { name: "position_id", type: "number", required: true, desc: "岗位 id" },
          { name: "ids", type: "number[]", required: true, desc: "该岗位全部条目的新顺序；不能重复，不能混入别的岗位" },
        ],
        body: { position_id: 1, ids: [2, 1] },
        responseFields: [{ name: "items", type: "array", desc: "重排后的完整条目列表，可直接替换本地缓存" }],
        notes: ["ids 里有不属于该岗位的条目会返回 422，不会部分生效。"],
      },
    ],
  },
  {
    group: "Agent 会话",
    note: "输入是标准多轮 messages（system 放人设 + 事实 + 输出格式），输出是 JSON 字符串。回复里的金额必须能在岗位事实里找到，否则整条判失败。",
    endpoints: [
      {
        key: "context",
        method: "GET",
        url: "/api/v1/agent/context",
        purpose: "调试用：把这一轮模型会看到的东西摊开——岗位事实、人设全文、开场序列、模型是否配了 key。不调模型，不消耗 token。",
        auth: "admin",
        queryParams: [
          { name: "position_id", type: "number", desc: "岗位 id，与 device_code 二选一" },
          { name: "device_code", type: "string", desc: "设备号，服务端反查它绑的岗位" },
        ],
        responseFields: [
          { name: "position.id", type: "number", desc: "岗位 id" },
          { name: "position.name", type: "string", desc: "岗位名" },
          { name: "position.factory", type: "string", desc: "关联工厂名" },
          { name: "position.city", type: "string", desc: "关联城市名" },
          { name: "facts", type: "object", desc: "岗位事实，键为 city / factory_name / job_title / wage_text / hours_text / age_text / welfare_text / place / interview_time，空值不出现" },
          { name: "persona", type: "string", desc: "人设全文，没配为空串" },
          { name: "opening", type: "array", desc: "开场条目（id / seq / kind / content / media_name / delay_ms）" },
          { name: "llm.model", type: "string", desc: "当前使用的模型名" },
          { name: "llm.configured", type: "boolean", desc: "是否配了 AGENT_LLM_API_KEY" },
        ],
        response: {
          position: { id: 1, name: "普工", factory: "示例工厂", city: "广州" },
          facts: { city: "广州", wage_text: "22元/小时" },
          persona: "",
          opening: [],
          llm: { model: "deepseek-chat", configured: false },
        },
      },
      {
        key: "opening-list",
        method: "GET",
        url: "/api/v1/agent/opening",
        purpose: "客户端用：按设备号取它绑定岗位的人设与开场清单。客户端拿到后逐条发，发完一条上报一条。",
        auth: "device",
        queryParams: [{ name: "device_code", type: "string", required: true, desc: "设备号" }],
        responseFields: [
          { name: "position_id", type: "number", desc: "设备绑的岗位；0 表示没绑" },
          { name: "persona", type: "string", desc: "人设全文" },
          { name: "items[].seq", type: "number", desc: "发送顺序" },
          { name: "items[].kind", type: "string", desc: "text / image / video" },
          { name: "items[].content", type: "string", desc: "文本正文" },
          { name: "items[].media_name", type: "string", desc: "素材文件名" },
          { name: "items[].delay_ms", type: "number", desc: "这一条之后的等待时间" },
          { name: "detail", type: "string", desc: "设备没绑岗位时的原因说明" },
        ],
      },
      {
        key: "opening-log",
        method: "POST",
        url: "/api/v1/agent/opening/log",
        purpose: "客户端逐条上报开场结果。只记录、不驱动流程——推进靠客户端的发送回执，失败了也要上报，运营才能查到「哪张图没发出去」。",
        auth: "device",
        bodyFields: [
          { name: "session_key", type: "string", required: true, desc: "企微会话 id，最长 64" },
          { name: "device_code", type: "string", desc: "设备号" },
          { name: "position_id", type: "number", desc: "岗位 id" },
          { name: "seq", type: "number", desc: "第几条" },
          { name: "kind", type: "string", desc: "text / image / video" },
          { name: "status", type: "string", required: true, desc: "sent / failed / skipped / pending" },
          { name: "error", type: "string", desc: "失败原因，最长 500 字" },
        ],
        body: { session_key: "S:10001", device_code: "pc-win-01", position_id: 1, seq: 1, kind: "text", status: "sent" },
        responseFields: [{ name: "ok", type: "boolean", desc: "true 表示已记录" }],
      },
      {
        key: "chat",
        method: "POST",
        url: "/api/v1/agent/chat",
        purpose: "跑一轮对话：把人设、岗位事实、全量历史拼成 messages 发给模型，返回结构化 JSON。dry=true 时只回拼好的 messages，不调模型。",
        auth: "admin",
        bodyFields: [
          { name: "position_id", type: "number", desc: "岗位 id，与 device_code 二选一" },
          { name: "device_code", type: "string", desc: "设备号，服务端反查岗位" },
          { name: "text", type: "string", required: true, desc: "客户这一句" },
          { name: "history", type: "array", desc: "[{role:'customer'|'agent', text:'...'}]，按时间正序，全量传" },
          { name: "dry", type: "boolean", desc: "true 只返回 messages，不调模型" },
        ],
        body: { position_id: 1, text: "多少钱一小时", history: [], dry: true },
        responseFields: [
          { name: "ok", type: "boolean", desc: "这一步是否成功；金额护栏不过时为 false" },
          { name: "reply.messages[]", type: "array", desc: "要发给客户的消息，每项 {type: text|image|video, content 或 name}" },
          { name: "reply.capture", type: "object", desc: "从这句话里抽到的 name / phone / city / day；格式不合法的字段会被清空" },
          { name: "reply.handoff", type: "boolean", desc: "是否要转人工" },
          { name: "reply.done", type: "boolean", desc: "这单是否聊完" },
          { name: "raw", type: "string", desc: "模型返回的原文" },
          { name: "model", type: "string", desc: "实际使用的模型" },
          { name: "usage", type: "object", desc: "prompt_tokens / completion_tokens / total_tokens" },
          { name: "latency_ms", type: "number", desc: "模型调用耗时" },
          { name: "messages", type: "array", desc: "本轮实际发出去的 messages，便于复盘 prompt" },
          { name: "error", type: "string", desc: "失败原因：金额不在事实里、JSON 格式错、没配 key" },
          { name: "code", type: "string", desc: "错误码，例如 no_api_key" },
        ],
        notes: [
          "失败也返回 HTTP 200，调用方按 ok 判断，不要看状态码。",
          "回复里出现「N 元」「N/小时」但事实里没有这个数字，整条判失败并说明是哪个数字。",
          "没配 AGENT_LLM_API_KEY 时返回 ok=false、code=no_api_key，不会抛 500。",
        ],
      },
    ],
  },
  {
    group: "素材",
    note: "开场里的图片 / 视频按文件名引用。文件按 sha256 存，同名不同内容会覆盖记录，同内容不同名共用一份文件。",
    endpoints: [
      {
        key: "media-list",
        method: "GET",
        url: "/api/v1/media",
        purpose: "素材库列表，配置开场时用来选图选视频。",
        auth: "admin",
        responseFields: [
          { name: "items[].id", type: "number", desc: "素材记录 id" },
          { name: "items[].name", type: "string", desc: "文件名，开场里引用的就是它" },
          { name: "items[].kind", type: "string", desc: "image / video" },
          { name: "items[].sha256", type: "string", desc: "内容哈希，客户端下载后可校验" },
          { name: "items[].bytes", type: "number", desc: "文件大小" },
          { name: "total", type: "number", desc: "总数" },
        ],
      },
      {
        key: "media-upload",
        method: "POST",
        url: "/api/v1/media",
        purpose: "上传素材。前端把文件读成 base64 传上来，服务端解码后按内容哈希落盘。",
        auth: "admin",
        bodyFields: [
          { name: "name", type: "string", required: true, desc: "文件名，不能含路径分隔符，最长 200" },
          { name: "kind", type: "string", required: true, desc: "image / video" },
          { name: "data_base64", type: "string", required: true, desc: "base64，可带 data URL 前缀；解码后不能超过 20MB" },
        ],
        body: { name: "门头照.jpg", kind: "image", data_base64: "data:image/jpeg;base64,..." },
        responseFields: [
          { name: "id", type: "number", desc: "素材记录 id" },
          { name: "name", type: "string", desc: "文件名" },
          { name: "kind", type: "string", desc: "image / video" },
          { name: "sha256", type: "string", desc: "内容哈希" },
          { name: "bytes", type: "number", desc: "解码后大小" },
        ],
        notes: ["超过 20MB 返回 413；base64 不合法返回 422。"],
      },
      {
        key: "media-delete",
        method: "DELETE",
        url: "/api/v1/media/:id",
        purpose: "删除素材记录。文件本身不删——按 sha256 命名的文件可能被别的名字共用，清理要按引用计数单独做。",
        auth: "admin",
        pathParams: [{ name: "id", type: "number", required: true, desc: "素材记录 id" }],
        responseFields: [{ name: "ok", type: "boolean", desc: "true 表示记录已删" }],
        notes: ["删了记录但开场还在引用这个 name 时，那条开场会显示「文件不存在」。"],
      },
      {
        key: "media-download",
        method: "GET",
        url: "/api/v1/agent/media/:name",
        purpose: "客户端下载素材。设备令牌或服务令牌都能下，下载后按响应头的哈希校验。",
        auth: "device",
        pathParams: [{ name: "name", type: "string", required: true, desc: "素材文件名" }],
        responseFields: [
          { name: "（二进制）", type: "binary", desc: "文件内容，Content-Type 按扩展名给" },
          { name: "X-Content-SHA256", type: "header", desc: "内容哈希，客户端用来校验完整性" },
          { name: "Cache-Control", type: "header", desc: "private, max-age=3600" },
        ],
      },
    ],
  },
  {
    group: "岗位与设备",
    note: "设备绑定岗位（agent_devices.data_json.position_id），岗位关联工厂与城市。开场和人设都挂在岗位上，所以设备只是入口。",
    endpoints: [
      {
        key: "positions",
        method: "GET",
        url: "/api/v1/service-positions",
        purpose: "岗位列表。配置人设 / 开场时用来选岗位，前端也用它把表格行和岗位 id 对上。",
        auth: "user",
        queryParams: [
          { name: "page", type: "number", desc: "页码，默认 1" },
          { name: "page_size", type: "number", desc: "每页条数，配置页一般取 1000" },
        ],
        responseFields: [
          { name: "items[].id", type: "number", desc: "岗位 id" },
          { name: "items[].position_name", type: "string", desc: "岗位名" },
          { name: "items[].factory_id", type: "number", desc: "所属工厂 id" },
          { name: "items[].city_name", type: "string", desc: "城市名" },
          { name: "items[].store_name", type: "string", desc: "门店 / 基地名" },
          { name: "items[].interview_time", type: "string", desc: "面试时段，进 job_snapshot 的 interview_time" },
          { name: "items[]....", type: "mixed", desc: "另含 gender / age_range / height_require / address 等岗位字段" },
        ],
      },
      {
        key: "devices",
        method: "GET",
        url: "/api/v1/agent/devices",
        purpose: "设备列表，含绑定信息与在线状态。用来确认某台设备会取哪个岗位的人设和开场。",
        auth: "admin",
        responseFields: [
          { name: "items[].id", type: "number", desc: "设备记录 id" },
          { name: "items[].device_code", type: "string", desc: "设备号，开场清单接口要传它" },
          { name: "items[].name", type: "string", desc: "设备名" },
          { name: "items[].factory_name", type: "string", desc: "绑定的工厂" },
          { name: "items[].city", type: "string", desc: "绑定城市" },
          { name: "items[].status", type: "boolean", desc: "启用状态" },
          { name: "items[].online", type: "boolean", desc: "是否在线（心跳 90 秒内）" },
          { name: "items[].config", type: "object", desc: "设备侧配置：合并间隔、超时策略、事件规则等" },
        ],
      },
      {
        key: "cities",
        method: "GET",
        url: "/api/v1/agent/cities",
        purpose: "在招城市与区县清单。流程识别客户说的地名、判断有没有岗位时用。",
        auth: "admin",
        responseFields: [
          { name: "items[].city_name", type: "string", desc: "城市名" },
          { name: "items[].province", type: "string", desc: "省份" },
          { name: "items[].districts", type: "string[]", desc: "区县列表" },
          { name: "items[].neighbors", type: "string[]", desc: "周边城市，主城没单时推广用" },
        ],
      },
    ],
  },
  {
    group: "知识库",
    note: "存量接口，知识库配置页在用。品类 / 区域 / 招工方 / 场景问答 / 模板包，发布走 preview → apply。",
    endpoints: [
      {
        key: "verticals",
        method: "GET",
        url: "/api/v1/verticals",
        purpose: "品类列表。一个品类决定岗位表单长什么样（position_schema）、招工方叫什么（工厂 / 线路）。",
        auth: "user",
        responseFields: [
          { name: "items[].id", type: "number", desc: "品类 id" },
          { name: "items[].code", type: "string", desc: "factory / subway / white_collar …" },
          { name: "items[].name", type: "string", desc: "显示名" },
          { name: "items[].config", type: "object", desc: "解析后的配置：employer_label / location_levels / position_schema" },
          { name: "items[].config_json", type: "string", desc: "原始 JSON 字符串" },
        ],
      },
      {
        key: "locations",
        method: "GET",
        url: "/api/v1/locations",
        purpose: "区域树。层级是开放的：工厂到「园区 / 面试点」，保姆到「雇主家」，船员到「港口」。",
        auth: "user",
        queryParams: [
          { name: "level", type: "string", desc: "按层级过滤：province / city / district / park / point" },
          { name: "parent_id", type: "number", desc: "取某个节点的下级" },
          { name: "page_size", type: "number", desc: "每页条数" },
        ],
        responseFields: [
          { name: "items[].id", type: "number", desc: "区域 id" },
          { name: "items[].parent_id", type: "number", desc: "上级区域，顶层为 null" },
          { name: "items[].level", type: "string", desc: "层级" },
          { name: "items[].name", type: "string", desc: "名称" },
          { name: "items[].address", type: "string", desc: "详细地址" },
          { name: "items[].walk_guide", type: "string", desc: "步行指引，发定位时用" },
          { name: "items[].image_key", type: "string", desc: "路线图文件名" },
          { name: "items[].status", type: "string", desc: "enabled / disabled" },
        ],
      },
      {
        key: "employers",
        method: "GET",
        url: "/api/v1/employers",
        purpose: "招工方列表。工厂品类下就是「厂」；问答和话术按它收窄作用域，避免答成别家的政策。",
        auth: "user",
        queryParams: [
          { name: "vertical_id", type: "number", desc: "按品类过滤" },
          { name: "status", type: "string", desc: "enabled / disabled" },
        ],
        responseFields: [
          { name: "items[].id", type: "number", desc: "招工方 id" },
          { name: "items[].employer_code", type: "string", desc: "稳定编码，改名不影响历史引用" },
          { name: "items[].display_name", type: "string", desc: "全名" },
          { name: "items[].short_name", type: "string", desc: "简称，列表和答案里优先用它" },
          { name: "items[].vertical_id", type: "number", desc: "所属品类" },
          { name: "items[].location_id", type: "number", desc: "所在区域" },
          { name: "items[].aliases", type: "string[]", desc: "客户口语与错别字别名" },
        ],
      },
      {
        key: "kb-faqs",
        method: "GET",
        url: "/api/v1/kb-faqs",
        purpose: "场景问答列表。检索时按 position → employer → city → vertical → global 从窄到宽硬过滤，别家厂的条目不进候选集。",
        auth: "user",
        queryParams: [
          { name: "vertical_id", type: "number", desc: "按品类过滤" },
          { name: "scope_level", type: "string", desc: "position / employer / city / vertical / global" },
          { name: "scope_employer_id", type: "number", desc: "按招工方过滤" },
          { name: "scope_position_id", type: "number", desc: "按岗位过滤" },
          { name: "page_size", type: "number", desc: "每页条数" },
        ],
        responseFields: [
          { name: "items[].id", type: "number", desc: "问答 id" },
          { name: "items[].vertical_id", type: "number", desc: "限定品类；null 表示通用" },
          { name: "items[].scope_level", type: "string", desc: "作用域层级" },
          { name: "items[].scope_location_id / scope_employer_id / scope_position_id", type: "number", desc: "作用域绑定的具体对象" },
          { name: "items[].question", type: "string", desc: "问题（给人看的标题）" },
          { name: "items[].keywords", type: "string[]", desc: "命中词表，按命中字数打分" },
          { name: "items[].answer", type: "string", desc: "答案模板，可含 {wage} {welfare} {address} 等占位符" },
          { name: "items[].media", type: "string[]", desc: "随答案发送的素材标记" },
          { name: "items[].priority", type: "number", desc: "同层排序，越大越优先" },
          { name: "items[].status", type: "string", desc: "enabled / disabled" },
          { name: "items[].governance", type: "array", desc: "治理检查结果：共享层写死了厂规时这里会有提示" },
        ],
        notes: ["共享层（global / vertical / city）写死工价、厂规、费用会被治理检查拦下，必须用占位符引用本岗字段。"],
      },
      {
        key: "kb-audit",
        method: "GET",
        url: "/api/v1/kb-faqs/audit",
        purpose: "问答治理检查：一次性列出哪些条目有问题（共享层写死数字、带兜底模板、带媒体等）。",
        auth: "admin",
        responseFields: [
          { name: "items", type: "array", desc: "有问题的条目，每条含 id、question 与 governance 说明" },
          { name: "total", type: "number", desc: "问题条目数" },
        ],
      },
      {
        key: "kb-templates",
        method: "GET",
        url: "/api/v1/kb-templates",
        purpose: "模板包列表。新建品类或新客户时，用模板包一次性铺一批通用问答，导入后还能逐条改。",
        auth: "user",
        responseFields: [
          { name: "items[].id", type: "number", desc: "模板 id" },
          { name: "items[].code", type: "string", desc: "模板编码，例如 faq-factory-v1" },
          { name: "items[].name", type: "string", desc: "模板名" },
          { name: "items[].vertical_code", type: "string", desc: "适用品类" },
          { name: "items[].version", type: "number", desc: "版本号" },
          { name: "items[].status", type: "string", desc: "published / draft" },
          { name: "items[].item_count", type: "number", desc: "包含多少条问答" },
        ],
      },
      {
        key: "kb-import",
        method: "POST",
        url: "/api/v1/kb-templates/:code/import",
        purpose: "把模板包导入成场景问答。已存在同问题的条目会跳过，不覆盖运营改过的内容。",
        auth: "admin",
        pathParams: [{ name: "code", type: "string", required: true, desc: "模板编码" }],
        responseFields: [
          { name: "created", type: "number", desc: "新导入的条数" },
          { name: "skipped", type: "number", desc: "因为已存在而跳过的条数" },
        ],
        notes: ["导入不会动已有条目，重复导入是安全的。"],
      },
      {
        key: "kb-preview",
        method: "POST",
        url: "/api/v1/kb-publish/preview",
        purpose: "发布预览：只算「这次发布会产生哪些变更」，不落库。带版本号，确认后再 apply。",
        auth: "admin",
        bodyFields: [
          { name: "items", type: "array", required: true, desc: "本次要发布的共享问答全集；每项含 source_id / question / answer / keywords / priority / scope_level 等" },
          { name: "rollback_of", type: "string", desc: "回滚到某次发布：填那次 publication_id，且不能再传 items" },
        ],
        responseFields: [
          { name: "target_id", type: "string", desc: "目标实例 id，apply 时要原样带回" },
          { name: "target_revision", type: "string", desc: "当前知识库版本摘要" },
          { name: "target_generation", type: "number", desc: "发布代数，防并发" },
          { name: "payload_digest", type: "string", desc: "本次内容摘要，apply 时校验" },
          { name: "items", type: "array", desc: "规范化后的待发布内容" },
          { name: "changes", type: "array", desc: "变更明细：create / update / disable" },
          { name: "managed_count", type: "number", desc: "当前由发布通道管理的条目数" },
        ],
      },
      {
        key: "kb-apply",
        method: "POST",
        url: "/api/v1/kb-publish/apply",
        purpose: "执行发布。用预览返回的四个字段做乐观锁：实例、版本、代数、内容摘要，任一不一致就要求重新预览。",
        auth: "admin",
        bodyFields: [
          { name: "publication_id", type: "string", required: true, desc: "本次发布的唯一编号，重试时复用同一个" },
          { name: "expected_target", type: "string", required: true, desc: "预览返回的 target_id" },
          { name: "expected_revision", type: "string", required: true, desc: "预览返回的 target_revision" },
          { name: "expected_generation", type: "number", required: true, desc: "预览返回的 target_generation" },
          { name: "payload_digest", type: "string", required: true, desc: "预览返回的 payload_digest" },
          { name: "items", type: "array", required: true, desc: "与预览时完全一致的内容" },
        ],
        responseFields: [
          { name: "publication_id", type: "string", desc: "发布编号" },
          { name: "target_revision", type: "string", desc: "发布后的新版本摘要" },
          { name: "target_generation", type: "number", desc: "新的代数" },
          { name: "changes", type: "array", desc: "实际执行的变更" },
          { name: "managed_count", type: "number", desc: "发布后管理中的条目数" },
          { name: "replayed", type: "boolean", desc: "true 表示同编号重放，没有重复执行" },
        ],
        notes: ["删除是「停用」不是物理删：从 items 里去掉的条目会变成 disabled，保留审计。"],
      },
      {
        key: "kb-history",
        method: "GET",
        url: "/api/v1/kb-publish/history",
        purpose: "发布历史，最近 30 次。用于回溯「哪次发布改了哪些问答」。",
        auth: "admin",
        responseFields: [
          { name: "items[].id", type: "string", desc: "发布编号" },
          { name: "items[].created_at", type: "string", desc: "发布时间（UTC）" },
          { name: "items[].actor", type: "string", desc: "操作人；服务身份为 trusted-service" },
          { name: "items[].result", type: "object", desc: "那次发布的结果，含 changes 与计数" },
        ],
      },
    ],
  },
];

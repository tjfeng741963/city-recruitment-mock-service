# 接口清单（人设 / 开场 / Agent 会话）

> **改接口必须同步这份文件。** `npm run check:api` 会把下面标记区块里的接口
> 和 `src/modules/agent/agent-persona.routes.ts`、`agent-chat.routes.ts` 里
> 实际注册的路由做双向比对，少一个或多一个都会失败，CI 也会跑这一项。

## 基础地址

| 环境 | Base URL |
|---|---|
| 本地开发 | `http://127.0.0.1:8080` |
| 生产 | `http://119.91.113.100:4222` |

完整网址 = Base URL + 下表路径，例如：
`http://127.0.0.1:8080/api/v1/agent/chat`

鉴权：除特别标注外，都要带 `Authorization: Bearer <access_token>`，
其中标 **admin** 的接口还要求账号 `role=admin`。token 从登录接口拿。

---

## 一、登录与岗位列表

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v1/auth/login` | 无 | 账号密码换 token，body `{username,password}` |
| GET | `/api/v1/service-positions?page=1&page_size=1000` | 用户 | 岗位列表，前端用它拿岗位 id 与名称 |

登录示例：

```bash
curl -X POST http://127.0.0.1:8080/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"local-admin","password":"local-demo-only"}'
```

---

## 二、人设与开场（后台配置）

一个岗位一份人设；开场是这个岗位下按 `seq` 排序的条目，支持文本、图片、视频。

<!-- api-check:start -->

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v1/agent-persona?position_id=:id` | admin | 取该岗位的人设与全部开场条目 |
| GET | `/api/v1/agent-persona` | admin | 全量摘要，列表页显示「已配几条」用 |
| PUT | `/api/v1/agent-persona` | admin | 保存人设，body `{position_id,content,status?}` |
| POST | `/api/v1/agent-opening` | admin | 追加一条开场，自动排到末尾 |
| PUT | `/api/v1/agent-opening/:id` | admin | 改一条，body 可含 `kind/content/media_name/delay_ms/status` |
| DELETE | `/api/v1/agent-opening/:id` | admin | 删除一条 |
| POST | `/api/v1/agent-opening/reorder` | admin | 重排，body `{position_id,ids:[...]}` |

<!-- api-check:end -->

**开场条目的字段**

| 字段 | 类型 | 约束 |
|---|---|---|
| `kind` | string | `text` / `image` / `video` |
| `content` | string | `text` 必填，最多 2000 字 |
| `media_name` | string | `image` / `video` 必填，不能带路径分隔符 |
| `delay_ms` | number | 发完这条等多久，服务端夹到 `[2000, 60000]` |
| `status` | string | `enabled` / `disabled` |

保存人设示例：

```bash
curl -X PUT http://127.0.0.1:8080/api/v1/agent-persona \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"position_id":1,"content":"你是陈姐，在广东做工厂招工十几年……"}'
```

追加一条文本开场：

```bash
curl -X POST http://127.0.0.1:8080/api/v1/agent-opening \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"position_id":1,"kind":"text","content":"你好，我们这边在招普工","delay_ms":2000}'
```

---

## 三、Agent 会话（客户端 + 调试台）

<!-- api-check:start -->

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v1/agent/context?position_id=:id` | admin | 调试台用：事实 / 人设 / 开场 / 话术库 / 模型是否配置 |
| GET | `/api/v1/agent/opening?device_code=:code` | 设备令牌或服务令牌 | 客户端用：该设备绑的岗位 + 开场清单 + 人设 |
| POST | `/api/v1/agent/opening/log` | 设备令牌或服务令牌 | 客户端逐条回执：`{session_key,device_code,position_id,seq,kind,status,error}` |
| GET | `/api/v1/agent/archive?session_key=:key` | admin | 查面试档案：姓名 / 电话 / 城市 / 面试日期与时段（模型 JSON 判断结果累积） |
| POST | `/api/v1/agent/chat` | admin | 一轮对话，body `{position_id,session_key,text,dry}` |

<!-- api-check:end -->

**`/api/v1/agent/chat` 的请求**

| 字段 | 必填 | 说明 |
|---|---|---|
| `position_id` | 二选一 | 岗位 id |
| `device_code` | 二选一 | 也可以传设备号，服务端反查岗位 |
| `session_key` | 推荐 | 会话 id（客户端传企微会话 id）。传了走**服务端会话记忆**：全量上下文存 `agent_session` 表，成功一轮累积一轮，客户端不传历史；绑到别的岗位自动重置 |
| `text` | 是 | 客户这一句 |
| `history` | 否 | 仅无状态模式（没有 `session_key`）用：`[{role:"customer"\|"agent", text:"..."}]` |
| `dry` | 否 | `true` 只返回拼好的 messages，不调模型、不写会话 |

**返回**

```json
{
  "ok": true,
  "reply": {
    "messages": [{ "type": "text", "content": "22 一小时，包吃包住" }],
    "capture": { "name": "张三", "phone": "13800138000", "city": "", "day": "" },
    "handoff": false,
    "done": false
  },
  "scripts": ["S1 外宿人员嫌弃面试地址远", "S2 工资待遇不清晰/嫌低", "..."],
  "raw": "模型原文",
  "model": "deepseek-chat",
  "usage": { "prompt_tokens": 620, "completion_tokens": 48, "total_tokens": 668 },
  "latency_ms": 1180,
  "messages": [{ "role": "system", "content": "……" }]
}
```

**编排（2026-11-17 信任模式 + 服务端记忆）**：system = 人设（话术段落剥离）+
岗位事实 + 话术库（人设里 `[S1 标题]` 格式的段落）+ 输出规范。话术命中与
引用方式由模型自行判断，**没有代码级护栏**（原 guardScript 替换、
guardMoney 金额拦截已拆除，相信模型按 prompt 约束回答）。

**开场序列每轮由服务端注入**：position_opening 里启用的条目装成 assistant
历史放在最前面，模型知道「开场那串已经发过了」，能接住「你发的第二条说的
工资是多少」这类指代。运营改开场配置，下一轮对话即生效。

**会话记忆在服务端**（迁移 039 `agent_session` 表）：客户端只报
`session_key + 这句话`；成功一轮后客户这句与模型回复才写入上下文，失败不写
（客户端重试不会造成上下文重复）。不传 `session_key` 时退回无状态
`history` 参数（/dev 调试台兼容）。

多轮对话按 DeepSeek 无状态 API 的约定：服务端拼好完整 messages 调 API；
assistant 历史装回 JSON 信封（等价于「append 上一轮原始输出」），保证输出
格式不漂移。

失败时统一是 `{"ok": false, "error": "原因", "code": "no_api_key"}`，
HTTP 仍是 200——调用方按 `ok` 判断，不要按状态码。模型输出不是 JSON 时
`code=bad_json`，返回里带 `latency_ms` 与 `usage` 便于诊断。

---

## 四、素材

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v1/media` | admin | 素材库列表 |
| POST | `/api/v1/media` | admin | 上传，body `{name,kind,data_base64}`，单文件 ≤ 20MB |
| DELETE | `/api/v1/media/:id` | admin | 删记录（文件按 sha 复用，不删文件） |
| GET | `/api/v1/agent/media/:name` | 设备令牌 | 客户端下载素材 |

---

## 五、知识库配置（后台页面用）

这些是存量接口，`public/theme/kb-console.js` 在用。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/api/v1/verticals`，`/api/v1/verticals/:id` | 品类 |
| GET / POST | `/api/v1/locations`，`/api/v1/locations/:id` | 区域树 |
| GET / POST | `/api/v1/employers`，`/api/v1/employers/:id` | 招工方 |
| GET / POST | `/api/v1/kb-faqs`，`/api/v1/kb-faqs/:id` | 场景问答 |
| GET | `/api/v1/kb-faqs/audit` | 问答治理检查 |
| GET | `/api/v1/kb-templates`，`/api/v1/kb-templates/:code` | 模板包 |
| POST | `/api/v1/kb-templates/:code/import` | 导入模板包 |
| POST | `/api/v1/kb-publish/preview` | 发布预览 |
| POST | `/api/v1/kb-publish/apply` | 发布 |
| GET | `/api/v1/kb-publish/history` | 发布历史 |
| GET | `/api/v1/agent/devices` | 设备绑定列表 |

---

## 变更记录

| 日期 | 改动 |
|---|---|
| 2026-11-17 | Dify 全链路下线：删除 src/modules/dify、message-automation、activation、wecom-kf 路由模块与 webhooks/dify；入站消息改为只落库 + SSE 直发（inbound-store.ts）；设备接口不再返回/落库 dify 字段（迁移 041 清理 data_json）；后台设备页注入扫码登录面板（theme/device-qr.js）、绑定工厂 UI 重修 |
| 2026-11-17 | 接口精简：260 → 169 条。整体摘除 activation（含 dify 回调）/ knowledge 兼容 / unknown-questions / followup / wecom-kf / admin-overview 六组死模块；块级摘除旧岗位话术、流程节点图、老友池、候选人、评估、规则、邀约群、提醒、报表等旧链路路由；泛型注册表摘掉 knowledge/unknown-questions/rules/evaluations/activation 五行。保留 upload 与 manual-reply（编译页面在用）。/dev 目录 169 条全说明 |
| 2026-11-17 | chat 加进设备令牌直通清单（客户端对话链路 403 断点修复，路由内校验管理员或设备令牌）；/dev 目录全量覆盖 260 条路由（route-notes.ts 一句话说明 + 在用状态标记），未归类归零 |
| 2026-11-17 | chat 加 session_key 服务端会话记忆（迁移 039 agent_session）；开场序列每轮由服务端注入为 assistant 历史；客户端 brain 只传 session_key+这句话，删除本地历史构建 |
| 2026-11-17 | chat 拆除代码级护栏（guardScript 替换 / guardMoney 金额拦截 / script_used 声明），话术约束走 prompt 信任模型；assistant 历史装回 JSON 信封防格式漂移 |
| 2026-11-17 | chat 接口：assistant 历史由编排层装回 JSON 信封（防多轮格式漂移，实测修掉 5/16 轮解析失败）；金额护栏放行话术原文里的数字；解析失败返回 code=bad_json 且带 latency_ms/usage |
| 2026-11-17 | 删除旧「岗位话术 5 时点」接口（GET/POST/DELETE /api/v1/position-scripts）；8090 摘除 kb / kb_publish / lead / lead_board / flow / webhook 六组废弃路由；客户端 brain 切到 4222 的 agent/opening + agent/chat |
| 2026-11-17 | Agent 会话重构为受控编排（agent-orchestrator.ts）：话术库注入 + script_used 声明 + 原文比对护栏；agent/opening 与 opening/log 改为设备令牌或服务令牌鉴权 |
| 2026-11-16 | 新建：人设 / 开场 CRUD、Agent 会话四个接口、素材接口 |

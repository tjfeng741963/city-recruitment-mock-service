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
| POST | `/api/v1/agent/chat` | admin | 一轮受控对话，body `{position_id,text,history,dry}` |

<!-- api-check:end -->

**`/api/v1/agent/chat` 的请求**

| 字段 | 必填 | 说明 |
|---|---|---|
| `position_id` | 二选一 | 岗位 id |
| `device_code` | 二选一 | 也可以传设备号，服务端反查岗位 |
| `text` | 是 | 客户这一句 |
| `history` | 否 | `[{role:"customer"\|"agent", text:"..."}]`，按时间正序 |
| `dry` | 否 | `true` 只返回拼好的 messages，不调模型 |

**返回**

```json
{
  "ok": true,
  "reply": {
    "messages": [{ "type": "text", "content": "22 一小时，包吃包住" }],
    "capture": { "name": "张三", "phone": "13800138000", "city": "", "day": "" },
    "script_used": "S2",
    "handoff": false,
    "done": false
  },
  "script_replaced": false,
  "scripts": ["S1 外宿人员嫌弃面试地址远", "S2 工资待遇不清晰/嫌低", "..."],
  "raw": "模型原文",
  "model": "deepseek-chat",
  "usage": { "prompt_tokens": 620, "completion_tokens": 48, "total_tokens": 668 },
  "latency_ms": 1180,
  "messages": [{ "role": "system", "content": "……" }]
}
```

**受控编排（2026-11-17 起）**：system = 人设（话术段落剥离）+ 岗位事实 +
话术库（人设里 `[S1 标题]` 格式的段落）+ 输出规范。模型声明 `script_used`
命中某类话术时，输出必须来自该类原文；跑偏会被 `guardScript` 整条替换回
原文（`script_replaced=true`），原文比模型的转述更可信。多轮对话按 DeepSeek
无状态 API 的约定：每轮把上一轮 assistant 输出 append 回 messages 末尾。

失败时统一是 `{"ok": false, "error": "原因", "code": "no_api_key"}`，
HTTP 仍是 200——调用方按 `ok` 判断，不要按状态码。

金额护栏：回复里出现的「N 元」「N/小时」必须能在岗位事实里找到，
否则 `ok=false`，`error` 说明是哪个数字对不上。

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
| 2026-11-17 | chat 接口：assistant 历史由编排层装回 JSON 信封（防多轮格式漂移，实测修掉 5/16 轮解析失败）；金额护栏放行话术原文里的数字；解析失败返回 code=bad_json 且带 latency_ms/usage |
| 2026-11-17 | 删除旧「岗位话术 5 时点」接口（GET/POST/DELETE /api/v1/position-scripts）；8090 摘除 kb / kb_publish / lead / lead_board / flow / webhook 六组废弃路由；客户端 brain 切到 4222 的 agent/opening + agent/chat |
| 2026-11-17 | Agent 会话重构为受控编排（agent-orchestrator.ts）：话术库注入 + script_used 声明 + 原文比对护栏；agent/opening 与 opening/log 改为设备令牌或服务令牌鉴权 |
| 2026-11-16 | 新建：人设 / 开场 CRUD、Agent 会话四个接口、素材接口 |

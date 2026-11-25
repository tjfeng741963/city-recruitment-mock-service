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

城市列表与详情的 `recruitment_status` 由系统根据设备与岗位绑定计算。存在已启用设备绑定本城的已启用岗位时返回 `active`，其余返回 `inactive`。列表状态筛选与详情使用同一结果。设备在线情况看微信账号页，岗位启用情况看岗位详情。

城市基础资料使用 `PATCH /api/v1/cities/:id` 保存，可提交 `city_name`、`province` 和 `districts`。省略的字段保留，保存时记录城市历史。城市默认资料继续使用下文的资料接口维护。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v1/auth/login` | 无 | 账号密码换 token，body `{username,password}` |
| GET | `/api/v1/service-positions?page=1&page_size=1000` | 用户 | 岗位列表，前端用它拿岗位 id 与名称 |

岗位列表和详情的 `is_active` 反映已保存的岗位启用状态，旧数据同样适用。

岗位创建 `POST /api/v1/service-positions` 会将所属城市的工资、工时、招聘要求、社保及面试时间/地址复制到空白岗位字段；只在创建时执行，修改城市不会覆盖已有岗位。岗位更新 `PUT /api/v1/service-positions/:id` 将表单资料映射为当前 Agent 事实，`is_active` 同步 SQL 状态；停用后停止下发开场并拒绝真实回复。

登录示例：

```bash
curl -X POST http://127.0.0.1:8080/api/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"local-admin","password":"local-demo-only"}'
```

---

## 系统 Agent 大模型

管理员从「设置 → Agent 服务配置 → 系统 Agent 大模型」管理正式回复用的模型。模型 API URL 填供应商提供的 OpenAI 兼容 HTTPS 基础地址，包含供应商要求的版本路径。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/settings/agent/model` | 返回生效 URL、模型、配置来源、版本号、Key 是否已配置，以及生产配置指定的 `settings_https_url` |
| POST | `/api/v1/settings/agent/model/models` | 提交 `base_url` 和 `api_key`，读取供应商 `GET /models` 返回的模型 ID |
| POST | `/api/v1/settings/agent/model/test` | 带当前 `revision`、连接参数和 `model` 发起一次真实测试，验证 Agent 回复格式并返回五分钟内有效的 `test_id` |
| PUT | `/api/v1/settings/agent/model` | 使用测试过的参数和 `test_id` 启用配置，返回新的生效状态和版本号 |

Key 由服务端加密保存，接口响应只显示是否配置。同一地址换模型时可留空沿用当前 Key。供应商未提供模型目录时可直接输入模型 ID。正式 Agent 接待请求使用最新生效配置，无需重启进程。Web 管理配置前，Agent 使用部署环境中的模型参数。

生产管理员各用自己的账号登录 `https://119.91.113.100/settings`，启用的模型配置对系统 Agent 全局生效。旧的 HTTP 页面会显示 HTTPS 入口链接。旧端口继续服务现有 Windows 客户端。Caddy 在公网 80 完成证书校验并自动续期，在 443 提供 HTTPS，仅通过宿主机回环端口 14222 访问设置监听器。

持久化加密使用 `AGENT_LLM_CONFIG_SECRET`，缺省时从生产登录签名密钥派生。启用后应保留原加密密钥供重启和数据库备份恢复使用。

## 岗位工作地址与面试点

岗位详情和保存沿用 `/api/v1/service-positions` 系列接口。岗位响应带有所属 `city_id`，用于准确回填城市。网页表单提交 `work_address` 与 `interview_address`，分别表示工作地址和默认面试地址。已有的 `address` 单地址记录仍可读取。用户通过新表单保存后，两个地址独立存储，旧客户端可继续读取兼容字段 `address`。

`interview_points` 接受旧名称字符串及 `{name,address,interview_time?,checkin_guide?,favorite_title?}` 对象。Dify 正式预约使用所选点的地址和专属时间，未设时间沿用默认日程。收到到场消息时按登记的点名和地址查找专属指引。Agent 将各点的地址、专属时间与指引加入咨询上下文。城市资料对 Dify 的默认取值优先级沿用原有规则。

`favorite_title` 是企微收藏位置卡的完整名称，支持最多 100 个字符的单行文字。`favorite_delay_ms`（0 到 60000）保存 Dify 在已确认面试点、求职者索要定位时，从地址文字发出到位置卡的计划间隔。空标题清除绑定和间隔。管理员调用 `POST /api/v1/agent/chat`（`dry` 或 `preview`）或 `POST /api/v1/dify/preview`（`dry`）询问面试定位时，可读取 `favorite_location_preview`。返回 `needs_point`、`not_configured`、`position_disabled` 或 `windows_unavailable`。Dify 命中已配置点时还返回 `trigger` 与 `after_address_delay_ms`。预览不下发发送任务，收藏名称保持独立于模型输入。

管理员的 `GET/PUT /api/v1/agent-flow` 支持在节点 `parts` 中保存 `favorite_location`、所属岗位面试点名称 `interview_point`、本条开始前等待 `delay_before_ms` 及完成后间隔 `delay_ms`。消息顺序以 `parts` 顺序为准。位置卡仍待 Windows 接入，因此当前设备流程 `GET /api/v1/agent/flow` 和旧开场兼容序列会过滤该动作。启用的流程节点须保留至少一条可执行消息，不含其他内容的位置卡节点可保存为停用草稿。

## 微信账号列表的回复来源

`GET /api/v1/agent/devices` 沿用登录鉴权及用户设备范围过滤，`items[]` 新增安全字段 `reply_provider: "agent" | "dify"`。只有配置值为 dify 时返回 dify，其余与实际运行默认一致返回 agent；不返回 Dify 密钥或连接凭据。页面用该字段展示回复来源并选择入口，不通过 GET 改变来源。已配对设备额外返回 bridge_state（online、offline 或 scanning）和 last_heartbeat_at（UTC ISO 8601 或 null）。只有启用设备在 60 秒内上报 online 时，online 和 status 才为 true。`is_enabled` 为账号的后台启用状态，供城市接待设置筛选账号。已启用的离线账号也可绑定岗位。

支持新版运行状态的设备会附带 windows_runtime，包含 connected、wecom_available、reply_ready、reason、sync、backlog。桥接心跳可上报 runtime，服务器只保存状态枚举与计数。超过 60 秒未刷新则标记离线并停止领取网页发送指令。旧客户端继续使用原心跳契约。

账号列表的 `position_id`、`factory_ids` 和 `factories` 按 Windows 已确认的回复来源返回。Agent 显示一个接待岗位和该岗位所属工厂，Dify 显示默认岗位和多工厂接待范围。保存接待设置时，`PUT /api/v1/agent/devices/:id` 按当前来源写入对应配置。网页提交 `expected_reply_provider`，来源已变化或正在切换时返回 409。旧账号沿用原接待岗位，Dify 的多工厂配置随切换保留。

GET /api/v1/agent/devices/:code/login-qr 保留原 available 与可用图片字段。另返回 login_status，区分 logged_in、waiting_for_scan、waiting_for_qr、qr_expired、disconnected、device_disabled 和 authorization_failed。新鲜企微登录心跳可确认登录完成，超过两分钟的二维码截图不再返回。限时安全验证由操作者在 Win 的官方企业微信窗口完成。

网页通过 `POST /api/v1/agent/devices/:code/verify-code` 提交手机企微显示的验证码或按企微要求收到的短信验证码。沿用用户设备范围校验，设备必须启用。请求体为 `{code: string}`，接受 4–8 位数字并保留前导零。响应为 `{ok: true, verification_status: "pending"}`。验证码只保存在服务进程内存中，最长两分钟。

`GET /api/v1/agent/devices/:code/verify-code` 仅接受该启用设备自己的桥接令牌。返回 `{available: true, code, at}` 后立即清除验证码，未提交、已领取或已过期时返回 `{available: false}`。响应禁止缓存。网页从 `login-qr` 读取本次提交的可选状态 `verification_status`，包括 `pending`（待领取）、`received`（服务端已下发）、`expired`（两分钟内未领取）与 `unconfirmed`（下发一分钟后仍未确认登录）。登录成功沿用企微登录心跳。

POST /api/v1/agent/devices/:code/login-qr/refresh 让客户端刷新登录二维码。只在设备启用且桥接状态 online 时接受，写一条 `kind=refresh_login_qr` 的指令（无正文、不关联客户）；同一设备 60 秒内重复请求只入队一条，返回 `{queued, command_id, deduped}`。客户端领到后点击企微登录窗的「刷新」，等待约 4 秒再立即截取新码上传；超过 5 分钟未领取的指令作废。该指令不受「回复就绪」门槛限制——二维码过期时本来就无法回复。

账号页“工作流配置”统一进入话术流程画布。系统 Agent 按绑定的岗位打开流程，Dify 用 `/recruitment-flow?test_engine=dify&device_code=...` 打开接待测试，并选中有权访问的账号。旧 `/dify-connection` 返回 302，保留设备码和岗位参数。账号回复来源仍由专用接口读取和显式保存，模拟回复通过隔离预览接口调用。

## 设备人工发送队列的只读检查

`GET /api/v1/bridge/devices/:code/config` 使用对应设备的 Bearer token（服务间调用沿用 `X-Profile-Token`）。响应新增 `command_queue: {queued: number, claimed: number, unknown: number}`，默认均为 0。统计仅覆盖该设备、包含全部历史记录，不受最近 50 条列表限制，不返回客户或消息正文。

Agent 的下发配置带当前单岗 `position_id`（已绑定时），岗位话术只含该岗位与通用条目。Dify 继续按工厂接待范围下发。

该 GET 不领取任务、不回收过期租约、不改变任何任务状态；队列计数为实时值，不参与配置 `version`。启动前应读取本次响应的计数，不能复用旧缓存；`queued` 或 `claimed` 非零时先核对原任务，`unknown` 需人工核对送达结果，不应盲目重发。字段缺失表示服务尚未支持统计，不能当作队列为空。此字段仅用于检查，不会自动启动或暂停客户端。

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
| POST | `/api/v1/agent-opening/batch-delete` | admin | 一次删除本岗位选中的条目。提交 `position_id`、`ids` 及读取开场时返回的 `opening_revision`（请求参数名 `revision`）。列表变更时返回 409。 |
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
| GET | `/api/v1/agent/context?position_id=:id` | admin | 调试台用：事实 / 人设 / 开场 / 话术库 / 适用问答 knowledge / 资料来源 / 模型是否配置 |
| GET | `/api/v1/agent/opening?device_code=:code` | 设备令牌或服务令牌 | 默认保持旧开场；显式加 `mode=flow` 只展开首个等待闸门前的流程消息；岗位停用时返回空清单和“岗位已停用” |
| POST | `/api/v1/agent/opening/log` | 设备令牌或服务令牌 | 客户端逐条回执：`{session_key,device_code,position_id,seq,kind,status,error}`，返回 `trace_id` 供运营回查发送证据 |
| GET | `/api/v1/agent/archive?session_key=:key` | admin | 查面试档案：姓名 / 电话 / 城市 / 面试日期与时段（模型 JSON 判断结果累积） |
| GET | `/api/v1/agent/archive/list` | admin | 面试登记清单。`has_conversation` 表示精确关联到一条会话。Dify 的 `group_chat` 显示通知对应的目标。状态包括 `no-group`（未绑群）、`group-unavailable`（无法确认目标群）、`pending`、`queued`、`claimed`、`sent`、`failed`、`unknown`。核对目标群的真实设备成功回执后显示 `sent`。 |
| POST | `/api/v1/agent/archive/manual` | admin | 手动新建约面试（没走 Agent 对话的客户），绑了群聊自动推送；可选 `position_id`（决定群消息里的工厂与岗位）、`remark`（备注，即群里认人的微信名称） |
| PUT | `/api/v1/agent/archive/:key/arrival` | admin | 到达状态标记，body `{arrival_status: ""/arrived/noshow}` |
| PUT | `/api/v1/agent/archive/:key/remark` | admin | 面试登记备注，body `{remark}`（≤64 字）。备注优先于客户企微昵称，决定群通知里姓名后面那一段；只影响之后的群通知，不重发已推送的消息 |
| POST | `/api/v1/agent/archive/:key/followup-summary` | admin | 读取当前登记精确关联的近期对话，按需生成跟进摘要 `{intent,discussed,experience,next_question,quote}`。字段无依据时返回 null。无会话或候选人文字时返回 409。结果仅用于网页，生成操作不清未读、不改登记、不发消息。 |
| GET | `/api/v1/agent/candidates?status=&recruiter_id=&event_date=&interview_date=&page=&page_size=` | admin | 候选人员管理：由面试登记聚合出候选行 + 分页统计 |
| GET | `/api/v1/agent/candidates/:key/messages?before_id=` | admin | 只读查看登记对应的真实对话，按精确 session_key 关联设备及客户；每页最多 200 条，不清未读、不发送 |
| POST | `/api/v1/agent/chat` | admin/设备令牌 | 一轮对话，body `{device_code,position_id,session_key,text,dry,sent_summary?}`。设备令牌须匹配设备码，Agent 只能读取该设备绑定的岗位。管理员可按岗位独立试答。生成期间来源或岗位发生变化时，暂停旧回复并返回 `agent_binding_changed`。 |
| GET | `/api/v1/agent/execution-traces?trace_id=&session_key=&device_code=&position_id=&limit=` | admin | 查询试答或正式会话的岗位、资料来源、流程版本和结果证据 |
| POST | `/api/v1/agent/execution-traces` | admin/设备令牌 | 为客户端直接执行的流程节点创建执行记录，返回 `trace_id` |
| POST | `/api/v1/agent/execution-traces/:trace_id/delivery` | admin/设备令牌 | 客户端回传真实发送结果：`{status,message_id,detail,device_code,session_key,node_key}` |
| GET | `/api/v1/agent-flow?position_id=:id` | admin | 读取岗位节点流程、节点、边和画布视口 |
| PUT | `/api/v1/agent-flow` | admin | 事务保存整张流程图并递增 version |
| POST | `/api/v1/agent-flow/migrate` | admin | 从旧 `position_opening` 生成停用的初始流程 |
| GET | `/api/v1/agent/flow?device_code=:code` | 设备令牌 | 客户端读取设备岗位的启用流程 |
| GET | `/api/v1/agent/state?device_code=:code` | 设备令牌；`summary=1` 仅管理员 | 客户端读取会话状态用于重连对账；管理员读取单设备去标识汇总 |
| POST | `/api/v1/agent/state` | 设备令牌 | 客户端批量上报会话阶段和流程快照 |
| GET | `/api/v1/agent/config-sync?device_code=:code` | admin | 单设备最近配置拉取摘要；未上报不推断已同步 |
| POST | `/api/v1/agent/config-sync` | 对应设备令牌 | 上报客户端实际检查/同步的流程与旧开场版本，不含正文 |

<!-- api-check:end -->

**Dify 第二回复路线（按设备）**

模式二优先读取「编辑岗位」已保存的同名字段，空白项沿用城市资料或旧岗位事实。有效资料变更后，下轮会建立新的 Dify 模型会话，招聘会话及报名状态沿用原记录。适用知识来自 `kb_faq` 中已启用并通过校验的通用及当前岗位问答。

每轮输入限制在 Dify 的 20000 字符以内：关键工资/时间/地点完整保留，原文段落和知识按本轮问题相关性选取完整条目，`retrieval.omitted` 显示未进入本轮的条目数；关键字段本身过长时返回 `dify_context_too_large`，不截断事实。保存资料不等于所有条目每轮都进入模型。生成前后仍对完整城市/知识上下文核验，变化时暂停旧回复。

Dify 的 `city_materials` 保留原接口名称，内容含当前生效的岗位表单和城市段落。试答的 `sources.fields` 和 `sources.sections` 展示来源，值为 `position`（岗位表单）、`city`（城市默认）或 `position_fallback`（旧岗位事实）。报名表单和面试通知供咨询回复使用。正式登记通过招聘流程确认和校验。

城市资料接口还接受 `knowledge_vertical_id:number|null`：显式绑定一个启用的知识品类，或留空。仅模式二读取该品类的通用/品类问答模板，并用当前城市与岗位事实渲染；仍读取无品类通用问答和当前岗位问答。不猜测品类、不混用历史城市/岗位编号、不改变模式一。取数依据 `sources.knowledge_vertical_id` 返回选择结果。面试地址与指引出现明确楼层冲突时返回 `dify_context_conflict`，暂停生成；`place` 保持工作地点，独立于 `interview_address`。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| PUT | `/api/v1/dify/cities/:id/materials` | 城市访问权限 | 合并保存城市默认资料。支持 `salary`、`work_hours`、`requirements`、`interview`、`prompt_sections`、`prompt_section_labels`、`social_insurances`、`interview_site_name` 和 `available_lines`，保留未提交字段和原嵌套键，写入城市历史 |
| POST | `/api/v1/dify/preview` | admin | `{position_id,text,dry:true}` 查看实际城市/岗位回退来源与适用知识；非 dry 需独立 `session_key:dify-preview:...`，生成模拟回答，不发送消息、不切换设备 |

首页 `/api/v1/agent/status/dashboard` 的 `errors.failed_today/ai_abnormal/dify_health/degraded` 读取北京时间当天真实 Dify 调用记录，按设备权限过滤；`queue.pending` 读取实际待发/已领取桥接命令。普通发送失败不计为 Dify 调用失败。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /api/v1/agent/devices/:code/reply-mode | admin | 读取设备已确认来源、目标、阶段、客户端最近确认时间、等待秒数和阻塞原因 |
| POST | /api/v1/agent/devices/:code/reply-mode | admin | {provider} 发起切换，{cancel:true,id} 发起已编号的撤回 |
| POST | /api/v1/bridge/devices/:code/reply-mode | 对应设备令牌 | 查询及上报切换。prepared 表示当前发送任务及回执已处理，applied 需要对应 id 和 provider。返回持久化切换状态 |
| GET | `/api/v1/agent/devices/:code/reply-provider` | admin | 返回 `{provider:agent/dify,configured:boolean}`，不返回密钥 |
| PUT | `/api/v1/agent/devices/:code/reply-provider` | admin | body `{provider:agent/dify,fresh_client_state_confirmed:true}`；兼容旧客户端的手动方式。客户端报告支持新切换后必须走 reply-mode |

设备选 Dify 后，`GET /agent/opening` 返回空清单与 `provider:dify`。`POST /agent/chat` 默认使用绑定岗位。求职者明确提到的城市在设备绑定范围内且只有一个可匹配岗位时，该会话切换到对应岗位，直接咨询使用该岗位资料。多个匹配岗位由求职者选择，超出绑定范围时说明该城市暂无可推荐岗位。素材请求缺少主题时，系统追问并在同一会话、同一岗位的下一轮保留所需的图片或视频类型，有效期为 5 分钟。返回兼容的 `reply.messages`。设备令牌必须匹配 `body.device_code`，Dify 模式要求 `session_key`。`dry:true` 返回中性岗位输入且不调用模型。Dify 会话以设备、当前登录账号、联系人、岗位和应用配置隔离。失败返回 `ok:false,provider:dify,code,error`，金额不在当前事实中时暂停发送。

模式二收到明确的图片、视频或面试导航请求时，服务端直接读取现有素材库与所选岗位面试点。回复按现有客户端协议返回文字和 `{type:"image"|"video",name,content}`，其中 `content` 用于网页试答展示素材名称。客户端下载沿用 `GET /api/v1/agent/media/:name`，模式二使用含文件哈希的名称，避免同名素材更新后复用旧文件。发送前查找启用且文件存在的岗位素材。地铁品类使用已有的通用工作图、工作视频和宿舍图。面试图仅用于绑定了该素材且只有一个面试点的岗位。导航以该面试点的地址生成高德地图搜索链接。多个面试点且提问没有指定其一时先要求选择。地图搜索结果需以随消息附上的详细地址核对。

模式二支持「推荐岗位」「选择岗位 编号」「查看面试安排」「报名」「确认报名」。岗位从设备已绑厂区或默认岗位所属城市中取，选岗按设备、账号和会话保存，换岗后模型会话按岗位区分。后台校验日期、星期、休息日、时段和面试点，资料变化后重新要求确认。有可核对的面试计划、同设备已关联的企微单聊和明确确认时，事务式写入 `agent_archive`。用同一会话重复确认返回已保存结果。查询候选人和面试登记返回 `interview_point`、`interview_address`，可按档案 ID 查看该会话。管理员预览只模拟确认，不新增真实面试记录。

Dify 会话与调用表为 `dify_reply_sessions`、`dify_reply_calls`（迁移 047）；调用表只记录状态、错误码及耗时。迁移 048 增加 `dify_recruitment_state` 和现有档案的面试点及会话关联字段。

**`/api/v1/agent/chat` 的请求**

候选人完整名单只读汇总 `agent_conversations`、历史 `candidate_events` 和 `agent_archive`，按精确设备/客户关联去重，不按昵称或手机合并。`status=all` 返回全部，另支持 `communicating/pending_information/invited/disqualified/checked_in`；普通对话默认沟通中，报名成功按明确记录判定。最新事件决定状态，旧事件可补齐已知资料；会话重启后不被旧事件恢复旧状态。档案姓名/电话/面试安排优先，缺失姓名、地区或招聘项目可从精确关联的会话补充；返回 `device_code/customer_id/has_conversation/province/city/district/remind_status`。手动登记保留原始录入资料和设备，返回实际保存的 session_key；没有真实会话时不按昵称或电话猜测关联。候选人页每 15 秒刷新可见页面，面试登记修改或标记到达后同步反映。

对话记录支持档案 session_key、`conversation:主键` 和 `event:主键` 的精确关联，不要求先有面试档案。GET 返回 `{conversation,items,has_more}`，`items` 按消息 ID 升序；`before_id` 向前翻页。提醒状态来自实际提醒任务状态或既有提醒计数，不把群聊转发成功当作已经提醒本人。

`dry:true` 返回岗位事实和适用问答 `knowledge:[{id,question,answer,scope}]` 及 prompt，不调用模型、不写业务状态。`preview:true` 仅管理员可用，禁止同时传 `session_key` 或 `device_code`；调用现有非思考模型生成模拟回答，在任何会话/档案/群通知写入前返回。

素材上传 `POST /api/v1/media` 若提供 `position_id>0`，会校验岗位存在，不存在返回 422。网页上传开始时固定目标岗位，文件读取期间切换页面不会把文件误绑到其他岗位。

运行链路每轮读取启用且通过治理检查的通用问答（无品类限定）和本岗位专属问答。共享占位符按岗位事实渲染，缺字段的答案跳过；其他品类、城市及招工方限定的历史问答不自动泛用。知识库保存即对下一轮 Node Agent 调用生效，旧 Python 发布入口不参与此链路。流程等待闸门的推进方式不因本次问答接线改变。

| 字段 | 必填 | 说明 |
|---|---|---|
| `position_id` | 二选一 | 岗位 id |
| `device_code` | 二选一 | 也可以传设备号，服务端反查岗位 |
| `session_key` | 推荐 | 会话 id（客户端传企微会话 id）。传了走**服务端会话记忆**：全量上下文存 `agent_session` 表，成功一轮累积一轮，客户端不传历史；绑到别的岗位自动重置 |
| `text` | 是 | 客户这一句 |
| `history` | 否 | 仅无状态模式（没有 `session_key`）用：`[{role:"customer"\|"agent", text:"..."}]` |
| `dry` | 否 | `true` 只返回拼好的 messages，不调模型、不写会话 |
| `sent_summary` | 否 | 已真实发送的流程摘要数组，最多 50 项；显式传空数组也会停止注入完整旧开场，省略则保持旧客户端兼容 |
| `ordered_reply` | 否 | Windows 支持 Dify 有序发送时传 `true`。Dify 返回按发送顺序排列的 `reply.messages` 和对应的 `reply.delays_before_ms`。首项为 0，其余是上一条发送确认后到本条的最小等待毫秒数。缺省时兼容旧客户端。 |
| `turn_id` | 否 | Dify 设备的本轮入站消息 ID。连发文本在 `text` 中用换行分隔。相同设备、账号、会话和轮次短时重试时复用已生成的最新发送计划。 |

Dify 有序回复支持 `text`（`content`）、`image` 和 `video`（`name` 为系统素材引用）。同一轮只下发当前应发的内容，城市、意向、面试时间和报名确认由服务端按会话推进。`/api/v1/dify/preview` 显示有序回复，不产生真实发送、登记或面试提醒指令。正式登记成功后可按服务端配置加入面试当天提醒，Windows 从现有桥接队列领取已到时的任务。

`dry=true` 返回的 `messages` 是实际模型请求使用的完整 prompt，可用于核对事实是否进入模型上下文。事实区包含岗位基本字段，以及面试时间说明、面试地址、面试材料、基本招聘要求、入职注意事项、通用素材清单 `media_catalog` 和本岗位启用的面试图片/视频 `interview_address_image`、`interview_video`；事实标签同时显示字段 key。其他岗位专属素材及停用素材不注入。素材出现在 prompt 只证明模型可选用该素材，不代表客户端已经发送或客户已经收到。

**节点流程配置与状态（2026-11-19）**

- `GET /agent/opening` 响应和 `GET /agent-persona?position_id=` 响应新增 `opening_version`：SHA-256（64 位十六进制），由共享算法对 `position_id` 与启用开场的 `seq,kind,content,media_name,delay_ms` 规范化计算；不包括人设、数据库 ID 或更新时间。顺序、增删、文字、素材、间隔和岗位变化会改变版本，空清单也有稳定版本。正常旧开场响应与岗位管理员响应使用同一版本；设备未绑定、岗位停用或 Dify 模式的设备空清单按实际 `position_id + []` 计算版本，`mode=flow` 按其实际展开清单计算。
- 设备 `POST /agent/config-sync`：`{device_code,client_commit,flow:{position_id,version,status,synced_at,checked_at,state,error},opening:{position_id,version,synced_at,checked_at,state,error}}`，只允许设备令牌上报自身且设备必须启用。流程 version 为非负整数或 null，旧开场 version 为 64 位 SHA-256 或 null；初始未知的岗位、版本、状态和时间允许 null。状态为 `synced/stale/blocked/error`；错误只允许空串或短码 `auth/network/http/invalid_response/cache/read/write/unknown/timeout`，不接受异常正文。时间要求带时区 ISO 8601 并规范化为 UTC `Z`；`checked_at` 是最近检查、`synced_at` 是最近成功拉取，不能混用。40 位十六进制 `client_commit` 才保留，无效或缺失归为 null。
- 同步摘要仅白名单存入 `agent_devices.data_json.config_sync`，其余传入字段丢弃。服务端生成 `server_received_at`，POST 返回 `{ok:true,server_received_at}`。管理员 GET 必须指定单设备码。返回 `{available,device_code,reply_provider,bridge_state}`，有报告时另含 `client_commit,flow,opening,server_received_at`。回复来源为 agent 或 dify，企微桥接状态为 online、offline、scanning 或 null，不含 token、客户正文或会话快照。该摘要仅证明客户端配置拉取，不等于企微在线或消息已送达。

- `PUT /agent-flow`：传 `position_id, version, entry_key, status, nodes, edges, canvas`。`version` 不匹配返回 409；前端必须携带读取时版本，重新载入后再编辑。`status=disabled` 保存草稿，启用时校验文本数字是否存在于本岗位事实字段。数字集合校验只能挡住未知数字，不能替代工价含义与单位的人工审核。
- 节点 `node_type` 仅为 `text/image/video/followup/branch/end`；等待使用独立布尔 `await_reply`。`parts` 为数组，每节点 1–6 条，文本每条最多 2000 字；`followup` 仅允许一条文本且 `max_times` 固定为 1。`branch/end` 不带消息。媒体必须来自本岗位或通用池。
- 边字段 `from_key,to_key,trigger,condition_value,priority`；`to_key=""` 表示结束。等待节点用 `any_reply/keyword` 进入后续节点；`timeout` 只指向一次性复聊；分支需要 `default` 兜底。孤儿节点、循环、非法出口均拒绝保存。
- 节点 `status=disabled` 时保留其节点与连接供后台编辑；Windows 客户端跳过该节点内容，只沿 `default` 或 `any_reply` 主兜底继续，不执行其关键词/超时条件。等待节点和分支节点按优先级从高到低执行不区分大小写的关键词包含匹配；分支未命中时沿 `default` 出口继续。启用的复聊节点仍必须由启用的等待节点通过唯一 `timeout` 边进入。在途会话使用已存流程快照，不因新版本保存而重写。
- `/agent/flow`、`/agent/state` 的逐会话状态只接受对应 `device_code` 的设备令牌。流程停用时下发空节点阻止新会话，已开始会话保留本地快照。
- 管理员可只读调用 `GET /agent/state?device_code=:code&summary=1`，必须指定单个设备码。响应 `{device_code,items:[{position_id,flow_version,node_key,phase,count,updated_at}]}` 按岗位、流程版本、节点和阶段汇总，`updated_at` 为组内最新上报时间，统一返回带 `Z` 的 UTC ISO 8601 格式；不返回会话 ID、会话名、错误详情、正文或快照。该镜像汇总不能证明企微消息已经送达。管理员不能通过此接口读取逐会话明细，设备令牌不能使用管理员汇总模式。
- `POST /agent/state`：`{device_code,items:[{session_key,position_id,flow_version,node_key,step_index,phase,revision,await_since,followup_sent_at,followup_round,snapshot,conv_name,wait_minutes,last_inbound_at,last_error}]}`，每批最多 200 条。两个等待/复聊时间字段使用 ISO 时间或 null，`last_inbound_at` 为 Unix 秒。游标按 `(device_code,session_key)` 隔离，仅接受更大的 `revision`；返回 `stale` 标识被拒绝的旧镜像。
- `phase` 只接受 `idle/running/awaiting/followup_due/followup_sent/replied/expired/held`。发件箱投递结果在客户端 SQLite 中记录，不用 `phase` 代替。服务端 `agent_flow_outbox` 是预留表，本轮没有投递明细上报接口。

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
  "trace_id": "agent-trace-…",
  "evidence": {
    "engine": "agent",
    "flow": { "status": "enabled", "version": 3, "stage": "等待客户端上报实际节点" },
    "facts": { "wage_text": "22元/小时" },
    "fact_sources": { "wage_text": { "kind": "position", "label": "岗位资料" } }
  },
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
| GET | `/api/v1/agent/media/:name` | admin JWT、设备令牌或服务令牌 | 默认返回原文件与校验和。仅管理员可传 `?preview=compatible` 生成 H.264/AAC MP4，或传 `?preview=thumbnail` 生成视频 JPEG 封面。可用 `version` 指定预期的原文件 SHA-256，不匹配时返回 404。封面生成繁忙时返回 503 与 `Retry-After`。 |

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

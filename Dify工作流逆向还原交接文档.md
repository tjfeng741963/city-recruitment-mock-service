# Dify 工作流逆向还原交接文档

更新时间：2026-10-26。写给下一位接手"把 Dify 工作流本身还原出来"的 Agent。

## 0. 先说清楚一件事：我们从未抓到过 Dify 工作流本体

这份文档的题目容易让人误解成"这里记录了目标站 Dify 工
...[61 chars omitted]...
标站 Dify 应用的调用方式、本地系统对接 Dify 的方式、以及现有代码里和"工作流行为"相关但尚未接上的配置项**。工作流内部的节点、Pr
...[155 chars omitted]">
更新（2026-10-26 补测）：下面第 1a 节是用一组真实的 url/key 实测得到的，是迄今唯一一次对目标 Dify 应用的真实外部探测。

## 1. 目标站真实证据：dify_url / dify_key 字段

来源：`过程文件/remaining-response-shapes.json`（对标探针实测响应，非猜测），`/api/v1/agent/devices` 列表项字段：

```
id, device_code, name, dify_url, dify_key, recruiter_id, status, online,
mode, config, last_online, created_at, last_offline, queue_depth, queue_stale
```

**结论：每个"设备"（一个微信/企业微信账号）绑定一个独立的 Dify 应用**，通过 `dify_url` + `dify_key`
...[70 chars omitted]...
e. 不同招聘员的号可以指向不同的 Dify 应用，人设、话术库完全独立。

`recruiter_id` 决定设备归属哪个招聘员账号；`mode` 取值 `followup`（跟进版）/`invite`（邀约版），这个字段本身不影响调用 Dify 的方式，只影响本地状态机的后续动作（见第4节）。

## 1a. 2026-10-26 实测记录：用真实 url/key 探测到的东西

**这是本文档唯一一次对目标 Dify 应用的真实外部探测**，不是看浏览器/看代码，是直接拿用户提供的 `
...[155 chars omitted]...
再查一次 `message-automation.ts` 有没有新加 split 逻辑，不要直接信这份文档的结论——结论只对截至 2026-10-26 的代码成立。

## 2. `/workflow` 端点——容易踩的坑：这不是 Dify 工作流 DSL

来源：`过程文件/api-contracts.json` 第65-67、185-187、585-587 行；`src/modules/agent/agent.routes.ts:180-191`；目标站前端 `AgentDeviceView` 编译产物。

目标站真实存在三个方法：

```
GET    /api/v1/agent/device/:id/workflow
PUT    /api/v1/agent/device/:id/workflow
DELETE /api/v1/agent/device/:id/workflow
```

**第一次看到这几个端点很容易误判成"这里能拿到 Dify 工作流 DSL"，实际不是。** 目标站前端源码（`AgentDeviceView` 组件）明确写着这是一个**设备级 YML 文件上传功能**，用途是"上传 Dify 导出的 YML 工作流文件，用于 AI 对话质量分析"——文件和评测报告关联，不是系统运行时真正调用的工作流配置。真正驱动对话的是 `dify_url`/`dify_key` 指向的、部署在 Dify 平台上的应用，这个应用本身的节点、Prompt、知识库配置，**目标站的 Web 管理后台不会把它们原样吐给前端**，上传的 YML 只是人工留档用的参考文件，GET 端点返回的也只是一个状态信封：

```
GET  → { ok: boolean, message: string }   // 是否已上传，不是工作流内容
```

本地复刻版本（`agent.routes.ts:180-191`）如实复刻了这个"状态信封 + blob 存在性"语义：`workflow_file`/`workflow` 字段存在与否决定 `ok`，PUT/DELETE 只是把整段 JSON 合并或清空，没有也不需要解析 YML 内容。

**这件事的实际含义：目标站管理后台本身不是获取 Dify 工作流细节的入口。** 如果后续要还原工作流本体，这条路走不通，需要看第5节的替代路径。

## 3. 本地系统对接 Dify 的真实实现（已验证可跑通的部分）

来源：`src/modules/dify/dify-provider.ts`（全文 113 行，已读完）。

### 3.1 调用协议

`HttpDifyProvider.sendMessage()` 调用的是 Dify **标准 Chat App API**，不是 Dify 内部私有接口：

```
POST {baseUrl}/chat-messages
Headers: Authorization: Bearer {apiKey}
         Content-Type: application/json
Body:    { inputs: {}, query, response_mode: "blocking", user,
           conversation_id?  // 仅在已有会话时携带
         }
```

响应解析只取三个字段：`answer`（回复文本）、`message_id`、`conversation_id`。超时 10 秒（可配置），`AbortController` 控制，超时/网络错误统一归一化为 `safeError()`，错误信息截断到 300 字符，不回传完整 stack。

`healthCheck()` 调用 `GET {baseUrl}/parameters`，同样带 Bearer token，只用于判断 Dify 应用是否可达，不解析具体参数内容。

这两个端点（`/chat-messages`、`/parameters`）都是 **Dify 官方公开文档里的标准 API 路径**，headless 的接口形态，和"工作流画布编辑"没有关系——调用方完全不需要知道工作流内部怎么画，只需要 `baseUrl` + `apiKey`。这也印证了第2节的结论：目标站后台本身只是这类标准 API 的调用方，不持有工作流编排细节。

### 3.2 密钥解析顺序

`deviceDifyConfig()`（`dify-provider.ts:29-35`）：

```
baseUrl = data.dify_url || process.env.REA_DIFY_BASE_URL || "mock://local"
apiKey  = process.env[data.dify_key_env || "REA_DIFY_API_KEY"] || data.dify_key
```

注意优先级：**环境变量优先于设备记录里存的明文 key**。这是本地复刻版本的安全设计，不是目标站已验证的行为（目标站把 `dify_key` 直接存数据库明文返回给前端，见第1节字段列表，本地版本因此也按原样兼容了这个明文字段用于 parity，但新增了 env 覆盖作为更安全的可选路径）。

### 3.3 两套 Provider

- `MockDifyProvider`：测试/本地默认，返回固定格式 mock 回复，不发网络请求。
- `HttpDifyProvider`：真实调用，上面两条已覆盖。

业务层（见第4节）只依赖 `DifyProvider` 接口，不关心具体是哪一个实现，替换/切换成本为零。

## 4. 完整调用链（谁在什么时候真正调 Dify）

来源：`src/modules/activation/activation.jobs.ts`（全文 129 行，已读完）。

```
activation.scan（定时扫描，见 Phase 3/4 文档）
  → 对每个 customer 按策略评估 activation.rules.ts
  → 命中且 eligible → 写 activation_records（status=pending_review 或 pending_send）
  → 若策略配置 auto_review=true → enqueueMessageSend() 直接排队发送

message.send（队列任务，ActivationJobService.sendRecord）
  1. 取 activation_records 行，状态必须是 pending_send/pending_review
  2. 取话术文本（record.script，为空则取第一条启用的 activation_scripts）
  3. MessageEventService.recordEvent()  — 先落事件，幂等 key = activation-send:{id}:{tier+1}
  4. MessageEventService.createDelivery() — 建 delivery 记录
  5. 若 delivery 已 succeeded（幂等重放）→ 跳过重新调用 Dify，直接复用 generated_content
  6. 否则：markDeliverySending() → 调用 DifyProvider.sendMessage({ baseUrl, apiKey, user: customer_id, query: 话术 })
  7. Dify 失败 → markDeliveryFailed() → 抛错 → 交给 scheduler 的退避/重试（Phase 4）
  8. Dify 成功 → 取 providerResult.message 作为 outgoing 文本
  9. MessageChannelProvider.sendMessage() 把 outgoing 真正发到微信侧（当前默认 MockMessageChannelProvider，见第5.3节）
  10. 发送成功 → 写 agent_messages（outbound）→ markDeliverySucceeded() → activation_records.status='sent', tier+1
```

**关键点：Dify 在这条链路里只负责"生成一句回复文本"**，输入是运营配置的话术模板（不是客户原话），输出的 `answer` 字段直接当成要发给客户的文本。这跟"客户发消息 → Dify 回复" 这种直觉理解不同——`sendRecord()` 这条链路是**系统主动触达**（到期提醒、流失唤回等策略命中后的推送），不是被动应答客户消息。

### 4.1 另一条链路：客户消息进来后的被动应答

上面这条是"系统主动触达"。**被动应答（客户发消息 → Dify 生成回复 → 发回去）确实也存在**，实现在 `src/modules/messaging/message-automation.ts`（`MessageAutomationService.handleInbound()`，全文 152 行，已读完），别和上面那条搞混：

```
handleInbound(eventId, deviceCode, customerId, content)
  1. INSERT OR IGNORE agent_messages(direction='inbound') — 幂等去重
  2. 更新 agent_conversations（last_msg/unread+1）
  3. 若该会话 takeover=1（人工已接管）→ 直接返回 reply_status: human_takeover，不调 Dify
  4. 取 agent_devices 配置（必须 status='enabled'）
  5. recordEvent('message.reply.generated') + createDelivery() — 同样先落事件再调用，带幂等/去重
  6. 若 delivery 已有现成 content（重放）→ 跳过重新调用
  7. 否则 DifyProvider.sendMessage({ baseUrl, apiKey, user: customerId, query: content,
       conversationId: 已有的 external_conversation_id,  // 延续 Dify 会话上下文
       inputs: { device_code, customer_id } })
  8. Dify 回复为空或失败 → markDeliveryFailed，reply_status: failed
  9. 发送前再查一次 takeover——防止"生成回复期间人工介入"的竞态，命中则放弃发送
  10. MessageChannelProvider.sendMessage() 真正发出 → 写 agent_messages(outbound) → markDeliverySucceeded
  11. 若 Dify 返回了 conversation_id → 写回 agent_conversations.external_conversation_id，下次复用，维持多轮对话上下文
```

**三处触发入口**（均已验证，`automation.handleInbound(...)` 调用点）：

- `activation.routes.ts:99` — `POST /api/v1/webhooks/dify` 的 `message.received`/`message.inbound`/`message.created` 事件类型分支（见第5.1节的签名校验之后）。
- `device-bridge.routes.ts:52` — 独立微信设备桥接上报的 inbound 事件（见第5.2节）。
- `wecom.routes.ts:145` — 企业微信客服消息队列 `wecom_inbox` 轮询消费时（见第5.3节）。

三个入口殊途同归，都是"收到一条客户消息"这件事的不同来源，最终都走 `handleInbound()`，调用同一个 `DifyProvider`，且都带上下文 `conversation_id` 延续，不是无状态单轮问答。

## 5. 三个触发入口的细节

### 5.1 `POST /api/v1/webhooks/dify`

来源：`activation.routes.ts:85-100`，`message-events.ts:59-74`。

```
签名头：x-dify-signature
校验：HMAC-SHA256(rawBody, webhookSecret) 与头部值 timingSafeEqual 比较，防时序攻击
secret 来源：process.env.REA_WEBHOOK_SECRET（默认 "local-webhook-secret"，仅本地兜底，不是目标站真实密钥）
```

签名不过 → 401，并把 `rejected` 状态和 payload 摘要（不是原文）写入 `webhook_logs`。签名通过后，无论事件类型是什么都先 `recordEvent()` 落一条 `message_events`（幂等 key 用 payload 里的 `id`，没有就用 `webhook:{payloadHash}`）；只有当 `event` 字段是 `message.created`/`message.received`/`message.inbound` 三者之一，才会继续解析 `data.device_code`/`data.customer_id`/`data.content` 并调用 `handleInbound()`。其余事件类型（例如 Dify 侧的任务状态回调）只落事件，不触发应答。

**这一条路径的名字叫"Dify webhook"，但要注意它接的是谁回调谁：是 Dify 平台把客户在微信侧发来的消息，通过某个中间层转发到这个 webhook，还是 Dify 自己的任务/节点状态回调——payload 的 `data.device_code`/`data.customer_id`/`data.content` 字段命名明显是"转发客户消息"场景，但目标站上这个 webhook 真实由谁调用、调用时机，没有抓到实测证据，只有本地复刻实现，标记为推测。**

### 5.2 设备桥接（`device-bridge.routes.ts`）

本项目自建的微信网页版桥接方案（见仓库根目录《微信设备桥接使用说明.md》），不是目标站原有功能的逆向，是本地为了跑通全链路而搭的替代通道：微信网页版客户端收到消息 → 本地 bridge 进程上报 `event_id`/`contact_id`/`content` → `device-bridge.routes.ts:47-52` 校验设备在线状态 → `recordEvent()` → `handleInbound()`。

### 5.3 企业微信客服（`wecom.routes.ts`）

企业微信客服消息走官方 API 落 `wecom_inbox` 表排队，`wecom.routes.ts:135-145` 轮询消费：按 `status='queued'` 原子 claim（`UPDATE ... WHERE status='queued'`防止并发重复消费），事件 id 用 `sha256(corpId+openKfId+msgid)` 派生，保证同一条企业微信消息不会重复触发 Dify 调用。

### 5.4 `MessageChannelProvider` ——发送出口同样是接口化的

无论上面哪条链路生成了回复文本，最终发送都走 `MessageChannelProvider.sendMessage()` 接口。当前默认实现是 `MockMessageChannelProvider`（`activation.jobs.ts:33` 构造函数默认值），真实发送通道（微信/企业微信）需要显式注入 `wecom-channel.ts` 里的实现或设备桥接的 channel 实现——**如果跑本地验证发现"Dify 回复生成了但客户收不到"，先检查这里注入的是不是 Mock，而不是怀疑 Dify 调用链路本身出了问题**。

## 6. 已知缺口清单（下一位 Agent 接着查/接着补的地方）

这些是读代码时发现的"配置存在但没有被消费"或"证据缺失"的点，不是臆测，但目前确实没有实现或没有证据，不要默认它们已经工作：

1. **工作流本体从未抓到。** 第0节已说明。如果用户的目标是"复刻 Dify 应用内部的节点/Prompt/知识库"，现有材料完全不够，需要新的信息来源（例如：目标站是否有可访问的 Dify 实例本身、是否能拿到真实 `dify_url`/`dify_key` 去调 `/parameters` 或 Dify 控制台 API 枚举应用结构）。这件事要先跟用户确认是否有权限/渠道接触到真实 Dify 实例，不能靠逆向网页端做到。

2. **`event_rules` 关键词检测完全没有执行代码。** `AgentDeviceView` 前端配置了"不符合/邀约成功/签到成功/待邀约"四组关键词，`response-serializers.ts:159-160` 和 `DEFAULT_EVENT_RULES` 只是把默认值序列化给前端展示，**没有任何地方在 Dify 返回 `answer` 之后拿这些关键词去匹配，也没有 `mark_disqualified`/`mark_invited`/`mark_checked_in`/`mark_pending_invite` 的执行逻辑**（已用 grep 核实全仓库找不到这几个 action 字符串的消费点）。也就是说目标站原本"根据 AI 回复内容自动判断客户状态"这个行为，本地复刻版本目前只搭了配置界面，没有接上状态机。

3. **`merge_delay_seconds` / `merge_requery` 没有被消费。** `AgentDeviceView` 表单里有"消息合并等待秒数"和"合并重问（多条消息用 ### 拼接重新问一次 Dify，只允许一次防循环）"这两个配置项，但 `message-automation.ts` 的 `handleInbound()` 是逐条立即处理，**没有合并等待窗口、没有 `###` 拼接重问的实现**。如果目标站真实行为是"短时间内多条消息合并成一次 Dify 调用"，这是现有代码和真实行为的一个已知差距。

4. **`/api/v1/webhooks/dify` 的真实调用方未经验证。** 第5.1节已标注：这个端点收谁的回调、`x-dify-signature` 的真实密钥怎么来，都没有目标站侧的实测证据，现在的实现是"看起来应该是这样"的合理推测，不是已验证事实。

5. **追问（timeout）、静默时段（quiet_hours）、面试提醒（reminder）三组配置的执行代码没有在这次排查范围内确认。** 这些同样是 `AgentDeviceView` 表单项，本次只排查了 Dify 调用链路本身，没有逐一追踪这三组配置是否被 `activation.jobs.ts`/`message-automation.ts` 之外的某个调度任务消费。下一位 Agent 如果要接这部分，先 `grep -rn "timeout_enabled\|quiet_hours\|reminder_rules" src --include="*.ts"` 确认有没有漏看的执行点，别直接假设"配置存在=功能已实现"或"配置存在=功能未实现"，两种都要用代码证据说话。

## 7. 查证方法论（给下一位 Agent 的提醒）

本文档每一条结论都标了来源文件+行号/证据文件。继续排查时：

- 看到前端表单里有一个字段，先去对应的后端 route/service 搜这个字段名的字符串，确认有没有消费点，再下"已实现"或"未实现"的结论——本次排查过程中就发生过一次错误（最初漏看了 `message-automation.ts`，差点把"被动应答链路不存在"写成结论），靠的是重新 grep 调用点才纠正。
- `过程文件/api-contracts.json` 和 `过程文件/remaining-response-shapes.json` 是目标站的实测证据（探针跑出来的），优先级高于对代码注释或命名的猜测。
- 本仓库是多窗口共享工作区（另见 memory 条目"c:\CODE 是多会话共享工作区"），排查时如果看到 `src/modules/wecom/` 下有未提交的改动，那是另一个会话在做企业微信客服接入，不要当成这次排查的证据基线去动它。

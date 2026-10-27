# 招聘邀约 Dify Chatflow 还原

从目标站 Dify 应用**实测抓包**还原出来的完整四流程工作流，不是猜的。

| 文件 | 内容 |
|---|---|
| `recruit-chatflow.dsl.yml` | 可导入 Dify 的 DSL（15 节点 / 18 边，零悬空引用） |
| `catalog.json` | 从抓包解析出的 12 个厂区结构化目录（含薪资/面试通知/报名表单/面试指引原文） |
| `prompt/system-flow1.txt` | 流程一完整 prompt（37,658 字符） |
| `prompt/system-flow2.txt` | 流程二完整 prompt |
| `prompt/system-flow3.txt` | 流程三完整 prompt |
| `prompt/system-flow4.txt` | 流程四完整 prompt |

本地可运行的等价实现：`src/modules/dify/chatflow-engine.ts`（流程一）+ `chatflow-flows.ts`（流程二/三/四），
测试见 `tests/dify-chatflow-{engine,flows,loop}.test.ts`。

---

## 一、怎么还原出来的

Dify 的 App API Key 拿不到工作流节点图，但**流式接口会泄漏内部状态**。
用 `response_mode: "streaming"` 调 `/chat-messages`，SSE 里：

- `node_started` / `node_finished` 带 `node_id`、`node_type`、`title`、`index` → **节点拓扑**
- `node_finished` 的 `process_data.prompts` → **LLM 节点的完整 system prompt**
- `node_finished` 的 `outputs`（code 节点）→ **中间变量的真实形态**

再配合多轮对话把 `flow_step` 从 1 推到 4，就能拿到**每一节流程各自的 prompt 正文**。
抓包脚本：`过程文件/dify-reverse/probe-flows{,2,3}.mjs`。

## 二、工作流是什么

`advanced-chat` 模式。四个流程共用一张图，靠会话变量里的 `flow_step` 选不同 LLM 节点：

```
start(开始)
 → code(代码执行)          话术常量 + 当前时间/星期
 → code(代码执行 3)        拼装 city_data_prompt（城市/区县/岗位全量数据）+ 回写状态
 → assigner(变量赋值)      hualin_state → conversation 变量
 → if-else(条件分支 2)     flow_step=1→llm / =2→llm2 / =3→llm3 / ≥4→llm4
 → llm(流程1..4)           37K–42K 字符 system prompt + 对话历史
 → code(选择LLM回复)       从 llm_reply_1..4 挑非空 → final_content / need_fix
 → code(看流程是否推进)    剥离 ##CITY:## 等标记 → 写回 hualin_state → 累积 history
 → if-else(条件分支 2)     need_fix 为真则回炉重问
 → code(代码执行 2) → assigner(存储上次对话内容) → answer(直接回复)
```

### 隐藏标记协议

模型在回复末尾输出标记，由 code 节点剥离并写回状态——**客户永远看不到这些标记**：

| 标记 | 写入状态 |
|---|---|
| `##CITY:东莞##` `##DISTRICT:清溪##` | `current_city` / `current_district` |
| `##AGE:25##` `##GENDER:男##` | `seeker_age` / `seeker_gender` |
| `##MATCHED:新造物东莞玩具厂##` | `matched_factory` |
| `##FLOW_DONE##` | **唯一推进 `flow_step` 的信号** |
| `##TYPE_2##` | 求职者不在招聘城市内 |

`###` 是**气泡分隔符**，客户端据此把一条回复拆成多条消息发出。

### 状态机

会话变量 `hualin_state`（JSON 字符串）：

```json
{"flow_step":2,"switched_factories":[],"current_city":"东莞","current_district":"清溪",
 "matched_factory":"新造物东莞玩具厂","seeker_gender":"男"}
```

`history` 按 `应聘者：X\n回复：Y\n\n` 累积，开头注入
`[已知求职者档案（系统已锁定，直接使用，禁止重新询问）]` 防止模型重复追问。

### 四个流程

| 流程 | 触发 | 做什么 | 推进条件 |
|---|---|---|---|
| 一 | 开场 | 收集城市/区县/年龄/性别 → 匹配厂区 → 发薪资详情 | 发完薪资 `##FLOW_DONE##` |
| 二 | `flow_step=2` | 薪资答疑（前 2 轮禁提纹身）→ 第 3 轮问纹身案底 → 邀约面试 | 确认面试后发报名表单 |
| 三 | `flow_step=3` | 收报名表单（姓名+电话必填）→ 发面试通知+地址 | 表单完整 `##FLOW_DONE##` |
| 四 | `flow_step=4` | 面试跟进 → 时间校验 → 到达后发面试指引 | 通过校验 `##FLOW_DONE##` |

流程二、四的**防跳步铁律**都已实现：流程二信息未齐禁发薪资；流程四未确认到达且未过时间校验禁发面试指引。

## 三、抓到了什么，没抓到什么

**抓到了（有实测证据）**

- 全部 15 个节点的类型、标题、执行顺序、输入输出键名
- **四个流程各自的完整 system prompt**（37,658 / 40,921 / 40,076 / 40,829 字符）
- 模型信息：`langgenius/openai_api_compatible/openai_api_compatible` / `ds-宜宏-10月23日`
- 12 个厂区的完整数据：薪资详情、面试通知模板、报名表单、面试指引、地址经纬度
- `hualin_state` 逐轮演化、标记协议、`flow_step` 推进时机
- token 用量：system prompt 约 22,600–23,500 tokens，无检索资源（`retriever_resources` 为空）

**没抓到 / 已知偏差**

1. **节点内 Python 源码**：code 节点的 `process_data` 为空，只泄漏输入输出值。
   DSL 与本地引擎里的代码是**按输入输出行为重写的等价实现**。
   → 已用差分回放量化等价程度，见下节。
2. **`新造物东莞玩具厂` 缺 `[面试指引]`**：抓包里该厂数据块确实没有这个字段（其余 11 家都有），
   不是解析失败。本地引擎对该厂回落到「到了直接联系我就行」。
3. **「★主推★」优先级**：prompt 里提到，但抓到的目录中没有主推标记，未实现。
4. **数据是实时的**：2026-10-25 抓到 6 城 12 厂，2026-10-27 已变 5 城 12 厂（中山下架、新增 3 厂）。
   `catalog.json` 是 10-27 快照，会随目标站数据变动而过期。

### 差分回放：等价程度是可量化的

code 节点的源码拿不到，但它的**输出**能对比。用抓到的 43 轮真实对话重放给本地引擎，
逐轮比较状态机：

```
决策字段（flow_step / matched_factory / user_type）：43/43 = 100%
状态全等（含档案字段 current_city/seeker_age 等）：11/43 = 25.6%
```

**为什么只看决策字段**：`flow_step` 决定系统下一步做什么，`matched_factory` 决定发给客户哪家厂，
`user_type` 决定走本地还是异地分支——这三个错了就是行为错了。

档案字段差异不是错误，是**实现方式不同**：真实实现把城市/年龄放在**对话历史**里让 LLM 自己读，
状态变量 `hualin_state` 里只有部分字段。本实现是确定性引擎，必须自己持有这些字段。
强行对齐反而会让流程一出错（删掉 `current_city` 后引擎会每轮重复问"你在哪个区"）。

跑法：

```bash
npx tsx 过程文件/dify-reverse/run-replay.mjs
```

### 回放揪出的三个真实缺陷

这是回放最有价值的地方——它抓出了光看 prompt 看不出来的行为：

1. **换厂不改 `switched_factories`**：真实实现只改 `matched_factory` 重发薪资，
   那个数组始终是空的。我原先假设它会记录换厂历史，错了。
2. **`##TYPE_2##` 不留在回复里**：被 code 节点消费成状态字段 `"user_type": "2"`。
   我原先以为它会作为文本标记存在。
3. **流程二是两步不是一步**：纹身问清后只发"可以过来面试吗"（`flow_step` 仍为 2），
   等求职者确认后才发报名表单并推进到 3。我原先合成了一步，导致推进过早。

还有一条**否证**：初期假设"连问 3 轮纹身没回答就放弃"并在第 22 轮推进流程，回放显示
真实系统第 22 轮**只发邀约问句、不推进**，一致度反而从 93% 掉到 69.8%。已改成两步。

## 四、怎么用

### 方式一：导入到自己的 Dify

把 `recruit-chatflow.dsl.yml` 在 Dify 里「导入 DSL」。

**结构校验已做，真实导入未做**。用 `node 过程文件/dify-reverse/validate-dsl.mjs` 对照
Dify 开源仓库的实际代码校验，12/12 通过：

- 已核实（来自 `api/services/app_dsl_service.py`、`api/services/dsl_version.py`）：
  `version` 必须是字符串、`app` 段必需、`kind` 应为 `app`、
  版本低于当前会被判 `COMPLETED_WITH_WARNINGS`（**DSL 版本已对齐官方 `0.7.0`**）
- 结构推断：边不悬空、变量引用可解析、会话变量已声明、if-else 分支都有出边、含 start/answer 节点

导入后仍需：

- 配置一个可用的 `openai_api_compatible` 模型供应方，把四个 LLM 节点改成你自己的模型
- code 节点只用标准库 `json` / `re` / `datetime`

**没做的**：没有在真实 Dify 实例上点过导入按钮。上面的校验能排除结构性问题，
但不能保证导入后能正常跑——那需要实例。

### 方式二：跑本地引擎（已验证）

```bash
REA_DIFY_PROVIDER=chatflow npm run dev
```

`createDifyProvider()` 自动装配 `ChatflowDifyProvider`，实现同一个 `DifyProvider` 接口，
直接接入 `MessageAutomationService` → `MessageChannelProvider`，零外部依赖。

验证：

```bash
npx vitest run tests/dify-chatflow-engine.test.ts \
               tests/dify-chatflow-flows.test.ts \
               tests/dify-chatflow-loop.test.ts
```

`dify-chatflow-loop.test.ts` 是端到端闭环：客户消息进 → 引擎回复 → 通道发出 → 落库，
覆盖人工接管跳过与重复事件幂等。

## 五、重新生成

```bash
node 过程文件/dify-reverse/parse-catalog.mjs   # 抓包文本 → catalog.json
node 过程文件/dify-reverse/gen-dsl.mjs         # catalog.json + 4 份 prompt → dsl.yml
```

`src/modules/dify/chatflow-catalog.ts` 由 `catalog.json` 生成，请勿手改。

## 六、想继续补的话

- **二类求职者分支**：用一个「人在外地」的合成话术开场，把会话推到 `##TYPE_2##`
- **换厂逻辑**：已匹配后指定另一家厂，观察 `switched_factories` 的变化
- **节假日安排**：抓包里 `[节假日安排]` 字段一直为空，需要节假日期间的样本

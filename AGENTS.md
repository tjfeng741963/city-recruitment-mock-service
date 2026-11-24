# 城市招聘配置还原 · 协作与发布规则

本文件写给参与本仓库的人和 AI Agent。改代码、推代码前先读完。

## 产品功能与入口规则（用户确认，2026-11-21）

- 新增面向用户的功能，必须先提出用户场景、所属现有页面、具体放置位置及简图、入口名称、与旧功能的关系，和用户讨论确认后再实现。
- 新增/移动/隐藏/合并/重命名侧栏菜单或主要按钮，同样先确认；不得因实现方便随意新增独立页面、侧栏项或主题脚本按钮。
- 优先复用已有页面与组件。一项能力维护一个主要操作位置、一份配置；其他页面可提供携带岗位/账号上下文的快捷链接，不能各做一套。
- 不得以精简为由隐藏有用功能。问答知识库、图片与视频保留独立菜单；Agent/Dify 的测试统一到画布工作台，配置来源与执行能力仍如实区分。
- 前端默认省去标题下的概述、重复说明和面向开发的技术文字。实现细节留在源码注释或维护文档。用户需要的填写约束、操作后果、异常和真实状态，用短句放在相关控件或触发时显示。移除文案后同步检查留白、对齐和窄屏布局。
- 保存、配置读取、生成回复、客户端执行、发送及对方收到必须按真实证据分别展示。未进入招聘链路的设置不得承诺生效。
- 已确认的入口方案不重复申请批准；原位置 bug 修复、测试及内部重构在已有授权内继续。若需改变已确认入口，先提出具体差异讨论。
- 详细规范见 [产品功能与入口规范](docs/产品功能与入口规范.md)。入口相关 PR 必须说明位置、旧入口去向及完整点击路径的验证结果。

## 项目是什么

城市招聘配置系统的 1:1 还原服务：Fastify + TypeScript 后端（`src/`），SQLite 存储，托管 Vue 前端（`public/`，含换皮主题 `public/theme/`）。前端**只用 `public/` 的 Vue 版本**（曾经的 React 管理台 `frontend/` 已删除）。生产环境跑在腾讯云 `119.91.113.100`，Docker Compose 部署，端口 `4222`。

## 发布方式：推到 main 即自动上线

流水线定义在 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)：

| 触发 | 做什么 |
|------|--------|
| 向 `main` 开 PR / 更新 PR | 只跑检查，不部署 |
| push 到 `main`（含 PR 合并） | 检查通过后自动部署到生产 |
| Actions 页面手动 Run workflow（选 main） | 重新检查并部署 main 最新提交 |

检查项（任一失败就不会部署）：

1. `npm ci`
2. `node scripts/check-migrations.mjs` 迁移编号检查（重号/非法文件名会让迁移器静默跳过，必须挡在部署前）
3. `npx tsc --noEmit` 后端类型检查
4. `npx vitest run --testTimeout=20000` 全部测试

部署步骤（在服务器上以 `deploy` 用户执行）：拉取并 checkout 该提交 → 备份 `.env.production` 和 SQLite 数据库（带提交号和时间戳）→ `docker compose build` + `up -d` → 60 秒内轮询 `http://127.0.0.1:4222/login`，失败则打印容器日志并让流水线标红。

同一时间只会有一个生产部署，后来的排队等待，不会互相打断。

## 推代码前必须做

本地先跑一遍和流水线相同的检查，全部通过再推：

```bash
npm ci
node scripts/check-migrations.mjs
node scripts/check-api-doc.mjs
npx tsc --noEmit
npx vitest run --testTimeout=20000
```

## 推代码规则

- **只提交自己改的文件**，用 `git add <具体路径>`，禁止 `git add .` / `git add -A`。工作区里常有别人或别的会话的未提交改动。
- 提交信息用 Conventional Commits：`feat: …` / `fix: …` / `refactor: …` / `test: …` / `docs: …` / `chore: …`，描述可以用中文。
- 改动较大或不确定时，推到新分支开 PR，等 PR 检查变绿再合并；小改动可以直接推 `main`，但推了就会上线。
- 禁止 force push `main`，禁止改写已推送的历史。
- 新功能、bug 修复要带测试，测试放 `tests/`。
- **改接口必须同步 `docs/API-接口清单.md`。** 人设 / 开场 / Agent 会话这三组接口有脚本守着：`npm run check:api` 会把文档标记区块里的接口和真实注册的路由做双向比对，代码加了接口没写文档、或文档写了代码里没有，都会让 CI 红。接口调试台（侧栏「接口调试」）的列表是自动从 `GET /api/v1/debug/routes` 读的，不用手动维护。
- 推完去 GitHub Actions 看 `test-and-deploy` 是否全绿；红了要立刻修或回滚，不要放着。

## 绝对不能提交的东西

- `.env*`、任何密钥、token、密码、SSH 私钥（`.gitignore` 已忽略 `.env*`，但不要绕过）
- `data/*.sqlite` 数据库文件
- `过程文件/` 下的调试产物、截图、bundle、日志（不要新增到 Git）
- `node_modules/`、`dist/`

生产配置 `.env.production` 只存在服务器上，流水线不会改它。

## 回滚

线上出问题时，用 revert 回滚，让流水线重新部署旧代码：

```bash
git revert <出问题的提交>
git push origin main
```

数据库被新代码写坏时，服务器 `/srv/apps/city-recruitment-mock-service/source/data/` 下有每次部署前的备份 `app.sqlite.pre-<提交号>-<时间>.bak`。恢复数据库需要停服务，先找仓库管理员，不要自己动。

## 权限与凭据（管理员维护）

- 推代码需要 GitHub 仓库 `tjfeng741963/city-recruitment-mock-service` 的写权限，找仓库管理员加协作者。
- 流水线用到的 GitHub Secrets：`DEPLOY_SSH_PRIVATE_KEY`、`DEPLOY_SSH_HOST`、`DEPLOY_SSH_USER`。协作者不需要也不应该拿到这些值。
- 服务器公钥登记在 `/home/deploy/.ssh/authorized_keys`，注释为 `github-actions-deploy-city-recruitment`。服务器重装后需更新 workflow 里固定的 host key。
- 首次部署、环境变量说明见 [docs/deployment.md](docs/deployment.md)。

---

# 附：企微 agent 链路（`agent/`）—— 额外铁律

> 这一节只针对 `agent/` 目录。**违反会导致企业微信账号被风控处置**（实测：要求扫码、进程强退、退回登录页）。

## 1. 零改动：`agent/wecom_io_core/`

四个文件 **一个字节都不许改**：

| 文件 | 作用 |
|---|---|
| `win.py` | 窗口定位、抢前台、键盘注入、剪贴板 |
| `send.py` | **发送动作序列**（`Ctrl+F` → `Enter` → `Ctrl+A/Delete` → `Ctrl+V` → 哨兵回读 → `Enter`） |
| `store.py` | 解密本地库、读会话与消息 |
| `crypto.py` | wxSQLite3 解密与密钥提取 |

每一步都对应一个踩过的坑，**不要"优化"、不要觉得多余、不要用更简洁的写法重写**：

- `Ctrl+A` 必须在 `Ctrl+V` 之前 —— 否则搜索框会拼接上次的关键词
- `Delete` 必须在粘贴正文之前 —— 清掉残留草稿
- 哨兵法 `Ctrl+A`+`Ctrl+C` 回读 —— 确认文字真进了输入框才回车，绝不盲发
- `_esc_cleanup` + `release_modifiers` —— 异常中断后释放卡住的修饰键
- 每步前 `_wait_visible` —— 企微检测到自动化会隐藏窗口约 9 秒

## 2. 禁止添加的动作

原包里没有的，加了就出事：

| 禁止 | 原因 |
|---|---|
| **鼠标点击输入框** | 上游 2026-10-31 记录「删除自加的 Tab 与坐标点击」，坐标点击是最容易被判定为自动化的特征 |
| **Alt 键 / 点标题栏抢前台** | 会激活菜单栏，把后续按键焦点带偏；上游只用 `ShowWindow` + `AttachThreadInput` |
| **Tab 键** | 同上，已被上游删除 |
| **换 `SendInput` 替代 `keybd_event`** | 上游用 `keybd_event`，实测可用；换 API 只增加行为差异 |
| **调整步骤间 sleep** | FAST_MODE 的时序是按 5 秒整条标定的 |

要加任何动作，必须先证明「不加失败、加了成功」，并排除是其他改动造成的。**不要叠补丁**——之前就是先加抢前台补丁、又加点击补丁，最后无法归因。

## 3. 允许的补丁（仅限非动作层）

判定标准：**这个补丁会不会产生额外的键盘/鼠标事件？** 会就不许加。

| 补丁 | 做什么 | 为什么 |
|---|---|---|
| `compat.apply()` → `set_clipboard` | 显式 `GlobalAlloc + SetClipboardData` | 本机向日葵长期独占剪贴板，`win32clipboard` 走不通 |
| `compat.apply_pb_text()` → `_pb_text` | decode 用 `errors="ignore"` | 消息 >127 字节时长度前缀是两字节 varint，原实现解码失败整段丢弃，长消息读成空 |

## 4. 改动流程

```
发现问题 → 先诊断（日志/库/窗口状态）定根因
        → 写说明：改什么、为什么、影响哪些动作、怎么验证、怎么回滚
        → 用户确认
        → 才动代码
```

禁止：不诊断就加补丁、加完不记录、一次改多处、改完不跑测试。

## 5. 只能改这三处

| 位置 | 允许改什么 |
|---|---|
| `agent/autopilot.py` | 何时发、发给谁、回复内容从哪来（**不改发送动作**） |
| `agent/reply_store.py` | 回复历史的记录方式 |
| `agent/brain.py` | 回复内容来源（知识库 / LLM） |

`agent/compat.py` 只能**减少**补丁，不能增加动作层补丁。

## 6. 风控事故记录

| 时间 | 当时做了什么 | 处置 |
|---|---|---|
| 11-04 10:52 | 原包 + 点击补丁，发 2 条（间隔 11 秒） | 退回登录页 |
| 11-02 15:16 | 点击补丁 + 失败后整段重试 | 进程被强制退出 |
| 11-02 上午 | `SendInput`（结构体错误）+ 坐标点击 | 隐藏窗口 + 要求扫码 |

**降低频率只能延后发现，不能避免。**

## 7. 历史误判（不要再犯）

1. **"键盘注入被过滤"是误判**。真因是 `SendInput` 结构体少了 `MOUSEINPUT`，`sizeof` 是 32 不是 40，一直返回 `ERROR_INVALID_PARAMETER(87)`，一个键都没注入。原包的 `keybd_event` 一直有效。
2. **"Ctrl+F 无效"同一原因**。
3. **"必须点坐标才有焦点"没验证过**，可能是自己加的 Alt 补丁导致焦点丢失，叠补丁掩盖问题，无法归因。

**任何"XX 无效"的结论，先确认自己的调用有没有返回错误。**

---

# 附：LLM 调用规则 —— 不开思考模式

**硬规则：只用非思考模型，永远不要开 thinking / reasoning。**

| 项 | 值 |
|---|---|
| 模型 | `deepseek-chat`（非思考，服务端解析为 `deepseek-flash`） |
| 禁止 | `deepseek-reasoner`（思考模型） |
| 禁止参数 | `reasoning_effort`、`thinking`、`enable_thinking` 等任何推理开关 |
| 配置位置 | `backend/.env` 的 `APP_LLM_MODEL` |

## 为什么

1. **延迟**：客户在企微里等回复，思考模型的思维链动辄十几秒，键鼠发送还要串行排队，累积起来一条回复要半分钟以上
2. **成本**：thinking token 按输出计费，客服场景的高频短问会被放大数倍
3. **不需要**：回复的事实全部来自知识库（`kb_answer` 已经做了数字校验，防编造工价），模型只负责把结构化事实改写成自然话术，这个任务不需要推理链
4. **稳定**：思考模型会把 `reasoning_content` 混在响应里，当前 `llm_provider.py` 只取 `choices[0].message.content`，换模型等于要动代码

## 落地位置

- `backend/app/services/llm_provider.py::LLMProvider.complete()` 的 payload 只有 `model` + `messages`，**不传任何 kwargs**
- `kb_answer.py` 调用时不传额外参数，所以没有任何路径能打开思考模式

## 如需改动

改模型名属于**配置变更**，不是代码变更。只改 `.env` 的 `APP_LLM_MODEL`，不要动 `llm_provider.py`。改完重启后端即可。

若要换成其他厂商的模型，必须确认它是**非思考**版本（如 `qwen-plus` 而非 `qwq`、`glm-4-flash` 而非 `glm-z1`）。

## 实测记录（2026-11-04）

`APP_LLM_MODEL=deepseek-chat` 直连 `api.deepseek.com/v1`：

```
HTTP 200
返回 model: deepseek-flash          ← deepseek-chat 是非思考别名，路由到 flash
message 字段: ['role', 'content']   ← 无 reasoning_content
finish_reason: stop
usage: 9 tokens（无 reasoning token）
```

判定标准：**响应 message 里出现 `reasoning_content`，或 usage 里有 reasoning token，就是开了思考模式，必须立刻改回。**

## 云 Windows 运维与结论边界（2026-11-20 事故教训）

- 本项目云 Windows 是 `134.175.40.31`，客户端目录 `C:\agent`；Linux 业务服务器是 `119.91.113.100`。当前开发电脑不是云 Windows。本机不存在 `C:\agent` 不能推断远程未安装。
- 操作前恢复本会话的既有部署记录与连接方式，核对远程主机名、版本、桌面 SessionId、进程与任务。SSH 应校验已有 host key。不得在文档里保存密码、令牌或私钥。
- 分开核验并报告：main 已合并、流水线已成功、Release 已发布、远程已安装、客户端业务就绪。任一层成功都不代表后一层成功。
- 自动回复 PID 存在只代表进程暂时存在，不代表初始化完成、企微已登录、二维码已上传或消息已回复。启动后应检查后续退出/异常和业务心跳；人工截图可能是旧状态。
- 更新网络检查与本地 PowerShell 状态检查是两条链路。`powershell.exe -EncodedCommand ... timed out after 25 seconds` 是本机状态查询超时，不能直接归因为 GitHub 网络失败；友好提示也不能代替异常根因。
- 不用恢复高频、阻塞按钮的完整状态轮询来掩盖陈旧状态；区分轻量存活检测、业务就绪与手动更新检查。
- 保留原始日志于被忽略的 `过程文件/`，诊断记录只摘录必要且脱敏的证据；不得把日志、配置或数据库提交到 Git。Windows PowerShell 文本需取纯字符串，避免 ConvertTo-Json 展开 PSPath/PSDrive 元数据。
- 本次故障链与待修范围见 `docs/诊断-云Win启动与二维码-20261120.md`。诊断不授权启动发送或修改冻结核心。

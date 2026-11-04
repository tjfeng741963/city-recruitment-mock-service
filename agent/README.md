# agent · 企业微信本地自动回复端

> ⚠️ **本项目禁止商业使用。使用前必读 [DISCLAIMER.md](DISCLAIMER.md)。**
>
> 模拟键鼠 + 读取加密库均违反企业微信服务协议，实测会导致扫码验证、进程强退。后果自负。

在**运行企业微信 PC 客户端的这台 Windows** 上跑。

做法不是调企微 API，而是**读本地加密库 + 模拟键鼠**：

```
解密本地库（只读，零输入事件）
        ↓ 发现对方发来的新消息
登记到 reply_log（pending）
        ↓
core/send.py 执行动作序列：Ctrl+F → Enter → 点输入框 → Ctrl+A/Delete → Ctrl+V → 哨兵回读 → Enter
        ↓
落库 sent / failed，失败的下次自动补发
```

消息收发**不经过任何服务器**，不需要公网、不需要企业可信 IP、不需要回调地址。

---

## 快速开始

```sh
# 1. 依赖（自带 pywin32 + pycryptodomex + httpx）
uv sync

# 2. 配置：只需指向解密工具
cp config.example.json config.json   # 然后填 tool_path

# 3. 首次初始化（把历史消息标记为已跳过，避免补发几百条）
uv run python autopilot.py --reset

# 4. 常驻
uv run python autopilot.py --watch
```

常用命令：

| 命令 | 作用 |
|---|---|
| `--watch` | 常驻监听全部会话 |
| `--once` | 扫一轮就退出 |
| `--once --dry` | 只登记不发送，用来看会回谁 |
| `--list` | 打印回复历史 + 统计 |
| `--reset` | 把待发/失败的条目全部作废 |
| `--target 青冥` | 只监听某个会话 |
| `--reply-first / --reply-next` | 改首次/后续回复内容 |

---

## 回复策略

按场景分，判据是「**我方在这个会话回过几次**」，不是「对方发了几条」——对方连发三条属于同一次接触，只该回一次：

| 场景 | 回复 | 默认值 |
|---|---|---|
| 该会话我方还没回过 | `--reply-first` | `1` |
| 之后再来消息 | `--reply-next` | `233` |

同一会话有多条未回消息时**只回最新一条**，其余标 `skipped`（避免补发时刷屏）。

范围：全部会话，排除企微自带的应用/消息号（`Y:` `E:` `M:` `O:` `MAIL` 等前缀，以及「企业微信团队」「我的客服」这类官方号）。

---

## 回复历史

`reply_log.db`（SQLite），四态：

```
pending  已登记，待发
sent     发送成功
failed   发送失败（保留 error，下次启动自动补发）
skipped  不该发（系统会话 / 搜索不到会话名 / 同会话合并 / 手动 reset）
```

用 `--list` 查看。重启时会自动把 `pending` + `failed` 重新处理一遍——**这是补发的机制**，不是重试轰炸。

---

## 四个实测踩过的坑

### 1. 剪贴板被第三方程序独占

向日葵（`AweSun.exe` 的 `CClipboardViewer`）会长期持有剪贴板，导致 `OpenClipboard` 返回 `ERROR_ACCESS_DENIED(5)`，`Ctrl+V` 粘不进去。

- 处理：`compat.py` 里把剪贴板写入换成显式 `GlobalAlloc + SetClipboardData`，重试拉到约 12 秒
- 根治：关掉向日葵的「剪贴板同步」

### 2. 进会话后焦点会丢

从搜索结果回车进会话时，聊天区重新渲染，**焦点约 0.2 秒后丢失**，后面的 `Ctrl+A / Delete / Ctrl+V` 全落在别处，`verify_input_box` 一直读到哨兵。

- 处理：在 core 执行 `tap("delete")` 之前，按窗口比例点一下输入框（`0.45, 0.86`），把焦点拉回来
- 效果：之前 0/6 成功，改完 4/4 全部一次通过

### 3. 窗口在托盘时抢不到前台

隐藏的窗口不能成为前台窗口，`SetForegroundWindow` 必然失败。

- 处理：用 core 原版 `activate`（`ShowWindow` + `AttachThreadInput`），**不要自己加 Alt 键或点标题栏**——实测那样会把焦点带偏，反而必失败

### 4. `SendInput` 结构体不能省 `MOUSEINPUT`

64 位下 `sizeof(INPUT)` 必须是 **40 字节**（union 最大成员是 `MOUSEINPUT` 32 字节）。只声明 `KEYBDINPUT` 会算出 32 字节，`SendInput` 直接返回 0 + `ERROR_INVALID_PARAMETER(87)`，一个键都注入不进去。

> 这是早期版本踩的坑，曾经误判成「企微过滤了合成按键」。实际 `keybd_event` 一直有效。

---

## 风控记录（必须知道）

模拟键鼠属于企业微信服务协议禁止的外挂行为。本机实测（同一账号、同一天）：

| 时间 | 触发原因 | 处置 |
|---|---|---|
| 上午 | 密集手动测试 | 客户端隐藏窗口 + 要求**手机扫码安全验证** |
| 15:16 | 连续发送 + 失败后整段重试 | `WXWork.exe` **进程被强制退出**，退回登录页 |

规律：**处置强度随操作密度上升**。失败重试是主要放大器——一次失败会触发 2 轮完整动作序列。

降低触发概率的措施（已实现）：

- 单条冷却 8 秒
- 失败不立即重试（留到下一轮）
- `Ctrl+F` 后等 2 秒再回车，避免抢跑导致的无效重试

但按上游作者的原话：**降低频率只能延后发现，不能避免**。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 必须有交互式桌面 | 锁屏、RDP 断开、窗口最小化都会失败 |
| 依赖固定窗口布局 | 点击输入框用窗口比例（0.45, 0.86），客户端大改版需重新标定 |
| 同步有延迟 | 重新解密一次约 10 秒，加上 3 秒轮询，实际延迟 10~15 秒 |
| 一次只能处理一个会话 | 键鼠是串行的，队列逐条执行 |
| 企微版本绑定 | 数据库结构与内存特征随版本变化，升级后需重新验证 |

---

## 目录

| 文件 | 作用 |
|---|---|
| `autopilot.py` | 主程序：轮询 → 登记 → 队列 → 发送 |
| `reply_store.py` | 回复历史（SQLite 四态表）+ 补发查询 |
| `compat.py` | 对 core 的两处运行时补丁（剪贴板、点输入框） |
| `wecom_io_core/` | 上游原样代码：`win.py` 窗口/键鼠、`send.py` 动作序列、`store.py` 解密读库、`crypto.py` |
| `collector.py` / `client.py` / `main.py` | 早期「采集上报服务端」链路，独立于自动回复 |
| `sender.py` / `screenshot.py` | 早期自研键鼠实现与截图工具，**已被 `wecom_io_core` 取代**，仅作参考 |

---

## 代码来源与许可

`wecom_io_core/` 来自第三方项目 `wecom_io`（MIT，见 `LICENSES/` 与 `wecom_io_core_NOTE.md`），**原样复制，未做修改**。动作序列（`Ctrl+F → Enter → Ctrl+A/Delete → Ctrl+V → 哨兵回读 → Enter`）完全由它决定。

本目录只做两件事：在它前后补环境适配（`compat.py`），以及决定「什么时候、给谁、回什么」（`autopilot.py`）。

⚠️ 读取解密本地库属于绕过客户端技术保护措施，聊天内容含第三方个人信息。**不要外传 `_decrypted/` 或 `reply_log.db`**。

---

## 上报与心跳

`autopilot.py` 除了本地回复，还会**定时和服务器说话**。这两件事都是**纯 HTTP**，不产生任何键盘/鼠标事件，也不改发送动作序列。

### 心跳（每 30 秒）

`POST /api/v1/devices/{device_code}/heartbeat`，带 `X-Device-Token`，请求体遵循
[`docs/_contract/设备心跳与看板契约.md`](../docs/_contract/设备心跳与看板契约.md)：

```json
{"agent_version": "1.0.0", "capabilities": {}, "wecom_state": "online", "queue_size": 0, "last_error": ""}
```

服务端据此把设备置为 `status=online`、刷新 `last_heartbeat_at`，看板就能判断「采集机还在不在」。
超过 90 秒没心跳，服务端会自己标 `offline` 并发告警——所以心跳断了不用 agent 做任何补救。

`wecom_state` 由本地 `detect_wecom_state()` 只读探测得出（`EnumWindows` / `GetClassNameW` / `IsWindowVisible` 一类只读 API，
**不调用 `SetForegroundWindow` / `ShowWindow`**）：

| 探测结果 | 判定 |
|---|---|
| 进程里没有 `WXWork.exe` | `not_running` |
| 有窗口类名 `WeChatLogin` | `login_required` |
| 有可见的 `WeWorkWindow` | `online` |
| 只有不可见的 `WeWorkWindow` | `hidden` |
| 其它 / 探测异常 | `unknown` |

### 掉线就停手

主循环**每轮开头**先自检：

- `online` → 正常处理队列
- 其它任何状态（`login_required` / `not_running` / `hidden` / `unknown`）→ **跳过全部发送**，日志写原因，队列原样保留，心跳照发
- 状态恢复 `online` 后自动继续，不需要重启进程
- `--dry` 本来就不发送，不受这条限制（可以照常看到"会回什么"）

> 这是 11-02 被强制退出的直接原因：窗口隐藏了还在按 Ctrl+F。`drain()` 在函数第一行就 `return`，`core_send.send()` 一次都不会被调到。

### 增量上报（每 30 秒，和心跳同一批）

- 取本地解密库里**比游标新**的消息，一次最多 50 条，结构照 `main.py::collect_once`：
  `account_uid` + `conversations` + `messages`
- **群聊（`R:`）也上报**，`kind` 标成 `group`
- 上报成功后把游标写进 `agent/.report_state.json`（每会话一个最大 `message_id`）
- 首次运行没有游标时，只补最近 24 小时，避免把几天历史一次性灌进服务端
- 失败不重试、不推进游标、只记日志，下一轮自然补

心跳/上报跑在后台线程里，主线程照常发送；上一批没回来就跳过本轮，不会越堆越多。

### `device_code` 从哪来

心跳路径里的 `{device_code}` 不是从 token 反推的，必须本地配置。优先级：

1. 命令行 `--device-code pc-office-01`
2. 环境变量 `AGENT_DEVICE_CODE`
3. `agent/config.json` 里的 `"device_code": "pc-office-01"`
4. 上一次心跳成功后缓存在 `.report_state.json` 里的值

都没有时**只跳过心跳，上报照常**（上报只认 `X-Device-Token`），日志会提示怎么配。
`AgentClient.__init__` 只多了一个带默认值的 `device_code` 参数，`main.py` 的调用不受影响。

### 怎么排查

| 现象 | 看什么 |
|---|---|
| 看板显示采集机离线 | 日志里有没有 `[心跳] ... → ok=True`；没有就是进程没跑或 `device_code` 没配 |
| `[心跳] 失败（忽略，下轮自然补）` | `server` 地址、后端是否在跑、token 是否被服务端删了；注意**失败不会重试**，恢复后下一轮自动补 |
| `[自检] 企微状态 hidden` | 企微被最小化到托盘或已被风控隐藏；**不要手动多点窗口**，等它自己恢复成 `online` |
| `[自检] 企微状态 login_required` | 需要人工扫码登录，扫码后下一轮自动恢复发送 |
| 服务端会话时间不更新 | `[上报] 无新增消息` 说明游标已推进；对比 `.report_state.json` 的 `cursor` 与本地库最新 `message_id` |
| 想重新全量上报 | 停进程，删掉 `agent/.report_state.json`（会按最近 24 小时重新挑），再启动 |

手工确认（`TOK` 用 `POST /api/v1/auth/login` 换）：

```sh
curl -s --noproxy '*' http://127.0.0.1:8090/api/v1/devices -H "Authorization: Bearer $TOK"
curl -s --noproxy '*' "http://127.0.0.1:8090/api/v1/conversations?limit=3" -H "Authorization: Bearer $TOK"
```

**只在 dry 模式下验证**：`uv run python autopilot.py --once --dry`（只登记不发送，仍会心跳/上报）。


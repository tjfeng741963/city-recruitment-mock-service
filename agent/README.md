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

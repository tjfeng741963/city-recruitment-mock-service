# 城市招聘 · Windows 单机客户端

一台 Windows 电脑上跑两个进程：**后端 API（8090）**和**企业微信自动回复**。
本目录只放启动/运维脚本，不改动仓库代码。

```
deploy/client/
├── install.bat                 首次安装（检查环境 + uv sync + 生成本地配置）
├── start-all.bat               一键启动（两个窗口）
├── stop-all.bat                停止
├── status.bat                  端口 / 进程 / 健康 / 日志
├── register-autostart.bat      注册登录自启（管理员运行）
├── unregister-autostart.bat    取消自启
├── config/                     环境变量与 agent 配置模板
└── docs/部署说明.md            完整交付文档
```

## 三步走

**1. 安装（只做一次）**

双击 `install.bat`。它会检查 uv、Python ≥ 3.11、8090 端口，然后在 `backend/`、`agent/` 各跑一次 `uv sync`，并把 `config/backend.env.example` 复制成 `backend/.env`。

只看检查、不装依赖：`cmd /c install.bat --check-only`

**2. 配 agent（只做一次）**

`agent/config.json` **不会自动生成**（避免写入假 token）。

1. 先 `start-all.bat`（此时只会起后端）；
2. 按 `docs/部署说明.md` 第 3 节注册设备，拿到 `device_token`；
3. 复制 `agent/config.example.json` 为 `agent/config.json`，填 `device_token`、`brain.password`。

**3. 启动与验证**

双击 `start-all.bat`，会开两个窗口：`后端 :8090`、`自动回复`。
两个窗口内部调用仓库根已有的 `start-后端.bat` / `start-自动回复.bat`（未改动），日志因此仍写在 `logs\`。

浏览器打开 <http://127.0.0.1:8090/api/v1/leads/board>，用 `.env` 里的管理员账号登录。
**顶部红条消失 = 采集端在线**（红条出现说明超过 90 秒没收到心跳）。

## 客户端模式（推荐）

这台电脑只当客户端（跑企业微信 + 自动回复采集），后端和数据库在服务器
`http://119.91.113.100:8090`。本机不再跑后端、不占 8090。

**端口职责别混**（2026-11-15 排查 404 时踩过）：`8090` 是 Python 大脑（systemd
`recruit-backend`，只负责 flow/KB/档案）；`4222` 是 Node 主站与设备页，扫码登录
（`/api/v1/agent/devices/:code/login-qr`）只在 4222，8090 上查这条一定是 404。

```
deploy/client/
├── 客户端模式.bat              一键启动客户端（1 个窗口，只连服务器）
├── 注册开机自启-客户端.bat      注册登录自启（管理员运行，任务名：城市招聘-客户端）
├── 取消开机自启-客户端.bat      取消上面的自启
└── 客户端模式说明.md           完整说明（配置三步、验证、常见问题）
```

用法：

1. `agent\config.json` 里填好 `server` / `device_token` / `device_code`（本机已配好 `pc-office-01`）；
2. 登录企业微信 PC 版；
3. 双击 `客户端模式.bat`。只做检查不启动：`客户端模式.bat --check-only`。

验证连上了：打开看板 <http://119.91.113.100:8090/api/v1/leads/board>，
**顶部红条消失 = 设备在线**。细节与排查看 `客户端模式说明.md`。

`register-autostart.bat` 现在二选一：客户端模式（默认）或旧的
单机模式（`start-all.bat`）。两种自启任务**只注册一个**，别同时开。

## 排查

```bat
status.bat                          :: 端口、进程数、/healthz、最后 10 行日志
type logs\backend.log               :: 后端日志
type logs\agent.log                 :: 自动回复日志
```

| 现象 | 处理 |
|---|---|
| `uv` 找不到 | 装 uv（<https://docs.astral.sh/uv/>），重开命令行 |
| 8090 被占用 | `netstat -ano \| findstr :8090` → `taskkill /PID <PID> /F`，或先跑 `stop-all.bat` |
| 看板红条「采集端离线」 | 自动回复没跑 / `device_token` 失效 / `device_code` 不一致，见部署说明 |
| 企微要求扫码 | 手动扫码登录，别最小化或锁屏；恢复后自动继续 |

## 注意

- 开机自启用的是**计划任务（登录时触发）**，不是 Windows 服务——服务在 SYSTEM 会话，碰不到桌面键鼠。
- 升级只覆盖代码，**保留** `backend/data/`、`backend/.env`、`agent/config.json`、`agent/reply_log.db`。
- 备份就是复制 `backend/data/app.db` 和 `agent/reply_log.db`（先停进程）。
- 改脚本时注意：`.bat` 是 UTF-8 无 BOM，**以中文结尾的行，行尾那个空格不能删**，否则 cmd 解析时会吞掉下一行。

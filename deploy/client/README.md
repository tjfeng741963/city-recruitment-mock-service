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

### 流水线更新

Win 端不是 Git checkout。合并到 `main` 后，CI 通过测试与 Linux 部署才会发布同一提交 SHA 对应的不可变 Windows client Release。启用 `CloudPilot` 后，交互登录直接启动本机已安装的版本。需要升级时，在客户端管理器中手动检查并安装已发布的完整包。

一次性迁移任务定义需使用 `bootstrap-client-updater.ps1`。先在停止客户端时运行 `-DryRun`，确认 action 和交互登录触发；应用后保留原来的 Enabled 状态。当前事故处置中的 `CloudPilot` 为 Disabled，bootstrap 不会启用它；是否恢复任务需另行人工决定。更新失败时保留当前安装。运行前会独立检查本地启动文件、冻结核心、交互桌面和进程状态。

若管理器反复提示 `unsafe package path`，先比对正式包清单与本机更新器的 `CLIENT_PATHS`。2026-11-26 的正式包包含 `remark.py` 和 `favorite_sync.py`，旧更新器会拒绝安装，即使下载校验已经通过。已安装旧更新器的机器需由运维先备份并更新经过发布校验的本机更新器，关闭并重新打开管理器，再通过正常入口更新。正式包仍须通过版本、校验和、逐文件哈希及冻结核心核验。

若手动导入早于本修复的官方包以回滚业务版本，该包可能同时装回旧更新器。再次升级前，须重新执行上述一次性更新器迁移。

更新过程日志写在 `C:\agent\logs\update.log`，只记录提交 SHA、变更文件数和阶段结果，不写配置或客户聊天内容。

`sync_from_github.py` 保留只读预览，手动 `--apply` 已禁用，避免绕过流水线提交 SHA、核心校验和备份流程。

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

## 云上 Agent 待分配机器

部署人员批量预装 Win 客户端、Python 依赖与企微。在尚无企微登录数据和回复账本的新机上启用待分配模式。在交互桌面打开企微，确认登录窗口可见并保持打开。现有接待中的机器应继续用各自的账号运行。

1. 确认云电脑能用系统证书访问招聘站的 HTTPS 地址。配置生产服务端的 `REA_CLOUD_AGENT_POOL`，填需要加入空闲池的机器标识，多个用英文逗号分隔。
2. 为每台实验或生产云电脑创建独立的桥接机器身份和令牌，将机器标识和令牌写入其 `C:\agent\config.json` 的 `device_code` 和 `bridge_token`。机器在预装阶段只运行待分配程序，普通接待客户端首次启动会使该机器退出空闲条件。
3. 从新版客户端对应的 Git 提交取出 `deploy/client/`，用其中的 `bootstrap-client-updater.ps1` 初始化更新器及管理器。旧更新器会拒绝含 `location_card.py` 的新版 ZIP，先用新版 bootstrap 完成本地初始化，再使用客户端更新。在同一安装目录添加 `cloud-agent-pool.json`，内容为 `{"machine_code":"pool-win-03","origin":"https://recruitment.example"}`。将整个 `C:\agent` 及子目录的继承权限限制在实际运行客户端的交互账号、Administrators 与 SYSTEM，以保护配置、临时文件和凭据备份。
4. 在该机器的交互桌面运行 `client_updater.py --cloud-agent`，或由现有 `CloudPilot` 交互登录任务启动 `client-startup.cmd`。从网页管理员选机列表核对这台机器出现。机器失去交互桌面时会从空闲列表消失，恢复后继续等待。

日常运维在「微信账号」的客户原行点「分配云电脑」并确认。Win 留存 `config.before-cloud-assignment.json`，以试运行启动目标账号。页面收到有效运行心跳后，由客户在同一行扫码。若二维码过期，可在云电脑的企微登录窗口刷新。试运行期间暂停自动发送。分配超时会保留预留，部署人员可查同机 `logs/update.log` 并恢复交互桌面。任何有客户数据的云电脑重新入池前都需要履行设备退役与清理流程。

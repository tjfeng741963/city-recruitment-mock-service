# 城市招聘 · 企业微信自动接待与线索管理

最新开发交接（2026-11-07）：[可靠性修复、实机验收与下一步](docs/开发交接-可靠性修复与实机验收-20261107.md)。本轮代码在 `fix/handoff-reliability`、[草稿 PR #5](https://github.com/tjfeng741963/city-recruitment-mock-service/pull/5)，未合并/部署 main；接手前先读交接中的测试目录和发送边界。

用本地企业微信 PC 客户端收消息 → 知识库问答（大模型改写）→ 键鼠回复 → 自动记录谈单进展。
**同一套代码支持两种交付形态**：装在客户电脑上的「客户端」，和装在自己服务器上的「服务端」。

> ⚠️ 本项目禁止商业使用，使用前必读 [`agent/DISCLAIMER.md`](agent/DISCLAIMER.md)。
> 模拟键鼠 + 读取本地加密库违反企业微信服务协议，**实测会导致扫码验证、进程强退、退回登录页**。

## 两种形态

| | 客户端（Windows 单机） | 服务端（中心部署） |
|---|---|---|
| 装在哪 | 客户的 Windows 电脑 | 自己的 Linux 服务器（Docker） |
| 数据在 | 本机 SQLite，不出门 | 服务器 PostgreSQL |
| 谁用 | 1 个顾问 | 多个顾问 / 多台机器 |
| 企微收发 | 本机键鼠 + 本地库解密 | 仍由各客户端完成，服务端只管理 |
| 看板 | `http://127.0.0.1:8090/api/v1/leads/board` | `http://<服务器IP>/api/v1/leads/board` |
| 安装 | 双击 `deploy/client/install.bat` | `bash deploy/server/install.sh` |
| 详细说明 | [`deploy/client/docs/部署说明.md`](deploy/client/docs/部署说明.md) | [`deploy/server/docs/部署说明.md`](deploy/server/docs/部署说明.md) |

两种形态是**同一份后端**，差别只在 `APP_DATABASE_URL`（SQLite / PostgreSQL）和由谁访问。
客户端可以单独用；需要多端共享时，把客户端 `agent/config.json` 的 `server` 指向服务端即可。

## 目录

```
backend/     FastAPI：认证、设备、会话、消息、知识库、线索、看板
agent/       本地采集与发送（解密企微本地库 + 键鼠），核心动作序列来自 wecom_io_core（未改动）
deploy/      两种形态的安装包
docs/        设计与实施文档
src/ public/    原有 Node 业务系统 + Vue 前端（与本后端并行，不是一套）
```

## 能力

- **自动接待**：知识库检索 → 大模型改写 → 键鼠发送，五步动作带哨兵校验
- **谈单状态**：`new → asking → intent → booked → interviewed → hired`，分支 `no_show / gave_up / unsuitable / dormant`
- **约面记录**：时间、地点、岗位；点「到了 / 没来 / 改期」即落库，流水可追溯
- **掉线可见**：客户端每 30 秒心跳，服务端 90 秒无心跳判离线，看板顶部红条提示
- **增量上报**：客户端把新消息同步给服务端，服务端能看到实时会话
- **急停开关**：`bash backend/scripts/lead_switch.sh off` 一条命令停掉线索判定，不影响自动回复
- **日报巡检**：`python -m scripts.daily_report` / `inspect`

## 系统要求

| 形态 | 要求 |
|---|---|
| 客户端 | Windows 10/11、[uv](https://docs.astral.sh/uv/)、企业微信 PC 已登录 |
| 服务端 | Linux、Docker 20+、2 核 2G 起（建议 4G） |

## 快速开始（客户端）

```bat
deploy\client\install.bat        :: 检查环境、装依赖、生成配置
deploy\client\start-all.bat      :: 起后端 + 自动回复
deploy\client\status.bat         :: 看端口、进程、健康检查
```

打开 `http://127.0.0.1:8090/api/v1/leads/board`，用 `backend\.env` 里的管理员账号登录。

## 快速开始（服务端）

```bash
cp deploy/server/.env.example deploy/server/.env   # 或直接跑 install.sh，它会生成密钥
bash deploy/server/install.sh
bash deploy/server/healthcheck.sh
```

## 测试

```bash
cd backend
APP_DATABASE_URL="sqlite+aiosqlite:///./data/test_all.db" uv run pytest tests -q
```

截至实现提交 `ee6c017`，Python **598 passed**（130 条既有警告），Node **269 passed**（43 文件），隔离 HTTP 八场景通过；PR/push 的 Ubuntu/Windows CI 全通过。详细验证范围及真实企微验收边界见最新开发交接。

## 文档索引

| 主题 | 文档 |
|---|---|
| 最新开发交接（2026-11-07） | [可靠性修复与实机验收](docs/开发交接-可靠性修复与实机验收-20261107.md) |
| 客户端部署 | `deploy/client/docs/部署说明.md` |
| 服务端部署 | `deploy/server/docs/部署说明.md` |
| 谈单状态机 | `docs/谈单状态机与面试记录设计.md` |
| 线索闭环（裁决与实施） | `docs/实施计划-线索闭环.md` |
| 掉线与上报分析 | `docs/分析-掉线与上报与面试登记.md` |
| 企微链路铁律 | `AGENTS.md` |
| 日报与巡检 | `docs/日报与巡检.md` |
| 风险与免责 | `agent/DISCLAIMER.md` |

# backend · 企业微信单通道后端

FastAPI + SQLAlchemy 2.0（async）+ SQLite/PostgreSQL。**P0~P2 已完成并验收**：认证、设备、通道、会话、消息、发件箱、企微回调与拉取、WebSocket 推送全部可跑。

设计依据：`docs/后端架构设计-企业微信单通道与多端客户端.md`
验收报告：`docs/验收报告-企微后端P0P2.md`

## 跑起来

```bash
cd backend
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8090 --reload
```

- Swagger：http://127.0.0.1:8090/docs
- 健康检查：http://127.0.0.1:8090/healthz
- WebSocket：`ws://127.0.0.1:8090/ws?token=<JWT>`

首次启动自动建表并创建管理员（用户表为空时）：

```
local-admin / local-demo-only
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/auth/login` | 登录换 JWT |
| GET | `/api/v1/auth/me` | 当前用户 |
| GET/POST | `/api/v1/devices` | 设备列表 / 注册（返回 `device_token`） |
| POST | `/api/v1/devices/{code}/heartbeat` | 设备心跳（`X-Device-Token`） |
| GET/POST | `/api/v1/channels` | 通道列表 / 新建企微客服账号 |
| GET | `/api/v1/channels/{id}/status` | 通道就绪状态 |
| GET | `/api/v1/conversations` | 会话列表（含按用户算的未读） |
| GET | `/api/v1/conversations/{id}/messages` | 消息（`after_id` 增量） |
| POST | `/api/v1/conversations/{id}/messages` | 人工发消息（只入队，202） |
| POST | `/api/v1/conversations/{id}/takeover` | 接管 / 取消 |
| POST | `/api/v1/conversations/{id}/read` | 上报已读位置 |
| GET | `/api/v1/customers/{id}` | 客户资料 |
| GET/POST | `/webhooks/wecom` | 企微回调（公开，验签解密） |
| — | `/ws` | WebSocket 订阅推送 |

## 环境变量

基础（`APP_` 前缀）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_ENV` | `dev` | |
| `APP_PORT` | `8090` | |
| `APP_DATABASE_URL` | `sqlite+aiosqlite:///./data/app.db` | 生产改 `postgresql+asyncpg://...` |
| `APP_JWT_SECRET` | `dev-only-secret-change-in-production` | **生产必须换** |
| `APP_SEED_ADMIN_USERNAME/PASSWORD` | `local-admin` / `local-demo-only` | 首次建号 |
| `APP_OUTBOX_WORKER` | `false` | 生产建议 `true`，自动消费发件箱 |
| `APP_OUTBOX_INTERVAL` | `5.0` | worker 间隔秒 |

企微（`APP_WECOM_` 前缀）：

| 变量 | 说明 |
|---|---|
| `APP_WECOM_ENABLED` | `true` 才启用 |
| `APP_WECOM_CORP_ID` | 企业 ID（ww 开头） |
| `APP_WECOM_APP_SECRET` | **自建应用**的 Secret（2023-12 起系统应用已不可用） |
| `APP_WECOM_CALLBACK_TOKEN` | 回调 Token |
| `APP_WECOM_ENCODING_AES_KEY` | 43 位 EncodingAESKey |
| `APP_WECOM_OPEN_KFID` | 客服账号（wk 开头） |
| `APP_WECOM_DEVICE_CODE` | 绑定的设备编码 |

## 架构要点

```
客户端（Web/桌面/移动）
   │ REST + WS（同一 JWT）
服务端 FastAPI
   ├── api_v1.py                认证 / 设备 / 通道
   ├── api_v1_conversations.py  会话 / 消息 / 客户
   ├── api_webhook.py           企微回调（验签→去重→异步同步）
   ├── channels/wecom_kf/       crypto / client / sync / sender
   ├── services/                会话聚合 / 发件箱状态机
   ├── workers/outbox.py        发件箱消费
   └── ws/hub.py                WebSocket 推送中心
```

三条硬约束：

1. **回调只入队不干活**——5 秒内返回 `success`，正文靠 `kf/sync_msg` 拉
2. **写接口不发送**——`POST /messages` 只写 `deliveries(queued)`，worker 才发
3. **多端未读按用户算**——`read_cursors` 按 `(user, conversation)`，不用单计数器

## 目录

```
backend/
├── app/
│   ├── main.py              # 装配 + lifespan（建表/种子/可选 worker）
│   ├── settings.py          # pydantic-settings
│   ├── db.py                # async engine（SQLite 用 NullPool）
│   ├── models.py            # 9 张表
│   ├── schemas.py
│   ├── security.py          # scrypt（兼容旧 TS 库）+ JWT
│   ├── deps.py
│   ├── api_v1.py
│   ├── api_v1_conversations.py
│   ├── api_webhook.py
│   ├── channels/
│   │   ├── base.py          # ChannelAdapter 协议
│   │   └── wecom_kf/        # crypto / client / sync / sender / config / errors
│   ├── services/            # conversation_service / delivery_service
│   ├── workers/outbox.py
│   └── ws/hub.py
└── tests/                   # 157 个用例
```

## 测试

```bash
cd backend && uv run pytest tests -q
```

当前：**157 passed**。覆盖面见验收报告。

## 下一步（P3）

- 接 Dify：`ai_service.py`，AI 生成走 `deliveries(source=ai)`
- 客户昵称头像：`kf/customer/batchget` 回填
- Alembic 迁移（现在用 `create_all`）
- 多 worker 下的 Redis 锁（`sync_channel` 目前假设单实例）

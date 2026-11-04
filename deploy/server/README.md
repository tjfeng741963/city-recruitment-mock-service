# 服务端（中心部署版）

把 FastAPI 后端跑在 Linux 服务器上，多台 Windows 客户端统一接入，浏览器直接看线索看板。
三个容器：`postgres`（数据）、`backend`（Python 后端，8090 只绑本机）、`nginx`（对外 80）。

```
浏览器 / 客户端  ──►  nginx :80  ──►  backend :8090  ──►  postgres :5432
```

## 1. 装

要求：Linux x86_64、2 核 2G 起（建议 4G）、Docker 20+ 且带 `docker compose` v2。
端口 80 空闲。

```bash
cd deploy/server
chmod +x install.sh backup.sh healthcheck.sh
sudo ./install.sh
```

脚本会检查环境、生成 `.env`（JWT 密钥、管理员密码、PG 密码）、构建并启动容器，
最后打印访问地址和管理员密码（**只打印一次**，同时写在 `.env` 里，权限 600）。

## 2. 启 / 停

```bash
docker compose up -d          # 启动（镜像已构建时）
docker compose stop           # 停止，数据保留
docker compose down           # 删除容器，数据卷保留
docker compose logs -f backend
```

## 3. 验证

```bash
./healthcheck.sh              # 容器 / API / 数据库 / 设备 / 磁盘
curl http://127.0.0.1/healthz # {"ok":true,"env":"production",...}
```

浏览器打开 `http://<服务器IP>/api/v1/leads/board`，用管理员账号登录看板。

## 4. 升级

```bash
cd <仓库根>
git pull
cd deploy/server
docker compose up -d --build
```

数据在 `pgdata` / `appdata` 卷里，重建容器不丢。
后端启动时自动 `create_all` 建表并补列，**不需要单独跑迁移**。

回滚见 `docs/部署说明.md`（升级前给镜像打 tag）。

## 5. 备份

```bash
./backup.sh                   # backups/YYYYmmdd-HHMM.sql.gz，保留最近 7 份
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `Dockerfile` | Python 3.12 + uv 装依赖，非 root，内置 `/healthz` 探活 |
| `docker-compose.yml` | postgres + backend + nginx，含健康依赖与卷 |
| `nginx.conf` | 反代、WebSocket、看板入口，`server_name _` 不绑域名 |
| `.env.example` | 全部环境变量与生产建议值 |
| `install.sh` | 一键安装 |
| `healthcheck.sh` | 健康检查与关键指标 |
| `backup.sh` | PG + 应用数据备份 |
| `docs/部署说明.md` | 多客户端接入、升级回滚、排障 |

完整说明：`docs/部署说明.md`

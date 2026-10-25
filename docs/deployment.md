# 腾讯云部署

## 结构

- Docker Compose 运行 Node 22 应用，宿主机端口 `4222` 映射到容器 `4222`。
- SQLite 数据保存在部署目录的 `data/app.sqlite`，容器仅以只读根文件系统运行。
- `.env.production` 只保存在服务器，至少配置独立的 JWT 密钥、webhook 密钥和首次种子密码。
- 首次启动会创建 `local-admin`、`local-customer`、`local-recruiter` 种子账号。生产初始密码由 `REA_LOCAL_SEED_PASSWORD` 提供，部署后应立即登录并改掉管理员密码。

## 首次部署

在服务器新建项目目录并克隆代码：

```bash
sudo mkdir -p /srv/apps/city-recruitment
sudo chown "$USER":"$USER" /srv/apps/city-recruitment
cd /srv/apps/city-recruitment
git clone https://github.com/tjfeng741963/city-recruitment-mock-service.git source
cd source
```

创建仅服务器本地保存的环境文件。用密码管理器生成三个互不相同的随机值，不要把 `.env.production` 提交到 Git：

```dotenv
REA_LOCAL_JWT_SECRET=<独立的高熵随机密钥>
REA_WEBHOOK_SECRET=<独立的高熵随机密钥>
REA_LOCAL_SEED_PASSWORD=<首次管理员登录密码>
REA_DIFY_PROVIDER=mock
REA_MESSAGE_CHANNEL_PROVIDER=mock
```

`mock` 模式用于验收本地业务闭环：签名入站消息会写入会话，生成一条确定性的 Mock Dify 回复，并以 `simulated` 状态写入 outbound 和 delivery 记录。它不会把文字发送到真实微信。

### 独立设备网关

内置 `REA_MESSAGE_CHANNEL_PROVIDER=bridge` 模式：设备用专属 token 登录网关，上报微信账号和心跳，持续拉取持久发送命令，并携带消息 ID 上报回执。后台人工回复、AI 应答和复聊激活均通过这一通道；不依赖原对标网站。

独立设备程序位于 `bridge/worker.mjs`，真实微信适配器位于 `bridge/wechaty-driver.mjs`。默认使用个人微信 Web puppet，能否登录取决于账号和协议可用性；不是企业微信好友私聊的官方 REST 实现。账号扫码和双向私聊尚需实机验收。详细步骤与限制见项目根目录《微信设备桥接使用说明.md》。

服务器环境示例（仅服务器保存）：

```dotenv
REA_MESSAGE_CHANNEL_PROVIDER=bridge
REA_DIFY_PROVIDER=http
REA_DIFY_BASE_URL=https://<你的Dify域名>/v1
REA_DIFY_API_KEY=<真实应用API Key>
REA_SCHEDULER_ENABLED=true
```

设备记录中的 `dify_url` 优先于全局 URL。密钥可留在服务器 `REA_DIFY_API_KEY`；多设备不同密钥可配置设备的 `dify_key_env` 指向不同环境变量名，不必把实际 key 写入数据库。没有真实 Dify 时可保留 `REA_DIFY_PROVIDER=mock` 做通道试验，但生成的是测试文案。

在容器生成设备配置（文件仅服务器保存，不打印 token）：

```bash
docker exec city-recruitment-app node dist/src/tools/pair-device.js local-device-001 /data/local-device-001.env
```

将该文件安全复制到运行设备程序的机器作为 `bridge/.env`，`REA_GATEWAY_URL` 指向网关 HTTPS 地址。当前公网只有 HTTP 时，可建立 `ssh -N -L 4222:127.0.0.1:4222 <SSH用户>@119.91.113.100` 隧道，设备使用 `http://127.0.0.1:4222`。无需把设备密钥明文发到公网。配对会轮换 token，但不会把设备改绑到其他微信号；新账号请用新 device_code。

默认 `mock` 仍可用于 UI 演示，记录会标为 `simulated`。`bridge` 模式缺设备、离线或缺联系人映射时会明确失败；命令回执丢失会进入 `unknown`，不会自动再次实际发送。设备日志、API 返回和微信客户端实际收到消息共同构成真实闭环证据。

可选 `http` provider 仍支持对接自有现成网关：配置 `REA_MESSAGE_CHANNEL_SEND_URL` 与 `REA_MESSAGE_CHANNEL_TOKEN`，发送请求字段为 `device_code/customer_id/content`，网关需确认成功并返回 `message_id` 或 `id`。仅排队、失败响应不能标成 sent。此模式无需调用对标站。

入站回调使用 HMAC-SHA256 验签，不需要用户 JWT。请求格式为：

```json
{
  "id": "unique-event-id",
  "event": "message.created",
  "data": {
    "device_code": "local-device-001",
    "customer_id": 700001,
    "content": "候选人消息"
  }
}
```

签名放在 `X-Dify-Signature` 请求头，当前实现对解析后的 JSON 使用紧凑 `JSON.stringify` 重新序列化后计算 HMAC，密钥是 `REA_WEBHOOK_SECRET`；发送方需保持字段顺序一致。

```bash
chmod 600 .env.production
mkdir -p data
sudo chown -R 1000:1000 data
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
```

浏览器访问 `http://<服务器公网IP>:4222/login`，账号为 `local-admin`，密码为 `REA_LOCAL_SEED_PASSWORD`。云防火墙需放行 TCP 4222；如启用 UFW，也需在服务器本机防火墙放行。

## 更新

更新前先停止应用并备份 SQLite，然后拉取目标提交、重建镜像并启动：

```bash
cd /srv/apps/city-recruitment/source
docker compose -f docker-compose.production.yml stop app
cp data/app.sqlite "data/app.sqlite.$(date +%Y%m%d%H%M%S).bak"
git fetch origin
git checkout --detach <目标提交>
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
```

数据库迁移在应用启动时执行。保留更新前 SQLite 备份和 Docker 旧镜像，确认新版本健康后再清理。

## 运维

```bash
docker compose -f docker-compose.production.yml logs --tail=100 app
docker compose -f docker-compose.production.yml restart app
curl -I http://127.0.0.1:4222/login
```

当前直接通过公网 IP 的方案使用 HTTP，仅适合临时验收，不应承载真实密码、令牌或候选人数据。正式使用应配置域名和 HTTPS 反向代理，并把云防火墙改为仅开放 80/443；应用容器端口应限制在本机或内网访问。

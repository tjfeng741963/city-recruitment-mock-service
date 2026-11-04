#!/usr/bin/env bash
# 城市招聘后端 · 一键安装（服务端 / 中心部署版）
#
# 做的事：
#   1. 检查 docker / docker compose
#   2. 检查 80、8090 是否被占用
#   3. 没有 .env 就从 .env.example 复制，并生成 JWT 密钥 / 管理员密码 / PG 密码
#   4. docker compose up -d --build
#   5. 轮询 /healthz 最多 60 秒
#
# 重复执行是安全的：已有 .env 不会覆盖，密钥不会重新生成。

set -euo pipefail

cd "$(dirname "$0")"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; NC=$'\033[0m'
info() { printf '%s\n' "==> $*"; }
ok()   { printf '%s\n' "${GREEN}✓${NC} $*"; }
warn() { printf '%s\n' "${YELLOW}!${NC} $*"; }
die()  { printf '%s\n' "${RED}✗${NC} $*" >&2; exit 1; }

# ─────────────────────────── 1. 环境检查 ───────────────────────────
info "检查 Docker"
command -v docker >/dev/null 2>&1 || die "未安装 docker。请先安装 Docker Engine 20+（https://docs.docker.com/engine/install/）"
if ! docker compose version >/dev/null 2>&1; then
    die "未找到 docker compose 插件（v2）。请安装 docker-compose-plugin，而不是老的 docker-compose v1"
fi
docker info >/dev/null 2>&1 || die "当前用户无法连接 docker daemon。请用 root 执行，或把用户加入 docker 组后重新登录"
ok "docker $(docker version --format '{{.Server.Version}}') / $(docker compose version --short)"

# 端口占用检查（只检查宿主机；本项目的容器重复启动会被下面放行）
check_port() {
    local port="$1" label="$2" busy=""
    if command -v ss >/dev/null 2>&1; then
        busy=$(ss -lntH "( sport = :${port} )" 2>/dev/null || true)
    elif command -v netstat >/dev/null 2>&1; then
        busy=$(netstat -lnt 2>/dev/null | awk -v p=":${port}" '$4 ~ p"$" {print; exit}' || true)
    fi
    if [ -n "${busy}" ]; then
        # 已经在跑本项目就不拦（升级场景）
        if docker compose ps --format '{{.Service}}' 2>/dev/null | grep -q .; then
            warn "${label} 端口 ${port} 已被占用，但本项目的容器正在运行，按升级处理"
            return 0
        fi
        die "${label} 端口 ${port} 被占用：${busy}
    请先停掉占用进程（ss -lntp | grep :${port}），或在 .env 里改 HTTP_PORT"
    fi
}

info "检查端口"
HTTP_PORT_PRE="$(awk -F= '$1=="HTTP_PORT"{print $2; exit}' .env 2>/dev/null || true)"
HTTP_PORT_PRE="${HTTP_PORT_PRE:-80}"
check_port "${HTTP_PORT_PRE}" "HTTP"
check_port 8090 "后端"
ok "端口 ${HTTP_PORT_PRE} / 8090 可用"

# ─────────────────────────── 2. 生成 .env ───────────────────────────
rand_hex() {  # rand_hex <字节数>
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$1"
    else
        # 退路：没有 openssl 时读固定长度随机字节再转 hex
        # （不要用 tr </dev/urandom | head，head 提前关闭会让 tr 收到 SIGPIPE，
        #  配合 pipefail 会直接把脚本打死）
        head -c 256 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-"$(( $1 * 2 ))"
    fi
}

rand_pass() {  # 16 位字母数字
    head -c 512 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-16
}

ADMIN_USER="admin"
ADMIN_PASS=""
JWT_SECRET=""

if [ -f .env ]; then
    info ".env 已存在，保留原有配置（不覆盖密钥）"
    ADMIN_USER="$(awk -F= '$1=="APP_SEED_ADMIN_USERNAME"{print $2; exit}' .env || true)"
    ADMIN_USER="${ADMIN_USER:-admin}"
    ADMIN_PASS="$(awk -F= '$1=="APP_SEED_ADMIN_PASSWORD"{print $2; exit}' .env || true)"
    if [ -z "${ADMIN_PASS}" ] || [ "${ADMIN_PASS}" = "__CHANGE_ME__" ]; then
        warn ".env 里管理员密码为空或仍是占位符，请手工修改后重新执行"
    fi
    if grep -q '^POSTGRES_PASSWORD=__CHANGE_ME__' .env; then
        die ".env 里 POSTGRES_PASSWORD 仍是占位符，请改成随机密码（如 openssl rand -hex 16）后重试"
    fi
else
    info "生成 .env"
    [ -f .env.example ] || die "缺少 .env.example，请确认仓库完整"
    cp .env.example .env

    JWT_SECRET="$(rand_hex 32)"
    ADMIN_PASS="$(rand_pass)"
    PG_PASS="$(rand_hex 16)"

    # 用 sed 按行替换，避免密码里的特殊字符破坏替换
    sed -i "s|^APP_JWT_SECRET=.*|APP_JWT_SECRET=${JWT_SECRET}|" .env
    sed -i "s|^APP_SEED_ADMIN_PASSWORD=.*|APP_SEED_ADMIN_PASSWORD=${ADMIN_PASS}|" .env
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PG_PASS}|" .env

    if grep -qE '^[A-Z0-9_]+=__CHANGE_ME__$' .env; then
        warn "仍有占位符未替换（见 .env 里的 __CHANGE_ME__），不影响启动，可稍后补"
    fi
    ok ".env 已生成"
fi

chmod 600 .env
ok ".env 权限已设为 600"

# ─────────────────────────── 3. 启动 ───────────────────────────
info "构建并启动容器（首次构建需拉镜像，几分钟属正常）"
if ! docker compose up -d --build; then
    printf '%s\n' "${RED}✗ 构建或启动失败，下面是 backend 最后 30 行日志${NC}" >&2
    docker compose logs --tail=30 backend >&2 || true
    die "请检查上面的错误：构建源不可达 / 内存不足（构建建议 2G 以上）/ 镜像层损坏"
fi

# ─────────────────────────── 4. 健康检查 ───────────────────────────
HTTP_PORT="$(awk -F= '$1=="HTTP_PORT"{print $2; exit}' .env)"
HTTP_PORT="${HTTP_PORT:-80}"

probe() {
    # 优先在宿主机打 127.0.0.1，curl 没有就进容器里用 python 打
    if command -v curl >/dev/null 2>&1; then
        curl -fsS -m 3 "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null 2>&1
    else
        docker compose exec -T backend python -c \
            "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=3).read()" \
            >/dev/null 2>&1
    fi
}

info "等待后端就绪（最多 60 秒）"
READY=0
for i in $(seq 1 60); do
    if probe; then READY=1; break; fi
    sleep 1
done

if [ "${READY}" -ne 1 ]; then
    printf '%s\n' "${RED}✗ 60 秒内 /healthz 未通过，下面是 backend 最后 30 行日志${NC}" >&2
    docker compose logs --tail=30 backend >&2 || true
    die "启动失败。常见原因：数据库密码与卷里旧数据不一致、8090 被占用、构建源不可达"
fi
ok "后端健康检查通过"

# ─────────────────────────── 5. 汇总 ───────────────────────────
SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
SERVER_IP="${SERVER_IP:-<服务器IP>}"

printf '\n%s\n' "${BOLD}========== 部署完成 ==========${NC}"
printf '访问地址   http://%s%s\n' "${SERVER_IP}" "$([ "${HTTP_PORT}" = "80" ] && echo "" || echo ":${HTTP_PORT}")"
printf '线索看板   http://%s%s/api/v1/leads/board\n' "${SERVER_IP}" "$([ "${HTTP_PORT}" = "80" ] && echo "" || echo ":${HTTP_PORT}")"
printf '接口文档   http://%s%s/docs\n' "${SERVER_IP}" "$([ "${HTTP_PORT}" = "80" ] && echo "" || echo ":${HTTP_PORT}")"
printf '\n管理员账号 %s\n' "${ADMIN_USER}"
printf '管理员密码 %s\n' "${ADMIN_PASS:-<见 .env>}"
printf '%s\n' "${YELLOW}密码只打印这一次，已同时写入 deploy/server/.env（权限 600），请立刻保存到密码管理器。${NC}"
printf '\n下一步：\n'
printf '  1. 浏览器打开看板地址，用上面的账号登录\n'
printf '  2. 每台 Windows 客户端：先在服务端注册设备（见 docs/部署说明.md 第 5 节）拿 device_token，\n'
printf '     再把 deploy/client 的 agent/config.json 里 server 与 brain.base_url 改成 http://%s\n' "${SERVER_IP}"
printf '     （device_code 每台唯一，与注册时一致）\n'
printf '  3. 详见 docs/部署说明.md（多客户端接入 / 升级 / 回滚 / 排障）\n\n'

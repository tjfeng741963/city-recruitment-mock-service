#!/usr/bin/env bash
# 城市招聘后端 · 健康检查
#
# 一次输出：容器状态 / API 健康 / 数据库连通与数据量 / 设备在线情况 / 磁盘占用
# 退出码：0 全部正常；1 有异常（可直接接监控）

set -uo pipefail

cd "$(dirname "$0")"

FAIL=0
say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m  ✗\033[0m %s\n' "$*"; FAIL=1; }

[ -f .env ] || { echo "缺少 .env"; exit 1; }

env_get() { awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/, ""); print; exit}' .env; }

PG_USER="$(env_get POSTGRES_USER)"; PG_USER="${PG_USER:-recruit}"
PG_DB="$(env_get POSTGRES_DB)";     PG_DB="${PG_DB:-city_recruitment}"
HTTP_PORT="$(env_get HTTP_PORT)";   HTTP_PORT="${HTTP_PORT:-80}"

# psql 封装：-tA 只出值，-v ON_ERROR_STOP=1 让 SQL 出错返回非 0
psql_q() {
    docker compose exec -T postgres \
        psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -tA -c "$1" 2>/dev/null
}

# ── 1. 容器状态 ─────────────────────────────────────────────────
say "容器状态"
if docker compose ps >/dev/null 2>&1; then
    docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' || FAIL=1
    for svc in postgres backend nginx; do
        state="$(docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1==s {print $2}')"
        [ "${state}" = "running" ] || bad "${svc} 未运行（state=${state:-missing}）"
    done
else
    bad "docker compose 不可用"
fi

# ── 2. API 健康 ─────────────────────────────────────────────────
say "/healthz"
if command -v curl >/dev/null 2>&1; then
    if BODY="$(curl -fsS -m 5 "http://127.0.0.1:${HTTP_PORT}/healthz" 2>/dev/null)"; then
        ok "HTTP 200 ${BODY}"
    else
        bad "经 nginx(${HTTP_PORT}) 访问 /healthz 失败"
    fi
else
    if BODY="$(docker compose exec -T backend python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8090/healthz',timeout=5).read().decode())" 2>/dev/null)"; then
        ok "容器内 /healthz：${BODY}"
    else
        bad "容器内 /healthz 失败"
    fi
fi

# ── 3. 数据库连通与数据量 ───────────────────────────────────────
say "数据库连通"
if psql_q "select 1" >/dev/null; then
    ok "psql 连接正常（${PG_DB}）"
    printf '  %-16s %s\n' "表" "行数"
    for t in kb_entry conversations leads devices; do
        n="$(psql_q "select count(*) from ${t}")"
        if [ -n "${n}" ]; then
            printf '  %-16s %s\n' "${t}" "${n}"
        else
            bad "${t} 查询失败（表不存在？首次启动建表未完成）"
        fi
    done
else
    bad "无法连接数据库，检查 postgres 容器与 APP_DATABASE_URL"
fi

# ── 4. 设备在线情况 ─────────────────────────────────────────────
say "设备状态"
if ! psql_q "select count(*) from devices" >/dev/null; then
    bad "devices 表查询失败（首次启动建表可能还没完成）"
    DEV_OUT=""
else
    DEV_OUT="$(psql_q "select device_code,status,wecom_state,coalesce(to_char(last_heartbeat_at,'YYYY-MM-DD HH24:MI:SS'),'never') from devices order by id")"
    if [ -z "${DEV_OUT}" ]; then
        printf '  （尚未注册任何设备）\n'
    else
        printf '  %-18s %-10s %-12s %s\n' "device_code" "status" "wecom_state" "last_heartbeat_at"
        printf '%s\n' "${DEV_OUT}" | awk -F'|' '{printf "  %-18s %-10s %-12s %s\n", $1, $2, $3, $4}'
        ONLINE="$(printf '%s\n' "${DEV_OUT}" | awk -F'|' '$2=="online"' | wc -l | tr -d ' ')"
        TOTAL="$(printf '%s\n' "${DEV_OUT}" | wc -l | tr -d ' ')"
        ok "在线 ${ONLINE} / 共 ${TOTAL}"
    fi
fi

# ── 5. 磁盘与卷 ────────────────────────────────────────────────
say "磁盘占用"
df -h / | tail -n 1
echo
docker system df 2>/dev/null | sed -n '1,5p' || true
USED_PCT="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
if [ -n "${USED_PCT}" ] && [ "${USED_PCT}" -ge 85 ]; then
    bad "根分区已用 ${USED_PCT}%，请清理旧镜像（docker image prune）或扩盘"
else
    ok "磁盘水位 ${USED_PCT:-?}%"
fi

say "结论"
if [ "${FAIL}" -eq 0 ]; then
    ok "全部检查通过"
else
    bad "存在异常，见上方 ✗ 项"
fi
exit "${FAIL}"

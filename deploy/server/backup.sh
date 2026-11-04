#!/usr/bin/env bash
# 城市招聘后端 · 备份（Postgres + 应用数据目录）
#
# 产物：
#   ./backups/YYYYmmdd-HHMM.sql.gz    数据库全量
#   ./backups/YYYYmmdd-HHMM.data.tar.gz  容器内 /app/data（instance.json 等）
#
# 保留最近 7 份（按文件名时间倒序），更早的自动删除。
#
# 建议加到 crontab：
#   15 3 * * *  /opt/city-recruitment/deploy/server/backup.sh >> /var/log/city-recruit-backup.log 2>&1

set -euo pipefail

cd "$(dirname "$0")"

KEEP=7
STAMP="$(date +%Y%m%d-%H%M)"
BACKUP_DIR="./backups"

[ -f .env ] || { echo "缺少 .env，无法读取数据库账号" >&2; exit 1; }

env_get() { awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/, ""); print; exit}' .env; }

PG_USER="$(env_get POSTGRES_USER)"; PG_USER="${PG_USER:-recruit}"
PG_DB="$(env_get POSTGRES_DB)";     PG_DB="${PG_DB:-city_recruitment}"

mkdir -p "${BACKUP_DIR}"
SQL_FILE="${BACKUP_DIR}/${STAMP}.sql.gz"
DATA_FILE="${BACKUP_DIR}/${STAMP}.data.tar.gz"

echo "==> 备份数据库 ${PG_DB} -> ${SQL_FILE}"
# -T 关闭 TTY，否则管道里会混入伪终端字符导致 gzip 解压失败
docker compose exec -T postgres \
    pg_dump -U "${PG_USER}" -d "${PG_DB}" --no-owner --no-privileges \
    | gzip -9 > "${SQL_FILE}"

if [ ! -s "${SQL_FILE}" ]; then
    echo "数据库备份为空，删除产物并退出" >&2
    rm -f "${SQL_FILE}"
    exit 1
fi

echo "==> 备份应用数据 /app/data -> ${DATA_FILE}"
if docker compose exec -T backend tar -czf - -C /app data > "${DATA_FILE}" 2>/dev/null; then
    :
else
    echo "! 应用数据目录备份失败（data 目录可能为空），跳过" >&2
    rm -f "${DATA_FILE}"
fi

echo "==> 清理旧备份，保留最近 ${KEEP} 份"
# shellcheck disable=SC2012
{ ls -1t "${BACKUP_DIR}"/*.sql.gz 2>/dev/null || true; } | tail -n +$((KEEP + 1)) | xargs -r rm -f
# shellcheck disable=SC2012
{ ls -1t "${BACKUP_DIR}"/*.data.tar.gz 2>/dev/null || true; } | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "==> 完成"
ls -lh "${BACKUP_DIR}" | tail -n +2

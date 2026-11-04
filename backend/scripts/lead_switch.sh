#!/usr/bin/env bash
# 线索闭环急停开关：开关文件存在即关闭，改完立刻生效（无需重启后端）。
#
#   bash scripts/lead_switch.sh off            # 两个都关
#   bash scripts/lead_switch.sh off extract    # 只关抽取
#   bash scripts/lead_switch.sh off sweep      # 只关扫描
#   bash scripts/lead_switch.sh on             # 全部打开
#   bash scripts/lead_switch.sh status         # 打印状态
#
# 路径基于脚本自身位置推导，在任意 cwd 下都能用（Git Bash / Linux / macOS）。

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DATA_DIR="${LEAD_GUARD_DIR:-$SCRIPT_DIR/../data}"

EXTRACT_FILE="$DATA_DIR/LEAD_EXTRACT_OFF"
SWEEP_FILE="$DATA_DIR/LEAD_SWEEP_OFF"

usage() {
    cat <<'EOF'
用法：bash scripts/lead_switch.sh <命令> [目标]

命令：
  off              关闭全部（抽取 + 扫描）
  off extract      只关抽取（不影响自动回复）
  off sweep        只关扫描（待核实标记）
  on               全部打开
  on extract       只打开抽取
  on sweep         只打开扫描
  status           打印当前状态

说明：
  · 开关文件存在即关闭，删掉即恢复，下一次判定立刻生效，不用重启后端。
  · 关掉抽取后，自动回复完全不受影响。
  · 开关文件位于 backend/data/，该目录已在 .gitignore，不会被提交。
EOF
}

# 打印当前状态。第一行固定格式：抽取：开启 / 扫描：关闭
do_status() {
    local extract sweep
    if [ -f "$EXTRACT_FILE" ]; then extract="关闭"; else extract="开启"; fi
    if [ -f "$SWEEP_FILE" ]; then sweep="关闭"; else sweep="开启"; fi
    printf '抽取：%s / 扫描：%s\n' "$extract" "$sweep"
    printf '开关目录：%s\n' "$(cd "$DATA_DIR" 2>/dev/null && pwd || printf '%s' "$DATA_DIR")"
}

switch_off() {
    mkdir -p "$DATA_DIR" || {
        printf '无法创建开关目录：%s\n' "$DATA_DIR" >&2
        return 1
    }
    case "$1" in
        all)
            : >"$EXTRACT_FILE"
            : >"$SWEEP_FILE"
            ;;
        extract) : >"$EXTRACT_FILE" ;;
        sweep) : >"$SWEEP_FILE" ;;
    esac
}

switch_on() {
    case "$1" in
        all)
            rm -f "$EXTRACT_FILE" "$SWEEP_FILE"
            ;;
        extract) rm -f "$EXTRACT_FILE" ;;
        sweep) rm -f "$SWEEP_FILE" ;;
    esac
}

CMD="${1:-}"
TARGET="${2:-all}"

case "$CMD" in
    off|on)
        case "$TARGET" in
            all|extract|sweep) : ;;
            *)
                printf '未知目标：%s\n\n' "$TARGET" >&2
                usage
                exit 2
                ;;
        esac
        if [ "$CMD" = "off" ]; then
            switch_off "$TARGET" || exit 1
        else
            switch_on "$TARGET" || exit 1
        fi
        do_status
        ;;
    status)
        do_status
        ;;
    "")
        usage
        exit 1
        ;;
    *)
        printf '未知命令：%s\n\n' "$CMD" >&2
        usage
        exit 2
        ;;
esac

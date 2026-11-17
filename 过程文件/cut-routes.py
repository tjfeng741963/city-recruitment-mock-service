# 按列表摘除共享文件里的死路由注册块（平衡括号匹配，保留前置注释一并删）。
import io
import re
import sys

# (文件, [要摘的路由 "METHOD /path" ...])
JOBS = {
    "src/modules/agent/agent.routes.ts": [
        "GET /api/v1/agent/candidates",
        "POST /api/v1/agent/candidates",
        "POST /api/v1/agent/candidates/:id/mark",
        "POST /api/v1/agent/candidates/:id/remind",
        "GET /api/v1/agent/device-scripts",
        "POST /api/v1/agent/device-scripts",
        "DELETE /api/v1/agent/device-scripts/:id",
        "PUT /api/v1/agent/device-scripts/:id",
        "GET /api/v1/agent/device/:id/workflow",
        "PUT /api/v1/agent/device/:id/workflow",
        "DELETE /api/v1/agent/device/:id/workflow",
        "GET /api/v1/agent/invite-group",
        "PUT /api/v1/agent/invite-group",
        "GET /api/v1/agent/invite-group/sends",
        "GET /api/v1/agent/old-friends",
        "GET /api/v1/agent/old-friends/accounts",
        "POST /api/v1/agent/old-friends/mark",
        "PUT /api/v1/agent/old-friends/:id/release",
        "PUT /api/v1/agent/old-friends/:id/unrelease",
        "PUT /api/v1/agent/old-friends/:id",
        "DELETE /api/v1/agent/old-friends/:id",
        "GET /api/v1/agent/reminder-tasks",
        "GET /api/v1/agent/report/metrics",
        "POST /api/v1/agent/devices/:id/test-dify",
    ],
    "src/modules/agent/kb-v3.routes.ts": [
        "GET /api/v1/flow-nodes",
        "POST /api/v1/flow-nodes",
        "DELETE /api/v1/flow-nodes/:id",
        "GET /api/v1/flow-edges",
        "POST /api/v1/flow-edges",
        "DELETE /api/v1/flow-edges/:id",
    ],
    "src/modules/agent/profile.routes.ts": [
        "GET /api/v1/agent/jobs",
        "POST /api/v1/agent/profile",
        "GET /api/v1/agent/profile",
    ],
    "src/modules/resources/resource.routes.ts": [
        "GET /api/v1/agent/evaluation/overview",
        "GET /api/v1/agent/evaluation/detail",
        "POST /api/v1/agent/evaluation/run",
        "GET /api/v1/agent/followup-config",
        "POST /api/v1/agent/followup-config",
        "GET /api/v1/agent/reminder-config",
        "POST /api/v1/agent/reminder-config",
        "GET /api/v1/agent/report/account-summary",
        "POST /api/v1/knowledge/batch/delete",
        "POST /api/v1/knowledge/batch/update",
    ],
}


def remove_route(src: str, method: str, path: str) -> tuple[str, bool]:
    # 找 app.<method>...( “…path…” 的起点（path 可能在泛型参数后面的第一个参数里）
    pattern = re.compile(r"app\." + method.lower() + r"(?:<[^;]*?>)?\(\s*(?:\{[^}]*)?['\"]" + re.escape(path) + r"['\"]")
    m = pattern.search(src)
    if not m:
        return src, False
    start = m.start()
    # 回溯到该语句所在的行首（保留前置注释的删除另做：删紧邻的连续注释行）
    line_start = src.rfind("\n", 0, start) + 1
    # 从 app. 起平衡匹配括号
    depth = 0
    i = start
    in_str = None
    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in "\"'`":
            in_str = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth == 0:
                # 吞掉紧随的 ; 与行尾
                j = i + 1
                if j < len(src) and src[j] == ";":
                    j += 1
                end = j
                # 吞掉行尾换行
                while end < len(src) and src[end] in " \t":
                    end += 1
                if end < len(src) and src[end] == "\n":
                    end += 1
                # 回溯删除紧邻的前置注释行与空行
                ls = line_start
                while True:
                    prev_end = ls - 1
                    prev_start = src.rfind("\n", 0, prev_end) + 1
                    prev = src[prev_start:prev_end]
                    if prev.strip().startswith("//") or prev.strip() == "":
                        ls = prev_start
                        if prev.strip() == "" and src[max(prev_start - 1, 0):prev_start] != "\n":
                            break
                    else:
                        break
                return src[:ls] + src[end:], True
        i += 1
    return src, False


total = 0
for path, routes in JOBS.items():
    src = io.open(path, encoding="utf-8").read()
    for spec in routes:
        method, rpath = spec.split(" ", 1)
        src, ok = remove_route(src, method, rpath)
        if not ok:
            print(f"!! 未找到: {spec} @ {path}")
        else:
            total += 1
    io.open(path, "w", encoding="utf-8", newline="").write(src)
    print(f"{path}: 完成")

print(f"共摘除 {total} 个路由块")

# 行级精确摘除：定位 `  app.<method>...("<path>"` 行，删到第一个缩进为 2 的 `});` 行。
import io
import re

JOBS = {
    "src/modules/agent/agent.routes.ts": [
        ("get", "/api/v1/agent/candidates"),
        ("post", "/api/v1/agent/candidates"),
        ("post", "/api/v1/agent/candidates/:id/mark"),
        ("post", "/api/v1/agent/candidates/:id/remind"),
        ("get", "/api/v1/agent/device-scripts"),
        ("post", "/api/v1/agent/device-scripts"),
        ("delete", "/api/v1/agent/device-scripts/:id"),
        ("put", "/api/v1/agent/device-scripts/:id"),
        ("get", "/api/v1/agent/device/:id/workflow"),
        ("put", "/api/v1/agent/device/:id/workflow"),
        ("delete", "/api/v1/agent/device/:id/workflow"),
        ("get", "/api/v1/agent/invite-group"),
        ("put", "/api/v1/agent/invite-group"),
        ("get", "/api/v1/agent/invite-group/sends"),
        ("get", "/api/v1/agent/old-friends"),
        ("get", "/api/v1/agent/old-friends/accounts"),
        ("post", "/api/v1/agent/old-friends/mark"),
        ("put", "/api/v1/agent/old-friends/:id/release"),
        ("put", "/api/v1/agent/old-friends/:id/unrelease"),
        ("put", "/api/v1/agent/old-friends/:id"),
        ("delete", "/api/v1/agent/old-friends/:id"),
        ("get", "/api/v1/agent/reminder-tasks"),
        ("get", "/api/v1/agent/report/metrics"),
        ("post", "/api/v1/agent/devices/:id/test-dify"),
    ],
    "src/modules/agent/kb-v3.routes.ts": [
        ("get", "/api/v1/flow-nodes"),
        ("post", "/api/v1/flow-nodes"),
        ("delete", "/api/v1/flow-nodes/:id"),
        ("get", "/api/v1/flow-edges"),
        ("post", "/api/v1/flow-edges"),
        ("delete", "/api/v1/flow-edges/:id"),
    ],
    "src/modules/agent/profile.routes.ts": [
        ("get", "/api/v1/agent/jobs"),
        ("post", "/api/v1/agent/profile"),
        ("get", "/api/v1/agent/profile"),
    ],
    "src/modules/resources/resource.routes.ts": [
        ("get", "/api/v1/agent/evaluation/overview"),
        ("get", "/api/v1/agent/evaluation/detail"),
        ("post", "/api/v1/agent/evaluation/run"),
        ("get", "/api/v1/agent/followup-config"),
        ("post", "/api/v1/agent/followup-config"),
        ("get", "/api/v1/agent/reminder-config"),
        ("post", "/api/v1/agent/reminder-config"),
        ("get", "/api/v1/agent/report/account-summary"),
        ("post", "/api/v1/knowledge/batch/delete"),
        ("post", "/api/v1/knowledge/batch/update"),
    ],
}

total = 0
for path, routes in JOBS.items():
    lines = io.open(path, encoding="utf-8").readlines()
    for method, rpath in routes:
        hit = -1
        for i, line in enumerate(lines):
            s = line.strip()
            if s.startswith(f"app.{method}") and f'"{rpath}"' in line:
                hit = i
                break
        if hit < 0:
            print(f"!! 未找到: {method.upper()} {rpath} @ {path.split('/')[-1]}")
            continue
        # 删前置连续注释行
        start = hit
        while start > 0 and lines[start - 1].strip().startswith("//"):
            start -= 1
        # 找结束行：strip == "});"
        end = hit
        depth_guard = 0
        while end < len(lines):
            if lines[end].strip() == "});":
                break
            end += 1
        if end >= len(lines):
            print(f"!! 没找到结束行: {method.upper()} {rpath}")
            continue
        del lines[start:end + 1]
        total += 1
    io.open(path, "w", encoding="utf-8", newline="").write("".join(lines))
    print(f"{path}: 完成")
print(f"共摘除 {total} 个路由块")

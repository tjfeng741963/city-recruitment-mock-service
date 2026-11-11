# 对齐：链路补全（城市加权/沟通中/convert/签到）与 React admin 部署形态

> 2026-11-11 晚。两个 agent：**A 后端链**（`src/`+`backend/`+`tests/`）、**B 前端**（`frontend/`）。
> 中控负责 React admin 构建部署与联调。

## 任务 1：kb 匹配城市加权（A / 8090）

`kb_placeholder.lookup(session, question, city=None)`：
- entry.city 与 city 相同 → 该条总分 +3
- entry.city 非空且 != city → **直接排除**（城市不符不许命中）
- entry.city 为空 → 通配，无加权
- `api_flow` 调用处传 `city_hint`（已有变量）
- 有 city 时 `match()` 不变，仅 lookup 层过滤加权

## 任务 2：collect「沟通中」推送（A）

1. 8090 `api_flow`：`result.stage == collect` 且 slots 无 `communicating_pushed` →
   `profile_push.push(device, session, {"stage": "collect"})` 一次，然后 `slots["communicating_pushed"]=True`
   （绕过 has_content，强制推；name/phone 到手后走正常 book 推送）
2. 4222 profile handler：收到 `profile.stage=="collect"` →
   upsert `candidate_events(event_type='communicating', status='pending')`（同客户无则建）
   拿到姓名电话建 invited 事件时，把 communicating 事件 status='converted'
3. candidates 接口原样返回所有事件；**Vue 旧页按三 tab 过滤未知类型不会显示，无兼容风险**

## 任务 3：未知问题转知识库（A）

- 8090：`create_entry` 鉴权 `AdminUser` → `ServiceOrUser`（X-Profile-Token 可调）
- 4222：`POST /api/v1/unknown-questions/{id}/convert`，body `{"answer": "...", "title": "可选"}`：
  1. 读问题原话 → title 默认取问题截断（去标点，≤30 字）
  2. POST 8090 `/api/v1/kb/entries`（kind=script, title, body=answer，X-Profile-Token 头）
     8090 地址从 env `REA_BRAIN_URL`（默认 `http://127.0.0.1:8090`）
  3. 成功 → unknown_questions.status='resolved'
  4. 8090 不可达 → 502 + 明确错误，不标 resolved

## 任务 4：候选人状态按钮（B / React）

- 候选人员页 status=invited 的行：加「已签到」「未到」按钮
- 调 `POST /api/v1/agent/candidates/:id/mark`，body `{status: "checked_in" | "no_show"}`
- 成功后本地状态更新 + 提示；接口在 4222 已存在

## 任务 5：未知问题「转知识库」（B / React）

- 未知问题页每行加「转知识库」：弹窗填答案（必填）、标题（选填）
- 调 convert 接口；成功后该行状态变已处理

## 任务 6：「沟通中」显示（B / React）

- 候选人员页加「沟通中」分组/标记（event_type='communicating' 且 status='pending'）
- 显示昵称 + 阶段提示「已答应面试，等待联系方式」

## 任务 7：React admin 部署形态（B 准备，中控部署）

- 路由 basename 取 `import.meta.env.BASE_URL`（构建时注入）
- 新脚本 `build:admin`：`vite build --base=/admin/`
- 产物构建后由中控传服务器 `source/public/admin/`，访问 `http://119.91.113.100:4222/admin/`
- **验收：/admin/ 能登录、候选/知识库/设备页可用；根路径 Vue 不受影响**

## 边界与验收

- A 不碰 frontend；B 不碰 src/backend；都不部署不 commit
- A：Python ≥682 全绿、Node ≥301 全绿；B：tsc 0 错 + build 通过
- 中控验收清单：/admin/ 登录可用、沟通中/convert/签到 全链路、Vue 根路径回归

# 城市招聘配置台 · 新前端

Vue 3 + Vite + TypeScript + Element Plus + Pinia + Router。
**前后端分离**：前端只通过 `/api/v1` 调用现有 4222 Node 后端，不含任何 mock 数据层；`dist/` 可独立部署到任意静态站点。

## 跑起来

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

- 开发环境 `/api` 由 Vite proxy 转到 `http://127.0.0.1:8080`（规避 CORS）
- 本地账号：`local-admin` / `local-demo-only`

生产构建 / 预览：

```bash
npm run build
npx vite preview --port 4173     # 用构建产物 + 同样的 /api 代理做验收
```

## 部署（两种分离形态）

| 形态 | 做法 | 何时用 |
|---|---|---|
| 同源反代（推荐） | nginx 把 `/` 指向 `dist/`，`/api/` 反代到 4222 | 有 nginx / 网关；无需改后端 |
| 跨域直连 | 构建时设 `VITE_API_BASE_URL=https://api.example.com`，后端补 CORS | 前后端不同域名、独立发布 |

```bash
# 跨域构建示例
VITE_API_BASE_URL=https://api.example.com npm run build
```

> 注意：4222 目前没有 CORS 头。跨域直连前需在后端加 `Access-Control-Allow-Origin`（含 `Authorization` 预检），否则浏览器会拦截。同源反代不受影响。
>
> `src/api/http.ts` 的 `backendUrl()` 会把 `/api/v1/agent/media/xxx` 这类相对路径拼上 `VITE_API_BASE_URL`，素材预览/下载在跨域模式下同样可用。

## 页面清单（26 个路由，与旧版菜单一一对应）

| 分组 | 路由 |
|---|---|
| 监控 | `/dashboard` 监控看板、`/device-report` 设备报表、`/account-summary` 运营汇总 |
| 基础配置 | `/cities`、`/factories`、`/service-positions`、`/city-links`、`/media` 素材库、`/holidays`、`/factory-overview` |
| 坐席运营 | `/agent-devices`、`/old-friends`、`/conversations`、`/archive` 面试登记、`/candidates` |
| 复聊激活 | `/activation`、`/activation/customers`、`/activation/strategies`、`/activation/devices`、`/activation/scripts` |
| 知识管理 | `/knowledge`、`/unknown-questions` |
| 系统管理 | `/recruiters`、`/recruiter-featured`、`/users`、`/settings` |
| 其他 | `/login`、`/m` 移动端 |

## 目录结构

```
src/
  api/           http.ts（基址/鉴权/401）、types.ts、core.ts、agent.ts、knowledge.ts、system.ts、metrics.ts
  components/    basic / ops / kb / system / metrics  按域拆分的弹窗与子组件
  layouts/       MainLayout.vue（26 项菜单、分组展开、收起）
  views/         29 个页面
  utils/         format.ts（时间/字节/脱敏/下载）
  router/        路由表 + 登录守卫
  styles/        少量全局修正（主体样式复用 public/legacy）
```

## 视觉基线

旧前端 `8080`、新前端 `5173` 可直接并排对照。旧样式复用方式：

- `public/legacy/assets/*.css`：从旧 `public/assets` 复制，去掉 `[data-v-*]` 作用域；
- `public/theme/*.css`、`fonts/`、`skyline.svg`：原样复制；
- 旧 JS bundle 不引用，页面全部是源码实现。

对照截图：`../screenshots/compare/index.html`（9 个页面的旧/新并排 + 计算样式差异）。

## 测试

```bash
cd ..
node scripts/e2e/run.mjs 9        # 路由冒烟 + 交互 + 结构 + 边界（96 用例）
node scripts/e2e/deep.mjs 9       # 分域深度功能（33 用例，自带数据清理）
node scripts/visual-compare.mjs   # 新旧视觉指标对照
node scripts/cleanup-e2e.mjs      # 清理深度用例留下的软删除 e2e 用户

# 对生产构建跑同一套：
cd frontend && npx vite preview --port 4173
cd .. && E2E_BASE=http://127.0.0.1:4173 node scripts/e2e/run.mjs 8
```

## 已知差距

- 后端未提供的接口（页面已做明确降级提示，不伪造数据）：
  `/activation/dashboard/*`、`/activation/customers`、`/activation/strategies`、`/activation/devices`、
  `/agent/candidates`、`/agent/old-friends`、`/agent/report/account-summary`
- 城市招聘状态由设备绑定推导，`PATCH /cities/:id/status` 后端固定 422，页面原样提示；
- 岗位「住宿/年龄」两列部分记录后端为空，显示 `-`；有值时长文本换行展示；
- 角色权限只做了路由守卫（未按角色隐藏菜单），因为旧版菜单本身对 admin 全量可见。

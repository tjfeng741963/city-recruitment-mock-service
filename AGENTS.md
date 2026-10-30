# 城市招聘配置还原 · 协作与发布规则

本文件写给参与本仓库的人和 AI Agent。改代码、推代码前先读完。

## 项目是什么

城市招聘配置系统的 1:1 还原服务：Fastify + TypeScript 后端（`src/`），SQLite 存储，托管旧版 Vue 前端（`public/`，含换皮主题 `public/theme/`）和新 React 前端（`frontend/`）。生产环境跑在腾讯云 `119.91.113.100`，Docker Compose 部署，端口 `4222`。

## 发布方式：推到 main 即自动上线

流水线定义在 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)：

| 触发 | 做什么 |
|------|--------|
| 向 `main` 开 PR / 更新 PR | 只跑检查，不部署 |
| push 到 `main`（含 PR 合并） | 检查通过后自动部署到生产 |
| Actions 页面手动 Run workflow（选 main） | 重新检查并部署 main 最新提交 |

检查项（任一失败就不会部署）：

1. `npm ci` + `frontend/` 下 `npm ci`
2. `npx tsc --noEmit` 后端类型检查
3. `frontend/` 下 `npm run build`
4. `npx vitest run --testTimeout=20000` 全部测试

部署步骤（在服务器上以 `deploy` 用户执行）：拉取并 checkout 该提交 → 备份 `.env.production` 和 SQLite 数据库（带提交号和时间戳）→ `docker compose build` + `up -d` → 60 秒内轮询 `http://127.0.0.1:4222/login`，失败则打印容器日志并让流水线标红。

同一时间只会有一个生产部署，后来的排队等待，不会互相打断。

## 推代码前必须做

本地先跑一遍和流水线相同的检查，全部通过再推：

```bash
npm ci
npx tsc --noEmit
(cd frontend && npm ci && npm run build)
npx vitest run --testTimeout=20000
```

## 推代码规则

- **只提交自己改的文件**，用 `git add <具体路径>`，禁止 `git add .` / `git add -A`。工作区里常有别人或别的会话的未提交改动。
- 提交信息用 Conventional Commits：`feat: …` / `fix: …` / `refactor: …` / `test: …` / `docs: …` / `chore: …`，描述可以用中文。
- 改动较大或不确定时，推到新分支开 PR，等 PR 检查变绿再合并；小改动可以直接推 `main`，但推了就会上线。
- 禁止 force push `main`，禁止改写已推送的历史。
- 新功能、bug 修复要带测试，测试放 `tests/`。
- 推完去 GitHub Actions 看 `test-and-deploy` 是否全绿；红了要立刻修或回滚，不要放着。

## 绝对不能提交的东西

- `.env*`、任何密钥、token、密码、SSH 私钥（`.gitignore` 已忽略 `.env*`，但不要绕过）
- `data/*.sqlite` 数据库文件
- `过程文件/` 下的调试产物、截图、bundle、日志（不要新增到 Git）
- `node_modules/`、`dist/`

生产配置 `.env.production` 只存在服务器上，流水线不会改它。

## 回滚

线上出问题时，用 revert 回滚，让流水线重新部署旧代码：

```bash
git revert <出问题的提交>
git push origin main
```

数据库被新代码写坏时，服务器 `/srv/apps/city-recruitment-mock-service/source/data/` 下有每次部署前的备份 `app.sqlite.pre-<提交号>-<时间>.bak`。恢复数据库需要停服务，先找仓库管理员，不要自己动。

## 权限与凭据（管理员维护）

- 推代码需要 GitHub 仓库 `tjfeng741963/city-recruitment-mock-service` 的写权限，找仓库管理员加协作者。
- 流水线用到的 GitHub Secrets：`DEPLOY_SSH_PRIVATE_KEY`、`DEPLOY_SSH_HOST`、`DEPLOY_SSH_USER`。协作者不需要也不应该拿到这些值。
- 服务器公钥登记在 `/home/deploy/.ssh/authorized_keys`，注释为 `github-actions-deploy-city-recruitment`。服务器重装后需更新 workflow 里固定的 host key。
- 首次部署、环境变量说明见 [docs/deployment.md](docs/deployment.md)。

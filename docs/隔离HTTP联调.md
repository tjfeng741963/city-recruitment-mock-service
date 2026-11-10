# 双后端隔离 HTTP 联调

这个入口用于在开发机或 CI 验证 Node 桥接与 Python 主上报的实际 HTTP、持久化和重启恢复，不需要企业微信或 pywin32，不会启动 agent。

## 运行

Node 需要 22.19 或以上，Python 需要 3.11 或以上。先在根目录安装 Node 依赖，并为当前 Python 安装 `backend/pyproject.toml` 中的依赖：

```powershell
npm ci
python -m pip install uv
python -m uv pip install --python python -r backend/pyproject.toml
python scripts/acceptance-smoke.py --report data/acceptance-smoke.json
```

使用已有虚拟环境时，直接用该环境的 Python 执行最后一行即可。`--report` 可省略；提供时写出不含凭据的 JSON 结果。成功退出 0，失败退出 1。失败报告只列阶段及 HTTP 状态，不包含响应正文、管理员密码、设备 token 或租约。

工具只连接自己启动的 `127.0.0.1` 服务，使用动态空闲端口。不会停止已有进程或占用 4222/8090；Python 端口探测与启动之间若被其他程序占用，会报错退出。运行中所有数据库、实例 ID 和日志均放在系统临时目录，每次使用随机测试凭据；从子进程环境移除继承的 APP/REA/WECOM/UVICORN 配置，禁用 Python 后台发送/同步任务和真实企微通道。

Node 测试通道使用 bridge，但没有真实 agent，指令由工具模拟领取与回执；设备开启 `observe_only`。Python 在临时目录启动，不会读取仓库的 `.env`。Node 只为定位迁移切换到仓库目录，数据库位置明确指向临时目录。工具不读写 `agent/config.json`、回复记录或上报状态。

## 八个场景

| 场景 | 验证内容 |
|---|---|
| 双后端启动及登录 | 初始化、迁移、管理员登录、Python 实例标识 |
| 设备认证隔离 | 两套服务注册同一设备，各自 token 有效；跨服务 token 被拒绝 |
| 主上报双向去重 | Python 会话映射、入站/出站入库、相同批次重放不新增 |
| 桥接观察 | Node 双向文本、重复事件去重、出站不加未读、不生成自动发送 |
| 人工指令 | 同幂等键返回同一指令、领取排他、观察消息先到 |
| Node 重启恢复 | 终止并重启服务，原认证和租约继续有效；设备离线仍可接收回执，重复回执不新增气泡，保留实际观察时间 |
| Python 重启恢复 | 实例 ID、管理员及设备认证、已有会话和上报去重继续有效 |
| 重新配对恢复 | 旧 token 被拒绝、已领取消息 unknown、未领取消息 failed；迟到有效成功回执可确认，不自动重发 |

即使场景中数据库状态为 sent，也只是测试夹具构造的回执，不代表真实企微已发送。这些场景不替代真实窗口、剪贴板、落点回读、知识库内容或 agent 执行日志验收。Windows 人工清单中的 W01-W10 仍独立记录。

## 清理与 CI

正常结束、校验失败或 Ctrl+C 时，工具会停止自己创建的 Node/Python 子进程，关闭日志，并释放临时目录；不会操作其他服务。报告 `temporary_data_removed: true` 仅在临时目录清理成功后出现。失败时保留已通过的场景列表，进程错误不会被当作通过。

`.github/workflows/deploy.yml` 在 Ubuntu 和 Windows 的 Node/Python 全量测试之后运行此入口，失败会阻止部署任务进入成功条件。开发分支和 PR 仍只检查，不部署生产。

# 工作流编辑生效闭环实施计划

**Goal:** 完成用户确认的四项：升级云 Windows、旧开场自动刷新、统一间隔、统一编辑入口及真实同步证据。

**Architecture:** 延续既有 Vue/Element Plus、节点流程与旧开场 API、设备令牌鉴权、Windows 更新器。新增设备单独上报配置拉取摘要，只允许对应设备写，管理员读取；不把会话快照版本当配置同步版本。旧开场与流程都最多每 60 秒检查，单轮欢迎介绍保持独立内容快照。

## 范围与约束

- 用户已确认修复方案并授权合并部署及升级云 Windows，无须再次确认。
- 不改深圳启停、业务设备岗位绑定、企微发送核心或动作；更新时先通过现有管理器停进程、备份程序并核对账本/配置/快照哈希。
- `agent/wecom_io_core/` 四个冻结文件逐字节保持。`agent/` 只改 `brain.py` 和 `autopilot.py`。
- 旧开场网络失败保留最后成功缓存但显示异常；401/403 阻断缓存发送。一次开场的清单必须复制，不中途混合版本。
- 保留每条“发送后间隔”，移除独立“节点间隔”控件；不重定义发送动作时序。
- 旧开场的每条间隔在发送成功后生效，客户端共享安全冷却仍保留，实际等待可更长。
- 只提交具体文件，不提交凭据、数据库、日志、截图和过程探针。

## Tasks

### 1. Windows 拉取与同步摘要

- [ ] 在 `backend/tests/test_node_flow_brain.py` 增加可控时间回归：60 秒内不重取，过期刷新，原清单不变，网络失败缓存可见但摘要stale，401/403 blocked，空开场取消旧缓存。
- [ ] 先运行失败测试，再改 `agent/brain.py`；记录成功拉取的岗位、版本、更新时间、状态及错误码，摘要不包含话术、客户或令牌。
- [ ] `agent/autopilot.py` 在 Reporter 桥接心跳后调用 Brain 配置摘要上报；旧开场 blocked 时不能落入普通聊天继续发；每次欢迎使用独立清单副本。
- [ ] 客户端上报 `POST /api/v1/agent/config-sync`：`{device_code,client_commit,flow:{position_id,version,status,synced_at,checked_at,state,error},opening:{position_id,version,synced_at,checked_at,state,error}}`。开场版本由服务端计算hash并返回，不拿修改时间猜同步。

### 2. 服务端真实同步证据

- [ ] TDD 为新配置摘要接口写回归；设备token只能上报自己；管理员/其他设备不可冒用；仅白名单字段存入设备data_json；时间规范化，保留checked_at与synced_at区别。
- [ ] 管理员 `GET /api/v1/agent/config-sync?device_code=` 返回最新摘要与服务端接收时间；无摘要为unknown。旧设备不自动标已同步。
- [ ] 给 `GET /api/v1/agent/opening` 和管理员persona响应增加同算法的 `opening_version`；内容、顺序、素材、间隔和岗位变化均影响hash。
- [ ] 更新 `docs/API-接口清单.md`，运行路由文档校验与类型检查。

### 3. 编辑入口与统一间隔

- [ ] 流程运行视图增加当前模式、服务器版本、客户端上报版本/时间/异常；已同步必须匹配岗位与版本，陈旧/离线/缺证据不得绿色已生效。
- [ ] 旧开场节点提供“编辑当前开场”按钮，打开复用的岗位Agent抽屉并预选开场标签；保存/排序后保持开场标签并刷新运行图，不维护第二套编辑器。
- [ ] AI可选媒体提供素材管理入口，人设/问答提供对应入口。明确只读说明节点不是固定消息。
- [ ] 移除“节点间隔”及其setter，保留每条实际执行的发送后间隔，并说明最后一条间隔用于下一节点前等待。
- [ ] 加前端状态推导测试、入口/间隔合同测试，浏览器验收停用深圳模式、编辑抽屉、旧设备unknown和新摘要匹配。

### 4. 发布与云 Windows 升级验收

- [ ] 本地npm ci、迁移/API检查、tsc、全量Vitest、相关Python回归、Vue构建；独立审查后合并部署main并跟踪全绿。
- [ ] 获取该提交官方Release整包及digest；云Windows核对host/version/session/process/task，用现有ManagerService.stop精确停发送进程。
- [ ] 备份并记录配置/账本/状态/冻结核心，使用现有client_updater.apply_package验包备份替换，核对安装commit和逐文件hash；不逐文件硬覆盖。
- [ ] 在云Windows隔离设备/目录验旧开场自然刷新、单节点停用、每条间隔、配置摘要上报与网页匹配，发送层替换为记录器，未发客户消息。
- [ ] 若远程桌面断开、企微未就绪，不恢复发送并明确报告；原启停与绑定保留。清理验收设备凭据，保存脱敏报告。

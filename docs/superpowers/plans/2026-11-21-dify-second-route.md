# Dify 第二条回复路线实施计划

**Goal:** 在现有 C:\agent 和 4222 中按设备切换 Dify，先完成隔离测试。

**Architecture:** 保留当前客户端请求与返回信封，在 chat 路由入口进行来源分流。独立模块管理配置、Dify 会话、HTTP 协议及内容清理；Dify 集成应用只接受当前岗位事实。

**Tech Stack:** Fastify、TypeScript、SQLite、Vitest、Dify Community 1.20。

## Global Constraints

- 不修改 agent/ 或 wecom_io_core；不变更当前设备来源。
- 非思考模型 deepseek-chat；不返回密钥。
- 数据库迁移使用下一个可用编号；变更接口同步 API 文档。

### Task 1: 后端配置与会话适配

- [x] 在 tests/dify-reply.test.ts 写配置鉴权、默认隔离、实时岗位输入、多轮会话、失败关闭测试，先运行并确认失败。
- [x] 新建 src/modules/dify/dify-reply.ts 与迁移，使用服务端 REA_DIFY_BASE_URL / REA_DIFY_API_KEY。
- [x] 在 agent/chat 和 opening 添加来源分流，保留现有返回结构。
- [x] 单测通过并覆盖旧 Agent 回归。

### Task 2: 真实 Dify 应用与隔离联调

- [x] 新建集成应用副本，所有业务事实来自 inputs.position_data，四段流程使用中性岗位咨询与面试意向流程。
- [x] 发布集成测试应用，凭据只存受限服务器配置，不进代码与日志。
- [x] 隔离启动服务，读取一份非敏感岗位事实，真实 API 测试多轮回复；记录生成与发送边界。

### Task 3: 配置入口与验收

- [x] 将配置接口、状态说明及运维步骤写入 API 清单和第二路线使用文档。
- [x] 完成 npm ci、迁移检查、API 检查、tsc 与全部 Vitest。
- [x] 审查改动与线上版本漂移，准备分支/PR 和部署方案。真实测试联系人未指定前不发送。

# 招聘导航与岗位知识接线实施计划

目标：按已确认名称组织侧栏，让话术流程、问答和素材共用岗位上下文；同岗位问答进入当前 Agent prompt。

约束：对话管理、候选人管理组件不修改；原城市/岗位改造继续保留；不修改 agent 发送动作或流程推进；不改 LLM 模型；使用 Vue 源码并保留旧路由。

- [x] 导航：新增可测试的菜单配置，首页/日常招聘/招聘资料/AI 接待/账号与设置。管理员区按角色显示；旧主推/地域/总览能力放入关联页面快捷入口。
- [x] 岗位上下文：用 URL position_id 和按登录用户区分的浏览器存储共享选择；进入话术流程、问答、素材自动核对岗位是否存在；岗位列表提供三个直接入口。
- [x] 问答：原 kb_faq 专用 API 支持岗位读写，保留通用及历史作用域；新建明确选择通用/岗位，避免旧兼容写入丢作用域；问答保存后无需 Python 发布即可被本轮 Node Agent 使用。
- [x] 运行：只读取启用且通过治理的通用问答和当前岗位专属问答。共享占位符用岗位事实渲染，缺失字段跳过；其他岗位、地域、招工方范围不在未验证映射时泛用。dry QA 返回知识依据；不改变云电脑流程推进。
- [x] 验证与发布产物：先写岗位知识隔离和菜单行为失败测试；Vue build、tsc、API/迁移检查、Node 全量测试；生成 public 产物时保留受保护页面旧模块，避免附带改动；保留现有 theme 支持脚本但禁用已由原生页承担的重复注入。

文件分工：frontend-vue/src/layouts/navigation.ts 管菜单；components/agent/PositionContext.vue 管共享选择和快捷入口；views/KnowledgeView.vue 与 api/knowledge.ts 管岗位知识；src/modules/agent/position-knowledge.ts 管当前运行链路读取；agent-chat.routes.ts / agent-orchestrator.ts 管注入与 dry 证据。

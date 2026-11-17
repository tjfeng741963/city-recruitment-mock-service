// 从真实路由快照生成 src/modules/agent/route-notes.ts：
// 260 条路由 → 分组 + 一句话功能 + 在用状态。规则表覆盖全部路由，
// 生成后提交为数据文件，/dev 目录接口把没进人工目录的路由按它归类。
import fs from "node:fs";

const snapshot = JSON.parse(fs.readFileSync("data/routes-snapshot.json", "utf8"));
const routes = [];
const seen = new Set();
for (const r of snapshot.items) {
  const key = `${r.method} ${r.url}`;
  if (seen.has(key)) continue;
  seen.add(key);
  routes.push({ method: r.method, url: r.url });
}

// 状态：active=新链路在用 / ui=后台页面在用 / bridge=客户端心跳在用 / legacy=旧链路遗留未接线
const RULES = [
  // ── 激活策略（整个子系统随旧链路废弃）──
  [/^\/api\/v1\/activation\/config/, "激活总开关与暂停配置", "legacy"],
  [/^\/api\/v1\/activation\/customers/, "候选客户档案与 AI 摘要", "legacy"],
  [/^\/api\/v1\/activation\/dashboard\/feed$/, "激活看板·动态流", "legacy"],
  [/^\/api\/v1\/activation\/dashboard\/population$/, "激活看板·客群构成", "legacy"],
  [/^\/api\/v1\/activation\/dashboard\/stats$/, "激活看板·统计", "legacy"],
  [/^\/api\/v1\/activation\/dashboard\/strategy-effect$/, "激活看板·策略效果", "legacy"],
  [/^\/api\/v1\/activation\/dashboard\/trend$/, "激活看板·趋势", "legacy"],
  [/^\/api\/v1\/activation\/device-resources/, "激活设备资源库", "legacy"],
  [/^\/api\/v1\/activation\/devices/, "激活设备列表与批量启停", "legacy"],
  [/^\/api\/v1\/activation\/records\/:id\/approve$/, "审批激活记录", "legacy"],
  [/^\/api\/v1\/activation\/records\/:id\/freeze$/, "冻结激活记录", "legacy"],
  [/^\/api\/v1\/activation\/records\/:id\/run$/, "执行激活记录", "legacy"],
  [/^\/api\/v1\/activation\/records\/:id\/skip$/, "跳过激活记录", "legacy"],
  [/^\/api\/v1\/activation\/records$/, "激活记录列表", "legacy"],
  [/^\/api\/v1\/activation\/scan\/manual$/, "手动触发激活扫描", "legacy"],
  [/^\/api\/v1\/activation\/scheduler\/run$/, "手动执行激活调度", "legacy"],
  [/^\/api\/v1\/activation\/scripts\/export$/, "导出激活话术库", "legacy"],
  [/^\/api\/v1\/activation\/scripts\/import$/, "导入激活话术库", "legacy"],
  [/^\/api\/v1\/activation\/scripts\/random$/, "随机取一条激活话术", "legacy"],
  [/^\/api\/v1\/activation\/scripts/, "激活话术库 CRUD", "legacy"],
  [/^\/api\/v1\/activation\/strategies\/:id\/test$/, "试跑激活策略", "legacy"],
  [/^\/api\/v1\/activation\/strategies/, "激活策略列表与更新", "legacy"],
  [/^\/api\/v1\/activation\/strategy-resources/, "激活策略资源关联", "legacy"],
  [/^\/api\/v1\/admin\/overview$/, "系统概览统计", "ui"],

  // ── Agent 新链路 ──
  [/^\/api\/v1\/agent\/candidates$/, "老客激活候选人列表", "legacy"],
  [/^\/api\/v1\/agent\/candidates$/, "登记候选人", "legacy"],
  [/^\/api\/v1\/agent\/candidates\/:id\/mark$/, "标记候选人状态", "legacy"],
  [/^\/api\/v1\/agent\/candidates\/:id\/remind$/, "提醒候选人", "legacy"],
  [/^\/api\/v1\/agent\/cities$/, "8090 服务间查城市清单（旧链路遗留）", "legacy"],
  [/^\/api\/v1\/agent\/jobs$/, "8090 服务间查岗位（旧链路遗留）", "legacy"],
  [/^\/api\/v1\/agent\/conversations$/, "会话列表（后台会话页）", "ui"],
  [/^\/api\/v1\/agent\/conversations\/:id\/reset-disqualified$/, "重置流失标记（后台会话页）", "ui"],
  [/^\/api\/v1\/agent\/conversations\/:id\/restart$/, "重启会话（后台会话页）", "ui"],
  [/^\/api\/v1\/agent\/conversations\/:id\/send$/, "人工从会话页发消息", "ui"],
  [/^\/api\/v1\/agent\/device-scripts/, "旧「设备话术」CRUD（新 Agent 链路不用）", "legacy"],
  [/^\/api\/v1\/agent\/device\/:id\/clear-unread$/, "清除设备会话未读", "ui"],
  [/^\/api\/v1\/agent\/device\/:id\/workflow$/, "设备工作流配置（旧链路遗留）", "legacy"],
  [/^\/api\/v1\/agent\/devices\/:code\/login-qr$/, "读设备登录二维码", "ui"],
  [/^\/api\/v1\/agent\/devices$/, "设备列表 / 新建设备", "ui"],
  [/^\/api\/v1\/agent\/devices\/:id$/, "更新 / 删除设备", "ui"],
  [/^\/api\/v1\/agent\/devices\/:id\/test-dify$/, "测试设备 Dify 连通", "legacy"],
  [/^\/api\/v1\/agent\/evaluation\/detail$/, "评估明细", "legacy"],
  [/^\/api\/v1\/agent\/evaluation\/overview$/, "评估总览", "legacy"],
  [/^\/api\/v1\/agent\/evaluation\/run$/, "触发评估", "legacy"],
  [/^\/api\/v1\/agent\/evaluations$/, "评估任务列表 / 新建", "legacy"],
  [/^\/api\/v1\/agent\/evaluations\/:id$/, "评估任务详情 / 更新 / 删除", "legacy"],
  [/^\/api\/v1\/agent\/followup-config$/, "旧追跟进配置", "legacy"],
  [/^\/api\/v1\/agent\/followup\/run$/, "手动跑追跟进", "legacy"],
  [/^\/api\/v1\/agent\/invite-group\/sends$/, "邀约群发送记录", "legacy"],
  [/^\/api\/v1\/agent\/invite-group$/, "邀约群配置", "legacy"],
  [/^\/api\/v1\/agent\/manual-reply$/, "人工接管回复", "ui"],
  [/^\/api\/v1\/agent\/messages$/, "会话消息记录查询", "ui"],
  [/^\/api\/v1\/agent\/old-friends\/accounts$/, "老友池账号列表", "legacy"],
  [/^\/api\/v1\/agent\/old-friends\/:id\/release$/, "释放老友", "legacy"],
  [/^\/api\/v1\/agent\/old-friends\/:id\/unrelease$/, "恢复老友锁定", "legacy"],
  [/^\/api\/v1\/agent\/old-friends\/:id$/, "更新老友", "legacy"],
  [/^\/api\/v1\/agent\/old-friends$/, "老友池列表", "legacy"],
  [/^\/api\/v1\/agent\/old-friends\/mark$/, "标记老友", "legacy"],
  [/^\/api\/v1\/agent\/profile$/, "8090 服务间档案推送（旧链路遗留）", "legacy"],
  [/^\/api\/v1\/agent\/reminder-config$/, "旧提醒配置", "legacy"],
  [/^\/api\/v1\/agent\/reminder-tasks$/, "旧提醒任务列表", "legacy"],
  [/^\/api\/v1\/agent\/report\/account-summary$/, "账号汇总报表", "legacy"],
  [/^\/api\/v1\/agent\/report\/metrics$/, "指标报表", "legacy"],
  [/^\/api\/v1\/agent\/rules/, "旧回复规则 CRUD", "legacy"],
  [/^\/api\/v1\/agent\/status\/dashboard$/, "状态看板", "ui"],
  [/^\/api\/v1\/agent\/stream$/, "SSE 实时事件流（后台页面）", "ui"],
  [/^\/api\/v1\/agent\/takeover$/, "人工接管会话", "ui"],
  [/^\/api\/v1\/agent\/unknown-questions$/, "8090 知识库未命中记账（旧链路遗留）", "legacy"],

  // ── 账号 ──
  [/^\/api\/v1\/auth\/me$/, "当前登录用户信息", "ui"],
  [/^\/api\/v1\/auth\/users\/:id\/reset-password$/, "重置用户密码", "ui"],
  [/^\/api\/v1\/auth\/users\/:id\/scopes$/, "用户数据范围（只读/编辑）", "ui"],
  [/^\/api\/v1\/auth\/users\/:id$/, "更新 / 删除用户", "ui"],
  [/^\/api\/v1\/auth\/users$/, "用户列表 / 新建用户", "ui"],

  // ── 设备桥接（客户端心跳与收发，瘦客户端在用）──
  [/^\/api\/v1\/bridge\/devices\/:code$/, "查设备信息", "bridge"],
  [/^\/api\/v1\/bridge\/devices\/:code\/claim$/, "设备认领任务", "bridge"],
  [/^\/api\/v1\/bridge\/devices\/:code\/config$/, "设备拉配置", "bridge"],
  [/^\/api\/v1\/bridge\/devices\/:code\/heartbeat$/, "设备心跳", "bridge"],
  [/^\/api\/v1\/bridge\/devices\/:code\/inbound$/, "上报收到的消息", "bridge"],
  [/^\/api\/v1\/bridge\/devices\/:code\/outbound$/, "下发待发消息", "bridge"],
  [/^\/api\/v1\/bridge\/devices\/:code\/pair$/, "设备配对", "bridge"],
  [/^\/api\/v1\/bridge\/devices\/:code\/receipts$/, "发送回执", "bridge"],
  [/^\/api\/v1\/bridge\/devices\/:code\/register$/, "设备自注册（共享密钥换令牌）", "bridge"],
  [/^\/api\/v1\/bridge\/devices\/:code\/login-qr$/, "上传 / 清除登录二维码", "bridge"],

  // ── 企微客服通道（未启用）──
  [/^\/api\/v1\/channels\/wecom-kf\/callback$/, "企微客服回调", "legacy"],
  [/^\/api\/v1\/channels\/wecom-kf\/run$/, "手动跑企微客服拉取", "legacy"],
  [/^\/api\/v1\/channels\/wecom-kf\/status$/, "企微客服通道状态", "legacy"],

  // ── 城市与工厂 ──
  [/^\/api\/v1\/cities\/:id\/factories\/:factoryId$/, "城市-工厂绑定（解绑/更新）", "ui"],
  [/^\/api\/v1\/cities\/:id\/factories$/, "城市下工厂列表 / 绑定", "ui"],
  [/^\/api\/v1\/cities\/:id\/history\/:historyId$/, "历史版本详情", "ui"],
  [/^\/api\/v1\/cities\/:id\/restore\/:historyId$/, "恢复到历史版本", "ui"],
  [/^\/api\/v1\/cities\/:id\/history$/, "城市修改历史", "ui"],
  [/^\/api\/v1\/cities\/:id\/status$/, "城市启停", "ui"],
  [/^\/api\/v1\/cities\/:id$/, "城市详情 / 更新 / 删除", "ui"],
  [/^\/api\/v1\/cities$/, "城市列表 / 新建", "ui"],
  [/^\/api\/v1\/city-links\/batch$/, "批量建关联城市", "ui"],
  [/^\/api\/v1\/city-links\/options$/, "关联城市下拉选项", "ui"],
  [/^\/api\/v1\/city-links$/, "关联城市列表 / 新建", "ui"],
  [/^\/api\/v1\/factories\/:id$/, "工厂详情 / 更新 / 删除", "ui"],
  [/^\/api\/v1\/factories$/, "工厂列表 / 新建", "ui"],
  [/^\/api\/v1\/holiday-schedules\/my-cities$/, "我的城市节假日", "ui"],
  [/^\/api\/v1\/holiday-schedules\/:id$/, "节假日详情 / 更新 / 删除", "ui"],
  [/^\/api\/v1\/holiday-schedules$/, "节假日列表 / 新建", "ui"],

  // ── 招工方 / 区域 / 品类 / 招聘员 ──
  [/^\/api\/v1\/employers\/:id$/, "招工方更新 / 删除", "ui"],
  [/^\/api\/v1\/employers$/, "招工方列表 / 新建", "ui"],
  [/^\/api\/v1\/locations\/:id$/, "区域更新 / 删除", "ui"],
  [/^\/api\/v1\/locations$/, "区域列表 / 新建", "ui"],
  [/^\/api\/v1\/verticals\/:id$/, "品类更新 / 删除", "ui"],
  [/^\/api\/v1\/verticals$/, "品类列表 / 新建", "ui"],
  [/^\/api\/v1\/recruiter-featured\/cities\/:id$/, "推荐城市更新 / 删除", "ui"],
  [/^\/api\/v1\/recruiter-featured\/cities$/, "招工方推荐城市", "ui"],
  [/^\/api\/v1\/recruiters\/:id\/cities\/:cityId$/, "招聘员城市授权（编辑/解绑）", "ui"],
  [/^\/api\/v1\/recruiters\/:id\/cities\/batch$/, "批量授权城市", "ui"],
  [/^\/api\/v1\/recruiters\/:id\/cities$/, "招聘员授权城市列表 / 授权", "ui"],
  [/^\/api\/v1\/recruiters\/:id\/password$/, "改招聘员密码", "ui"],
  [/^\/api\/v1\/recruiters\/:id\/service-cities\/batch$/, "批量设置服务城市", "ui"],
  [/^\/api\/v1\/recruiters\/:id\/service-cities\/options$/, "服务城市下拉选项", "ui"],
  [/^\/api\/v1\/recruiters\/:id\/service-cities$/, "招聘员服务城市", "ui"],
  [/^\/api\/v1\/recruiters\/:id$/, "招聘员详情 / 更新 / 删除", "ui"],
  [/^\/api\/v1\/recruiters$/, "招聘员列表 / 新建", "ui"],

  // ── 知识库（配置台在用；新 Agent 会话暂不读）──
  [/^\/api\/v1\/kb-faqs\/audit$/, "共享问答合规审计", "ui"],
  [/^\/api\/v1\/kb-faqs\/:id$/, "问答更新 / 删除", "ui"],
  [/^\/api\/v1\/kb-faqs$/, "场景问答列表 / 新建", "ui"],
  [/^\/api\/v1\/kb-publish\/apply$/, "发布共享问答（apply）", "ui"],
  [/^\/api\/v1\/kb-publish\/history$/, "发布历史与回滚", "ui"],
  [/^\/api\/v1\/kb-publish\/preview$/, "发布预览（preview）", "ui"],
  [/^\/api\/v1\/kb-templates\/:code\/import$/, "一键导入模板包", "ui"],
  [/^\/api\/v1\/kb-templates\/:code$/, "模板包详情", "ui"],
  [/^\/api\/v1\/kb-templates$/, "模板包列表", "ui"],
  [/^\/api\/v1\/knowledge\/batch\/delete$/, "批量删除知识条目", "legacy"],
  [/^\/api\/v1\/knowledge\/batch\/export$/, "批量导出知识条目", "legacy"],
  [/^\/api\/v1\/knowledge\/batch\/import$/, "批量导入知识条目", "legacy"],
  [/^\/api\/v1\/knowledge\/batch\/update$/, "批量更新知识条目", "legacy"],
  [/^\/api\/v1\/knowledge\/:id$/, "知识条目详情 / 更新 / 删除", "legacy"],
  [/^\/api\/v1\/knowledge$/, "旧知识条目列表 / 新建（兼容接口）", "legacy"],

  // ── 旧流程节点图 ──
  [/^\/api\/v1\/flow-edges$/, "旧流程连线列表 / 新建（未接线）", "legacy"],
  [/^\/api\/v1\/flow-edges\/:id$/, "删除旧流程连线", "legacy"],
  [/^\/api\/v1\/flow-nodes$/, "旧流程节点列表 / 新建（未接线）", "legacy"],
  [/^\/api\/v1\/flow-nodes\/:id$/, "删除旧流程节点", "legacy"],

  // ── 导入导出 ──
  [/^\/api\/v1\/import-export\/factories\/export$/, "导出工厂", "ui"],
  [/^\/api\/v1\/import-export\/factories\/import$/, "导入工厂", "ui"],
  [/^\/api\/v1\/import-export\/import$/, "总导入入口", "ui"],
  [/^\/api\/v1\/import-export\/service-positions\/export$/, "导出岗位", "ui"],
  [/^\/api\/v1\/import-export\/service-positions\/import$/, "导入岗位", "ui"],
  [/^\/api\/v1\/import-export\/template$/, "下载导入模板", "ui"],

  // ── 岗位 ──
  [/^\/api\/v1\/service-positions\/:id\/factory-binding$/, "岗位-工厂绑定读取 / 保存", "ui"],
  [/^\/api\/v1\/service-positions\/:id\/holidays\/:holidayId$/, "岗位节假日（更新/删除）", "ui"],
  [/^\/api\/v1\/service-positions\/:id\/holidays$/, "岗位节假日列表 / 新建", "ui"],
  [/^\/api\/v1\/service-positions\/:id\/toggle-featured$/, "岗位推荐位开关", "ui"],
  [/^\/api\/v1\/service-positions\/:id$/, "岗位详情 / 更新 / 删除", "ui"],
  [/^\/api\/v1\/service-positions\/holidays-export$/, "导出岗位节假日", "ui"],
  [/^\/api\/v1\/service-positions\/holidays-import$/, "导入岗位节假日", "ui"],
  [/^\/api\/v1\/service-positions\/jingcai-import$/, "竞才网岗位导入", "ui"],
  [/^\/api\/v1\/service-positions$/, "岗位列表 / 新建（岗位页在用）", "ui"],

  // ── 系统设置 / 调试 ──
  [/^\/api\/v1\/settings\/agent$/, "Agent 相关系统设置", "ui"],
  [/^\/api\/v1\/settings\/sync$/, "向客户端下发设置同步", "ui"],
  [/^\/api\/v1\/settings$/, "系统设置读写", "ui"],
  [/^\/api\/v1\/unknown-questions\/:id\/convert$/, "未答问题转知识条目", "legacy"],
  [/^\/api\/v1\/unknown-questions\/:id\/resolve$/, "标记未答问题已解决", "legacy"],
  [/^\/api\/v1\/unknown-questions\/:id$/, "未答问题详情 / 更新 / 删除", "legacy"],
  [/^\/api\/v1\/unknown-questions$/, "未答问题池（菜单已隐藏）", "legacy"],
  [/^\/api\/v1\/upload\/image$/, "上传图片", "ui"],
  [/^\/api\/v1\/upload\/video$/, "上传视频", "ui"],
  [/^\/api\/v1\/webhooks\/dify$/, "Dify 回调（旧链路遗留）", "legacy"],
];

const GROUP_OF = {
  activation: "激活策略（旧链路）",
  "agent/cities": "旧链路遗留接口",
  "agent/jobs": "旧链路遗留接口",
  "agent/device-scripts": "设备与桥接",
  "agent/devices": "设备与桥接",
  "agent/device": "设备与桥接",
  "agent/evaluations": "评估与提醒（旧链路）",
  "agent/evaluation": "评估与提醒（旧链路）",
  "agent/followup": "评估与提醒（旧链路）",
  "agent/reminder": "评估与提醒（旧链路）",
  "agent/report": "评估与提醒（旧链路）",
  "agent/rules": "评估与提醒（旧链路）",
  "agent/invite-group": "评估与提醒（旧链路）",
  "agent/unknown-questions": "知识库配置",
  "agent/conversations": "消息与会话",
  "agent/messages": "消息与会话",
  "agent/manual-reply": "消息与会话",
  "agent/takeover": "消息与会话",
  "agent/stream": "消息与会话",
  "agent/status": "消息与会话",
  "agent/old-friends": "老友与候选人（旧链路）",
  "agent/candidates": "老友与候选人（旧链路）",
  "agent/profile": "老友与候选人（旧链路）",
  auth: "账号与用户",
  bridge: "设备与桥接",
  channels: "企微客服通道（未启用）",
  cities: "城市与工厂",
  factories: "城市与工厂",
  "city-links": "城市与工厂",
  "holiday-schedules": "城市与工厂",
  employers: "招工方与区域",
  locations: "招工方与区域",
  verticals: "招工方与区域",
  recruiters: "招工方与区域",
  "recruiter-featured": "招工方与区域",
  "kb-": "知识库配置",
  knowledge: "知识库配置",
  "unknown-questions": "知识库配置",
  "flow-": "旧流程节点图",
  "import-export": "导入导出",
  "service-positions": "岗位管理",
  settings: "系统设置与调试",
  "flow-edges": "旧流程节点图",
  "flow-nodes": "旧流程节点图",
  upload: "素材与上传",
  webhooks: "系统设置与调试",
  "admin/": "系统设置与调试",
};

const STATUS_LABEL = {
  active: "新链路在用",
  ui: "后台页面在用",
  bridge: "客户端在用",
  legacy: "旧链路遗留·未接线",
};

function classify(method, url) {
  for (const [pattern, purpose, status] of RULES) {
    if (pattern.test(url)) return { purpose, status };
  }
  return null;
}

function groupOf(url) {
  if (url.startsWith("/api/v1/activation")) return GROUP_OF.activation;
  const rest = url.slice("/api/v1/".length);
  for (const [prefix, group] of Object.entries(GROUP_OF)) {
    if (prefix.endsWith("/")) {
      if (rest.startsWith(prefix.slice(0, -1) + "/")) return group;
    } else if (rest === prefix || rest.startsWith(prefix + "/") || (prefix.endsWith("-") ? rest.startsWith(prefix) : rest.startsWith(prefix + "-"))) {
      return group;
    }
  }
  return null;
}

const notes = [];
const unmatched = [];
for (const route of routes) {
  const hit = classify(route.method, route.url);
  const group = groupOf(route.url);
  if (!hit || !group) {
    unmatched.push(route);
    continue;
  }
  notes.push({
    method: route.method,
    url: route.url,
    group,
    purpose: (hit.status === "legacy" ? "【旧链路·未接线】" : "") + hit.purpose,
    status: STATUS_LABEL[hit.status],
  });
}

console.log("已分类", notes.length, "条；未匹配", unmatched.length, "条");
if (unmatched.length) console.log(unmatched.map((r) => r.method + " " + r.url).join("\n"));

const banner = `/**
 * 全量路由说明（2026-11-17 由 过程文件/gen-route-notes.mjs 生成，可手改）。
 *
 * 覆盖 4222 全部 ${notes.length} 条业务路由的「一句话功能 + 在用状态」：
 * - /dev 目录接口把没进人工详细目录（api-catalog.ts）的路由按本文件归类；
 * - status: 新链路在用 / 后台页面在用 / 客户端在用 / 旧链路遗留·未接线。
 * 旧链路条目保留说明是为了让人看懂「这个接口曾经干什么、为什么现在没接」，
 * 全部下线后整组删除即可。
 */

export type RouteNote = {
  method: string;
  url: string;
  group: string;
  purpose: string;
  status: string;
};

export const ROUTE_NOTES: RouteNote[] = [
`;

const body = notes
  .map((n) => `  { method: "${n.method}", url: "${n.url}", group: "${n.group}", purpose: "${n.purpose}", status: "${n.status}" },`)
  .join("\n");

fs.writeFileSync("src/modules/agent/route-notes.ts", banner + body + "\n];\n", "utf-8");
console.log("已生成 src/modules/agent/route-notes.ts");

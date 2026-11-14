import type { DatabaseSync } from "node:sqlite";

type Json = Record<string, unknown>;
export interface KbIssue { code: string; detail: string }
export class KbInputError extends Error {}

// 与 Python kb_policy 的招聘政策约束一致；跨语言用例见 tests/fixtures/kb-policy.json。
const POLICY_WORDS = [
  "工价", "工资", "薪资", "月薪", "时薪", "日薪", "底薪", "待遇", "多少钱", "工钱",
  "体检", "查体", "健康证", "报销", "收费", "费用", "免费", "交钱", "花钱", "押金", "中介费",
  "纹身", "刺青", "花臂", "案底", "犯罪记录", "前科", "录用", "入职条件",
  "转正", "试用期", "正式工", "借支", "预支", "补贴", "返费", "扣钱", "扣款",
  "社保", "五险", "保险", "一金", "包吃", "包住", "吃住", "宿舍", "住宿", "伙食", "管饭",
  "班次", "白班", "夜班", "倒班", "加班", "月休", "休息几天", "工作内容", "干什么活",
  "年龄", "岁数", "几岁", "身高", "民族", "户籍", "招工要求", "招聘要求",
];
const LABELS = [
  "这边工价是", "工价是", "工资待遇", "工资", "工价", "薪资", "待遇",
  "体检要求", "体检安排", "纹身要求", "转正规则", "社保说明", "借支规则",
  "住宿条件", "吃住条件", "年龄要求", "班次安排", "工作内容", "身高要求",
  "民族要求", "月休安排", "线路安排", "证件要求", "搬迁安排",
];
export const FACT_FIELDS = [
  "wage", "wage_text", "welfare", "welfare_text", "shift", "hours_text", "work", "work_text",
  "dorm", "dorm_text", "age", "age_text", "insurance", "insurance_text", "regular", "regular_text",
  "advance", "advance_text", "medical", "medical_text", "tattoo_policy", "relocate_policy",
  "rest", "rest_text", "height", "height_text", "line", "line_text", "ethnicity", "ethnicity_policy", "cert", "cert_text",
];
const RENDER_FIELDS = new Set([...FACT_FIELDS, "employer", "address", "walk_guide", "interview_time"]);
const fieldsIn = (answer: string) => [...answer.matchAll(/\{([^{}\n|]{1,40})(?:\|([^{}\n]{1,200}))?\}/g)];

export function sharedAnswerAllowed(question: string, answer: string, keywords: string[] = [], media: string[] = [], factFields = FACT_FIELDS): boolean {
  const fields = new Set(factFields);
  const matches = fieldsIn(answer);
  const text = [question, ...keywords, answer].join("\n");
  const sensitive = POLICY_WORDS.some(word => text.includes(word)) || /(?:\d+(?:\.\d+)?\s*(?:元|块|\/\s*(?:小时|天|月|班)))|[￥¥]/.test(text)
    || matches.some(match => fields.has(match[1]));
  if (!sensitive) return true;
  if (!matches.length || media.length || answer.includes("【")) return false;
  if (matches.some(match => !fields.has(match[1]) || match[2] !== undefined)) return false;
  let prose = answer.replace(/\{([^{}\n|]{1,40})(?:\|([^{}\n]{1,200}))?\}/g, "");
  for (const label of LABELS) prose = prose.split(label).join("");
  return !prose.replace(/[\s，,。.;；:：!！?？、]+/g, "");
}

export function listOf(value: unknown): string[] {
  if (typeof value === "string") {
    try { return listOf(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value.map(String) : [];
}

export function sharedFaqIssues(row: Json): KbIssue[] {
  if (["employer", "position"].includes(String(row.scope_level))) return [];
  const question = String(row.question ?? "");
  const answer = String(row.answer ?? "");
  if (!sharedAnswerAllowed(question, answer, listOf(row.keywords), listOf(row.media))) {
    return [{ code: "shared_policy", detail: "共享问答不能写固定工资、厂规、默认承诺或附带厂规媒体；请引用本岗字段（如{wage}），或绑定到明确的招工方/岗位。" }];
  }
  const matches = fieldsIn(answer);
  if (matches.some(match => !RENDER_FIELDS.has(match[1]) || match[2] !== undefined)
    || /[{}]/.test(answer.replace(/\{([^{}\n|]{1,40})(?:\|([^{}\n]{1,200}))?\}/g, ""))) {
    return [{ code: "shared_placeholder", detail: "共享模板含未知占位符、默认兜底或不完整花括号；请使用受支持的岗位字段。" }];
  }
  return [];
}

function optionalId(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if ((typeof value !== "number" && typeof value !== "string") || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new KbInputError(`${name} 必须是有效的正整数编号`);
  }
  return Number(value);
}

export function normalizeFaq(body: Json, current: Json = {}): Json {
  const value = { ...current, ...body };
  for (const name of ["question", "answer"]) {
    if (typeof value[name] !== "string" || !String(value[name]).trim()) throw new KbInputError(`${name} is required`);
  }
  for (const name of ["keywords", "media"]) {
    if (body[name] !== undefined && (!Array.isArray(body[name]) || !(body[name] as unknown[]).every(item => typeof item === "string"))) {
      throw new KbInputError(`${name} 必须是文本数组`);
    }
  }
  const scope = String(value.scope_level ?? "global");
  if (!["global", "vertical", "city", "employer", "position"].includes(scope)) throw new KbInputError("scope_level 只能是 global/vertical/city/employer/position");
  const status = String(value.status ?? "enabled");
  if (!["enabled", "disabled"].includes(status)) throw new KbInputError("status 只能是 enabled/disabled");
  const result: Json = {
    ...value, question: String(value.question).trim(), answer: String(value.answer).trim(), scope_level: scope, status,
    vertical_id: optionalId(value.vertical_id, "vertical_id"),
    keywords: listOf(value.keywords), media: listOf(value.media),
    scope_employer_id: scope === "employer" ? optionalId(value.scope_employer_id, "scope_employer_id") : null,
    scope_location_id: scope === "city" ? optionalId(value.scope_location_id, "scope_location_id") : null,
    scope_position_id: scope === "position" ? optionalId(value.scope_position_id, "scope_position_id") : null,
  };
  const required = { vertical: "vertical_id", city: "scope_location_id", employer: "scope_employer_id", position: "scope_position_id" }[scope];
  if (required && !result[required]) throw new KbInputError(`${scope} 级问答必须指定 ${required}`);
  return result;
}

export function faqIssues(db: DatabaseSync, row: Json): KbIssue[] {
  const issues = sharedFaqIssues(row);
  const active = row.status === "enabled";
  const vertical = row.vertical_id ? db.prepare("SELECT id,status FROM vertical WHERE tenant_id=1 AND id=?").get(Number(row.vertical_id)) : undefined;
  if (row.vertical_id && (!vertical || vertical.status === "deleted" || (active && vertical.status !== "enabled"))) {
    issues.push({ code: "vertical", detail: "限定品类不存在或未启用。" });
  }
  const scope = String(row.scope_level);
  if (!["global", "vertical", "city", "employer", "position"].includes(scope)) issues.push({ code: "scope", detail: "作用域无效，请重新指定。" });
  if (scope === "vertical" && !row.vertical_id) issues.push({ code: "scope", detail: "品类级问答必须指定品类。" });
  const targets = { employer: ["employer", "scope_employer_id"], city: ["location", "scope_location_id"], position: ["service_positions", "scope_position_id"] } as const;
  const target = targets[scope as keyof typeof targets];
  if (target) {
    const [table, key] = target;
    const found = row[key] ? db.prepare(`SELECT * FROM ${table} WHERE id=?${table === "employer" ? " AND tenant_id=1" : ""}`).get(Number(row[key])) : undefined;
    if (!found || found.status === "deleted" || (active && found.status !== "enabled")) issues.push({ code: "scope_target", detail: "作用域关联的招工方、城市或岗位不存在或未启用。" });
    else if (scope === "employer" && row.vertical_id && Number(found.vertical_id) !== Number(row.vertical_id)) issues.push({ code: "scope_vertical", detail: "限定品类与招工方的品类不一致。" });
  }
  return issues;
}

export function assertFaqWritable(db: DatabaseSync, row: Json): void {
  // 停用旧条目可保留待核对原文；再次启用时重新检查整条配置。
  const issues = faqIssues(db, row).filter(issue => row.status === "enabled" || !issue.code.startsWith("shared_"));
  if (issues.length) throw new KbInputError(issues.map(issue => issue.detail).join(" "));
}

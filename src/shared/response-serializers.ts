type Row = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

const CITY_FIELDS = [
  "city_name", "province", "interview_site_name", "social_insurances", "districts", "knowledge_vertical_id",
  "recruitment_status", "flow_type", "ask_accommodation", "is_primary",
  "gender_accommodation_policy", "factory_mode", "salary", "interview", "available_lines",
  "work_hours", "requirements", "prompt_sections", "prompt_section_labels", "sort_order",
] as const;

const FACTORY_FIELDS = ["factory_name", "city_id", "address", "contact", "salary", "is_active"] as const;

const CITY_DEFAULTS: Record<string, unknown> = {
  city_name: "", province: "", interview_site_name: "", social_insurances: "", districts: [],
  recruitment_status: "active", flow_type: "standard", ask_accommodation: true, is_primary: false,
  gender_accommodation_policy: "none", factory_mode: "none",
  salary: { probation: {}, formal: {}, benefits: {}, document_url: "", raw: "" },
  interview: { days: [], time: "", location: "", coordinates: "", check_in_code: "", contact: "", room: "", guide_image: "", raw_time: "", raw_address: "", interview_notice: "", interview_guide: "" },
  available_lines: [], work_hours: { raw: "" }, requirements: { raw: "" }, prompt_sections: {}, prompt_section_labels: {}, sort_order: 0,
};

const POSITION_KEYS = [
  "id", "position_name", "factory_id", "gender", "age_range", "height_require", "city_name", "district",
  "address", "coordinates", "interview_time", "image_url", "contact_phone", "store_name",
  "store_address", "store_coordinates", "job_type", "accommodation", "health_cert",
  "experience", "interview_days", "interview_points", "recruiter_id", "base_sections",
  "base_section_labels", "is_active", "is_featured", "sort_order", "created_at", "updated_at",
] as const;

const POSITION_DEFAULTS: Record<string, unknown> = {
  factory_id: null,
  gender: "", age_range: "", height_require: "", city_name: "", district: "", address: "",
  coordinates: "", interview_time: "", image_url: "", contact_phone: "", store_name: "",
  store_address: "", store_coordinates: "", job_type: "", accommodation: "", health_cert: "",
  experience: "", interview_days: [], interview_points: [], recruiter_id: "", base_sections: {},
  base_section_labels: {
    positions: "招聘工种", requirements: "招聘要求", salary_detail: "薪资详情", salary_ask: "薪资简述",
    work_content: "工作内容", meal_dorm: "吃住情况", social_insurance: "社保情况", shift_info: "班次问题",
    work_hours: "工作时间", factory_env: "工厂环境", dorm_env: "宿舍环境", work_env: "工作环境",
    uniform: "工衣问题", medical_fee: "体检费问题", luggage_question: "行李问题",
    interview_notice: "面试通知模板", checkin_guide: "面试指引", registration_form: "报名表单",
  },
  is_active: true, is_featured: false, sort_order: 0,
};

const CANDIDATE_KEYS = [
  "id", "device_code", "customer_id", "nickname", "wechat_id", "event_type", "event_at", "name",
  "phone", "interview_date", "interview_time", "factory_name", "province", "city", "district", "status",
  "remind_count", "disqualified_reason", "created_at", "registration_text",
  // 归属账号：设备登录的企微账号，由候选人查询 join 出来（不在 candidate_events 表里）。
  "account",
] as const;

const DEVICE_KEYS = [
  // dify_url / dify_key 已随 Dify 全链路下线（2026-11-17），不再返回。
  "id", "device_code", "name", "recruiter_id", "factory_name", "city", "status", "online", "mode",
  "config", "last_online", "created_at", "last_offline", "queue_depth", "queue_stale",
  // 群聊绑定（2026-11-18 面试登记页）：登记完成自动推送的目标群聊，
  // 不透出则前端刷新后回显丢失，运营会以为没保存。
  "group_chat", "position_id", "reply_provider",
] as const;

const DISTRIBUTION_STATES = [
  "active", "disqualified", "followup_invite", "timeout_1", "timeout_2", "timeout_3", "waiting",
] as const;

function parseData(value: unknown): JsonObject {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function merged(row: Row): Row {
  const { data_json: _data, ...columns } = row;
  return { ...columns, ...parseData(row.data_json) };
}

function project(source: Row, keys: readonly string[]) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

export function serializeCity(row: Row): Row {
  const source = merged(row);
  const result = project(source, ["id", ...CITY_FIELDS, "created_at", "updated_at"]);
  // The core routes recompute this column from the current device and position bindings.
  if (typeof row.recruitment_status === "string") result.recruitment_status = row.recruitment_status;
  for (const [key, fallback] of Object.entries(CITY_DEFAULTS)) {
    if (result[key] === undefined || result[key] === null) result[key] = structuredClone(fallback);
  }
  result.districts = Array.isArray(result.districts) ? result.districts : [];
  result.available_lines = Array.isArray(result.available_lines) ? result.available_lines : [];
  return result;
}

export function serializeFactory(row: Row): Row {
  const source = merged(row);
  const result = project(source, ["id", ...FACTORY_FIELDS, "created_at", "updated_at"]);
  result.is_active = typeof source.is_active === "boolean" ? source.is_active : source.status === "enabled";
  return result;
}

export function serializeServicePosition(row: Row): Row {
  const source = merged(row);
  const result: Row = {};

  // 事实卡取值助手：事实卡是 data_json 里的中文键值（见 seed-shenzhen 脚本）。
  const fact = (key: string) => String(source[key] ?? "").trim();

  for (const key of POSITION_KEYS) {
    const value = source[key] ?? (key === "is_featured" && source.featured !== undefined ? source.featured : undefined);
    if (value !== undefined && value !== null) result[key] = value;
    else if (key in POSITION_DEFAULTS) result[key] = structuredClone(POSITION_DEFAULTS[key]);
    else result[key] = value ?? "";
  }
  result.is_active = typeof row.status === "string" ? row.status === "enabled" : Boolean(result.is_active);
  result.is_featured = Boolean(result.is_featured);
  result.sort_order = Number(result.sort_order) || 0;
  result.interview_days = Array.isArray(result.interview_days) ? result.interview_days : [];
  result.interview_points = Array.isArray(result.interview_points) ? result.interview_points : [];
  if (typeof row.city_id === "number") result.city_id = row.city_id;
  if (typeof source.work_address === "string") {
    result.work_address = source.work_address;
    result.interview_address = fact("interview_address");
    if (typeof source.work_coordinates === "string" && source.work_coordinates.trim()) {
      result.work_coordinates = source.work_coordinates.trim();
    }
  }
  const sections = result.base_sections && typeof result.base_sections === "object" ? result.base_sections as Row : {};
  // 网页允许新增语义字段；读回时保留它们，否则保存后再次编辑就会丢失。
  const sectionKeys = [...new Set([...Object.keys(POSITION_DEFAULTS.base_section_labels as Row), ...Object.keys(sections)])];
  result.base_sections = Object.fromEntries(sectionKeys.map((key) => [key, String(sections[key] ?? "")]));
  result.base_section_labels = result.base_section_labels && typeof result.base_section_labels === "object" ? result.base_section_labels : {};
  // 新链路的事实卡（data_json）是唯一事实源；编译版列表页读的是旧列，
  // 旧列没填时从事实卡推导展示值，保证前端展示与 Agent 实际引用的数据一致。
  // 运营在 Agent 配置里改事实卡，列表页下一轮刷新就跟着变。
  if (fact("job_title") || fact("wage_text")) {
    if (!result.city_name && fact("city")) result.city_name = fact("city");
    if (!result.age_range && fact("age_text")) result.age_range = fact("age_text");
    if (!result.height_require && fact("height_text")) result.height_require = fact("height_text");
    if (!result.accommodation && fact("welfare_text")) result.accommodation = fact("welfare_text");
    if (!result.address && fact("place")) result.address = fact("place");
    if (!result.interview_time && fact("interview_time")) result.interview_time = fact("interview_time");
    if (!result.gender) {
      const age = fact("age_text");
      result.gender = /男/.test(age) && /女/.test(age) ? "男女不限" : "不限";
    }
    if (!result.job_type) result.job_type = "全职";
  }
  return result;
}

export function serializeRecruiter(row: Row, cities: Row[] = []): Row {
  const source = merged(row);
  const relatedCities = cities.length ? cities : Array.isArray(source.cities) ? source.cities as Row[] : [];
  const publicCities = relatedCities.map((city) => ({
    id: city.id ?? city.city_id,
    city_name: String(city.city_name ?? ""),
    is_enabled: Boolean(city.is_enabled),
    recruiter_id: String(city.recruiter_id ?? source.recruiter_id ?? source.username ?? ""),
    sort_order: Number(city.sort_order ?? 0),
  }));
  return {
    id: source.id,
    recruiter_id: String(source.recruiter_id ?? source.username ?? ""),
    name: String(source.name ?? source.recruiter_name ?? source.username ?? ""),
    description: String(source.description ?? ""),
    recruiter_type: String(source.recruiter_type ?? "service"),
    is_active: typeof source.is_active === "boolean" ? source.is_active : source.status === "enabled",
    sort_order: Number(source.sort_order ?? 0),
    llm_config: source.llm_config && typeof source.llm_config === "object" ? source.llm_config : {},
    city_count: publicCities.length,
    cities: publicCities,
    password_set: Boolean(source.password_set),
    updated_at: source.updated_at,
  };
}

export function serializeCandidate(row: Row): Row {
  const source = merged(row);
  const result = project(source, CANDIDATE_KEYS);
  result.wechat_id = String(source.wechat_id ?? "");
  result.customer_id = String(source.customer_id ?? "");
  result.device_code = String(source.device_code ?? "");
  result.remind_count = Number(source.remind_count ?? 0);
  return result;
}

const DEFAULT_EVENT_RULES = [
  { event: "disqualified", description: "不符合条件", keywords: ["后续再聊 ", "暂时安排不了"], match_mode: "any", action: "mark_disqualified", once_per_session: true },
  { event: "invited", description: "邀约成功", keywords: ["报名成功", "面试日期"], match_mode: "any", action: "mark_invited", once_per_session: true },
  // checked_in 不在默认规则里，理由见 shared/event-rules.ts：签到不能靠
  // 「我们发出去的话」推断——面试通知里就带「请准时到本公司面试」，
  // 一发通知客户就被标成已签到（2026-11-15 实测）。签到走人工标记接口。
  { event: "pending_invite", description: "待邀约", keywords: ["到时候联系", "再联系我", "有需要联系我就行"], match_mode: "any", action: "mark_pending_invite", once_per_session: true },
];
const EMPTY_TIMEOUT = { enabled: false, interval_seconds: 300, max_count: 3, scripts: [] as string[] };
const EMPTY_REMINDER = { enabled: false, rules: [{ type: "fixed_time", time: "21:00", script: "早点休息哈 明天到了联系我 " }] };
const EMPTY_QUIET_HOURS = { enabled: false, start: "23:00", end: "08:00" };

function serializeTimeout(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
  return {
    enabled: Boolean(source.enabled),
    interval_seconds: Number(source.interval_seconds ?? EMPTY_TIMEOUT.interval_seconds),
    max_count: Number(source.max_count ?? EMPTY_TIMEOUT.max_count),
    scripts: Array.isArray(source.scripts) ? source.scripts : EMPTY_TIMEOUT.scripts,
  };
}

export function serializeAgentDevice(row: Row): Row {
  const source = merged(row);
  const rawConfig = source.config && typeof source.config === "object" ? source.config as Row : {};
  const result: Row = {
    id: source.id,
    device_code: String(source.device_code ?? ""),
    name: String(source.name ?? source.device_name ?? ""),
    recruiter_id: String(source.recruiter_id ?? ""),
    // 设备绑定的工厂/城市（data_json 透传，供 admin 设备列表展示；空串 = 通用）
    factory_name: String(source.factory_name ?? ""),
    city: String(source.city ?? ""),
    // 知识库 v3 绑定：品类 / 招工方 / 位置 / 岗位。0 = 未绑定（走通配）。
    // 配置台「设备」页签要读回来回显下拉，缺这几个字段就只能盲改。
    vertical_id: Number(source.vertical_id ?? 0) || 0,
    employer_id: Number(source.employer_id ?? 0) || 0,
    location_id: Number(source.location_id ?? 0) || 0,
    position_id: Number(source.position_id ?? 0) || 0,
    // 群聊通知绑定（面试登记面板回显下拉）：data_json.group_chat，空串 = 未绑定
    group_chat: String(source.group_chat ?? ""),
    status: Boolean(source.online ?? source.status === true),
    online: Boolean(source.online),
    mode: String(source.mode ?? ""),
    reply_provider: source.reply_provider === "dify" ? "dify" : "agent",
    config: {
      merge_delay_seconds: Number(rawConfig.merge_delay_seconds ?? 0),
      merge_requery: Boolean(rawConfig.merge_requery),
      timeout: serializeTimeout(rawConfig.timeout),
      event_rules: Array.isArray(rawConfig.event_rules) ? rawConfig.event_rules : DEFAULT_EVENT_RULES,
      reminder: rawConfig.reminder && typeof rawConfig.reminder === "object" ? rawConfig.reminder : EMPTY_REMINDER,
      quiet_hours: rawConfig.quiet_hours && typeof rawConfig.quiet_hours === "object" ? rawConfig.quiet_hours : EMPTY_QUIET_HOURS,
    },
    last_online: String(source.last_online ?? ""),
    created_at: String(source.created_at ?? ""),
    last_offline: String(source.last_offline ?? ""),
    queue_depth: Number(source.queue_depth ?? 0),
    queue_stale: String(source.queue_stale ?? ""),
  };
  return project(result, DEVICE_KEYS);
}

function recordOfArrays(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, list]) => [key, Array.isArray(list) ? list : []]));
}

export function serializeCityLinks(value: unknown): Row {
  const source = value && typeof value === "object" ? value as Row : {};
  return { districts: recordOfArrays(source.districts), links: recordOfArrays(source.links) };
}

export function serializeEvaluationOverview(value: unknown): Row {
  const source = value && typeof value === "object" ? value as Row : {};
  return { days: Number(source.days ?? 7), items: Array.isArray(source.items) ? source.items : [] };
}

export function serializeMetrics(value: unknown): Row {
  const source = value && typeof value === "object" ? value as Row : {};
  return {
    start_date: String(source.start_date ?? ""),
    end_date: String(source.end_date ?? ""),
    items: Array.isArray(source.items) ? source.items : [],
  };
}

export function serializeAccountSummary(value: unknown): Row {
  const source = value && typeof value === "object" ? value as Row : {};
  const range = source.date_range && typeof source.date_range === "object" ? source.date_range as Row : {};
  const total = source.total && typeof source.total === "object" ? source.total as Row : {};
  const metricKeys = ["checked_in", "device_count", "disqualified", "invite_rate", "invited", "new_conversations", "pending_invite"];
  return {
    prefix: String(source.prefix ?? ""),
    date_range: { start: String(range.start ?? ""), end: String(range.end ?? "") },
    total: Object.fromEntries(metricKeys.map((key) => [key, Number(total[key] ?? 0)])),
    accounts: Array.isArray(source.accounts) ? source.accounts : [],
    daily_trend: Array.isArray(source.daily_trend) ? source.daily_trend : [],
  };
}

export function serializeStatusDashboard(value: unknown): Row {
  const source = value && typeof value === "object" ? value as Row : {};
  const states = source.state_distribution && typeof source.state_distribution === "object" ? source.state_distribution as Row : {};
  const state_distribution = Object.fromEntries(DISTRIBUTION_STATES.map((key) => [key, Number(states[key] ?? 0)]));
  return {
    devices: source.devices && typeof source.devices === "object" ? source.devices : { total: 0, active_today: 0 },
    messages: source.messages && typeof source.messages === "object" ? source.messages : { total: 0, hourly: [] },
    queue: source.queue && typeof source.queue === "object" ? source.queue : { pending: 0 },
    errors: source.errors && typeof source.errors === "object" ? source.errors : { failed_today: 0, ai_abnormal: 0 },
    state_distribution,
    device_ranking: Array.isArray(source.device_ranking) ? source.device_ranking : [],
    dify_health: Array.isArray(source.dify_health) ? source.dify_health : [],
    degraded: Array.isArray(source.degraded) ? source.degraded : [],
    daily_trend: Array.isArray(source.daily_trend) ? source.daily_trend : [],
  };
}

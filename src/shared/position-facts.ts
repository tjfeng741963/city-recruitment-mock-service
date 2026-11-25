type Values = Record<string, unknown>;

const text = (value: unknown): string => String(value ?? "").trim();

export interface InterviewPoint {
  name: string;
  address: string;
  interview_time?: string;
  checkin_guide?: string;
  /** 位置卡坐标：客户问定位时拼高德链接用（从企微位置消息里读出来的真实坐标） */
  lng?: number;
  lat?: number;
}

export function normalizeInterviewPoints(value: unknown): InterviewPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === "string") return item.trim() ? [{name: item.trim(), address: ""}] : [];
    if (!item || typeof item !== "object") return [];
    const point = item as Values;
    const name = typeof point.name === "string" ? point.name.trim() : "";
    const address = typeof point.address === "string" ? point.address.trim() : "";
    const interviewTime = typeof point.interview_time === "string" ? point.interview_time.trim() : "";
    const checkinGuide = typeof point.checkin_guide === "string" ? point.checkin_guide.trim() : "";
    const lng = Number(point.lng);
    const lat = Number(point.lat);
    const hasCoord = Number.isFinite(lng) && Number.isFinite(lat) && lng !== 0 && lat !== 0;
    return name ? [{
      name, address,
      ...(hasCoord && { lng, lat }),
      ...(interviewTime && { interview_time: interviewTime }),
      ...(checkinGuide && { checkin_guide: checkinGuide }),
    }] : [];
  });
}

export function normalizePositionFacts(source: Values): Values {
  const result = { ...source };
  const sections = source.base_sections && typeof source.base_sections === "object"
    ? source.base_sections as Values
    : {};
  const has = (target: Values, key: string) => Object.prototype.hasOwnProperty.call(target, key);
  const setFromForm = (fact: string, field: string, target: Values = source) => {
    if (has(target, field)) result[fact] = text(target[field]);
  };

  if (has(sections, "salary_detail") || has(sections, "salary_ask")) {
    result.wage_text = text(sections.salary_detail) || text(sections.salary_ask);
  }
  if (has(sections, "work_hours") || has(sections, "shift_info")) {
    result.hours_text = text(sections.work_hours) || text(sections.shift_info);
  }
  setFromForm("age_text", "age_range");
  setFromForm("height_text", "height_require");
  if (has(source, "accommodation") || has(sections, "meal_dorm") || has(sections, "social_insurance")) {
    result.welfare_text = [...new Set([source.accommodation, sections.meal_dorm, sections.social_insurance].map(text).filter(Boolean))].join("；");
  }
  if (has(source, "work_address")) {
    result.place = text(source.work_address);
    if (has(source, "interview_address")) result.interview_address = text(source.interview_address);
  } else if (has(source, "address") || has(source, "store_address")) {
    const address = text(source.address) || text(source.store_address);
    result.place = address;
    if (!has(source, "interview_address")) result.interview_address = address;
  }
  setFromForm("interview_time", "interview_time");
  setFromForm("basic_requirements", "requirements", sections);
  setFromForm("job_content", "work_content", sections);
  setFromForm("cert_text", "health_cert");
  if (Object.keys(sections).length) {
    const labels = source.base_section_labels && typeof source.base_section_labels === "object"
      ? source.base_section_labels as Values
      : {};
    const primarySections = new Set([
      "salary_detail", "salary_ask", "work_hours", "shift_info", "requirements", "work_content",
      "meal_dorm", "social_insurance",
    ]);
    result.additional_info = Object.entries(sections)
      .filter(([key, value]) => !primarySections.has(key) && text(value))
      .map(([key, value]) => `${text(labels[key]) || key}：${text(value)}`)
      .join("\n");
  }
  return result;
}

export function applyCityDefaultsToPosition(city: Values, body: Values): Values {
  const result = { ...body };
  const sections = body.base_sections && typeof body.base_sections === "object"
    ? { ...(body.base_sections as Values) }
    : {};
  const salary = city.salary && typeof city.salary === "object" ? city.salary as Values : {};
  const hours = city.work_hours && typeof city.work_hours === "object" ? city.work_hours as Values : {};
  const requirements = city.requirements && typeof city.requirements === "object" ? city.requirements as Values : {};
  const interview = city.interview && typeof city.interview === "object" ? city.interview as Values : {};
  const fill = (target: Values, key: string, value: unknown) => {
    if (!text(target[key]) && text(value)) target[key] = text(value);
  };

  fill(sections, "salary_detail", salary.raw);
  fill(sections, "work_hours", hours.raw);
  fill(sections, "requirements", requirements.raw);
  fill(sections, "social_insurance", city.social_insurances);
  result.base_sections = sections;
  fill(result, "wage_text", sections.salary_detail || sections.salary_ask);
  fill(result, "hours_text", sections.work_hours || sections.shift_info);
  fill(result, "basic_requirements", sections.requirements);
  fill(result, "interview_time", interview.time || interview.raw_time);
  const defaultAddress = interview.location || interview.raw_address || city.interview_site_name;
  if (Object.prototype.hasOwnProperty.call(body, "work_address")) {
    if (!normalizeInterviewPoints(body.interview_points).length) fill(result, "interview_address", defaultAddress);
    result.address = text(result.interview_address) || text(result.work_address);
  } else {
    fill(result, "address", defaultAddress);
  }
  return result;
}

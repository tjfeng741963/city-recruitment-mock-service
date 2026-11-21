import { normalizeInterviewPoints, normalizePositionFacts } from "../../shared/position-facts.js";
import type { DatabaseSync } from "node:sqlite";
import { parseDeviceData } from "../../shared/device-factories.js";

const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
const readText = (value: unknown) => typeof value === "string" ? value.trim() : "";
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function weekdays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => {
    const name = readText(item).replace(/^(星期|周)/, "").replace(/[天七]/, "日");
    return dayNames.indexOf(name);
  }).filter(index => index >= 0))];
}

function time(value: string) {
  const match = /^(\d{1,2})[:：](\d\d)$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function windows(value: string):{start:string;end:string}[] {
  // Only expose unambiguous configured slots or a single ordinary time range.
  if (/周|星期|仅|除外|休息|另约|待定|具体|以通知|电话|后|前|工作日/.test(value)) return [];
  const sections = value.split(/[，,；;、]/).map(section => section.trim()).filter(Boolean);
  if (sections.length > 1) {
    const parsed = sections.map(windows);
    return parsed.every(section => section.length === 1) ? parsed.flat() : [];
  }
  const matches = [...value.matchAll(/(?<!\d)\d{1,2}[:：]\d\d(?!\d)/g)].map(m => m[0]);
  if (matches.length === 1 && /^(?:(?:每天|每日)\s*)?(?:上午|下午|晚上)?\s*\d{1,2}[:：]\d\d\s*$/.test(value)) {
    const slot = time(matches[0]);
    if (!slot || (/下午|晚上/.test(value) && slot < "12:00")) return [];
    return [{ start: slot, end: slot }];
  }
  if (matches.length !== 2 || !/^(?:(?:每天|每日)\s*)?(?:上午|下午|晚上)?\s*\d{1,2}[:：]\d\d\s*(?:-|–|—|~|～|至|到)\s*\d{1,2}[:：]\d\d\s*$/.test(value)) return [];
  const [start, end] = matches.map(time);
  if (!start || !end || start >= end || (/下午|晚上/.test(value) && start < "12:00")) return [];
  return [{ start, end }];
}

export function interviewSchedule(db: DatabaseSync, positionId: number, facts: { interview_time?: unknown; interview_address?: unknown }) {
  const row = db.prepare(`SELECT p.data_json, c.data_json city_json, c.id city_id
    FROM service_positions p LEFT JOIN factories f ON f.id=p.factory_id
    LEFT JOIN cities c ON c.id=COALESCE(p.city_id,f.city_id) WHERE p.id=?`).get(positionId) as
    { data_json: string; city_json: string | null; city_id: number | null } | undefined;
  const position = parseDeviceData(row?.data_json);
  const city = parseDeviceData(row?.city_json);
  const days = weekdays(record(city.interview).days);
  const rawTime = readText(facts.interview_time);
  const rule = /^(?:[^：:]{1,30}[：:]\s*)?(?:周|星期)([一二三四五六日天])\s*(?:至|到|[-–—])\s*(?:周|星期)?([一二三四五六日天])(?:\s*[（(](?:可安排住宿)[）)])?\s*(.+)$/.exec(rawTime);
  const byText = /^(?:每天|每日)/.test(rawTime) ? [1,2,3,4,5,6,0] : [];
  if (rule) {
    const [first,last]=weekdays([rule[1],rule[2]]);
    if (first!==undefined&&last!==undefined) {
      for(let offset=0;offset<7;offset++){
        const day=(first+offset)%7;
        byText.push(day);
        if(day===last)break;
      }
    }
  }
  const explicitDays = days.length ? days : weekdays(position.interview_days);
  const configuredDays = explicitDays.length && byText.length ? explicitDays.filter(day=>byText.includes(day))
    : explicitDays.length ? explicitDays : byText;
  const points = normalizeInterviewPoints(position.interview_points);
  const cityInterview = record(city.interview);
  const address = readText(cityInterview.location) || readText(cityInterview.raw_address) || readText(facts.interview_address) || readText(normalizePositionFacts(position).interview_address);
  const uniquePoints = points.filter((point, index) => points.findIndex(p => p.name === point.name) === index);
  if (uniquePoints.length === 1 && !uniquePoints[0].address) uniquePoints[0].address = address;
  if (!uniquePoints.length && address) uniquePoints.push({ name: address, address });
  return {
    days: configuredDays,
    dayLabels: configuredDays.map(day => `周${dayNames[day]}`),
    points: uniquePoints,
    slots: windows(rule?.[3] ?? rawTime),
    timeText: rawTime,
    cityId: row?.city_id ?? null,
  };
}

export function interviewDate(value: string, now = new Date()) {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(now);
  const start = Date.parse(`${today}T00:00:00Z`);
  let date = value.normalize("NFKC").trim();
  const relative = ["今天", "明天", "后天"].indexOf(date);
  if (relative >= 0) date = new Date(start + relative * 86400000).toISOString().slice(0, 10);
  const chinese = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]$/.exec(date);
  if (chinese) date = `${chinese[1] || today.slice(0, 4)}-${chinese[2].padStart(2,"0")}-${chinese[3].padStart(2,"0")}`;
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) return "";
  const stamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === date
    && stamp >= start && stamp <= start+30*86400000 ? date : "";
}

export function validateInterview(db: DatabaseSync, positionId: number, schedule: ReturnType<typeof interviewSchedule>,
  date: string, slot: string, pointName: string, now = new Date()) {
  const point = schedule.points.find(item => item.name === pointName);
  // Multiple named locations without addresses/hours need staff confirmation.
  if (!schedule.days.length || !schedule.slots.length || !point?.address) return { error: "该岗位的面试安排需要招聘员确认，请先联系招聘员。" };
  const validDate = interviewDate(date, now);
  const validTime = time(slot);
  if (!validDate || !validTime || Date.parse(`${validDate}T${validTime}:00+08:00`) <= now.getTime()) return { error: "请选择未来的面试日期和时间。" };
  const weekday = new Date(`${validDate}T00:00:00Z`).getUTCDay();
  if (!schedule.days.includes(weekday)) return { error: "该日期不在已配置的面试星期内，请另选一天。" };
  if (!schedule.slots.some(window => validTime >= window.start && validTime <= window.end)) return { error: "该时间不在可面试时段内，请另选时间。" };
  const closed = db.prepare(`SELECT 1 FROM service_position_holidays WHERE position_id=? AND holiday_date=? AND is_active=1
    UNION ALL SELECT 1 FROM holiday_schedules WHERE city_id=? AND date=? AND kind='holiday' LIMIT 1`)
    .get(positionId, validDate, schedule.cityId, validDate);
  if (closed) return { error: "该日期已设置为休息日，请另选一天。" };
  return { date:validDate, time:validTime, point } as const;
}

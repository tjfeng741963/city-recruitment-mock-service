import type { City } from "../../api/client";
import type { Holiday, Position } from "../../api/admin";

export const ACTIVE_CITY_STATUSES = ["enabled", "active"];

export function isCityActive(city: City): boolean {
  return ACTIVE_CITY_STATUSES.includes(city.recruitment_status);
}

export function localDate(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function activeHolidays(holidays: Holiday[]): Holiday[] {
  return holidays.filter((h) => h.is_active !== 0 && /^\d{4}-\d{2}-\d{2}$/.test(h.holiday_date));
}

export function isOnHoliday(holidays: Holiday[], today: string): boolean {
  return activeHolidays(holidays).some((h) => h.holiday_date === today);
}

export function upcomingHolidays(holidays: Holiday[], today: string): Holiday[] {
  return activeHolidays(holidays)
    .filter((h) => h.holiday_date >= today)
    .sort((a, b) => a.holiday_date.localeCompare(b.holiday_date));
}

export const UNGROUPED = "未填工厂";

export function groupByStore(positions: Position[]): Array<{ store: string; items: Position[] }> {
  const groups = new Map<string, Position[]>();
  for (const p of positions) {
    const store = p.store_name.trim() || UNGROUPED;
    groups.set(store, [...(groups.get(store) ?? []), p]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b, "zh")))
    .map(([store, items]) => ({ store, items: [...items].sort((x, y) => Number(y.is_active) - Number(x.is_active)) }));
}

// PUT replaces the stored position wholesale, so the full object goes back. is_featured is left out:
// a stored is_featured would shadow the featured column that toggle-featured flips.
export function positionPayload(position: Position, patch: Partial<Position>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...position, ...patch };
  const { id: _id, is_featured: _featured, created_at: _created, updated_at: _updated, ...rest } = merged;
  return rest;
}

export const EDITABLE_SECTIONS = ["salary_ask", "salary_detail", "requirements", "shift_info", "work_hours", "meal_dorm", "social_insurance"] as const;

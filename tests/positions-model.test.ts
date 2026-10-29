import { describe, expect, it } from "vitest";
import type { Holiday, Position } from "../frontend/src/api/admin";
import { groupByStore, isOnHoliday, localDate, positionPayload, upcomingHolidays, UNGROUPED } from "../frontend/src/pages/positions/model";

function position(id: number, overrides: Partial<Position> = {}): Position {
  return {
    id, position_name: `p${id}`, city_name: "苏州", district: "", gender: "", age_range: "", job_type: "", accommodation: "",
    contact_phone: "", store_name: "", interview_time: "", is_active: true, is_featured: false,
    base_sections: {}, base_section_labels: {}, ...overrides,
  };
}

const holiday = (id: number, date: string, is_active = 1): Holiday => ({ id, position_id: 1, holiday_date: date, label: "", is_active });

describe("holidays", () => {
  it("marks a position on holiday only for an active holiday today", () => {
    expect(isOnHoliday([holiday(1, "2026-10-28")], "2026-10-28")).toBe(true);
    expect(isOnHoliday([holiday(1, "2026-10-28", 0)], "2026-10-28")).toBe(false);
    expect(isOnHoliday([holiday(1, "2026-10-29")], "2026-10-28")).toBe(false);
  });

  it("lists upcoming holidays in date order and drops past or malformed dates", () => {
    const list = [holiday(1, "2026-11-02"), holiday(2, "2026-10-01"), holiday(3, "2026-10-28"), holiday(4, "")];
    expect(upcomingHolidays(list, "2026-10-28").map((h) => h.id)).toEqual([3, 1]);
  });

  it("formats the local calendar date", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 30).getTime())).toBe("2026-01-05");
  });
});

describe("groupByStore", () => {
  it("groups by store name, puts the unnamed group last and active positions first", () => {
    const groups = groupByStore([
      position(1, { store_name: "" }),
      position(2, { store_name: "富士康", is_active: false }),
      position(3, { store_name: "富士康" }),
      position(4, { store_name: "比亚迪" }),
    ]);
    expect(groups.map((g) => g.store)).toEqual(["比亚迪", "富士康", UNGROUPED]);
    expect(groups[1].items.map((p) => p.id)).toEqual([3, 2]);
  });
});

describe("positionPayload", () => {
  it("sends the whole position with the patch applied but never is_featured or ids", () => {
    const payload = positionPayload(position(7, { is_featured: true, gender: "男" }), { is_active: false });
    expect(payload).toMatchObject({ position_name: "p7", gender: "男", is_active: false });
    expect(payload).not.toHaveProperty("is_featured");
    expect(payload).not.toHaveProperty("id");
  });
});

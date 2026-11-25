/**
 * 开场「位置卡」条目的解析（服务端两处共用）。
 *
 * 开场表把位置卡存成 `kind='location'` + `content` 里一段 JSON：
 *   {"lng":113.39114,"lat":23.117692,"address":"…","name":"…"}
 *
 * 后台编辑接口（agent-persona）和客户端开场清单接口（agent/opening）都要把它
 * 解析成结构化字段下发，前端画预览、客户端生成卡片都靠这几个值。
 * 2026-11-25：客户端清单之前漏了 location 字段，导致开场位置卡永远「缺坐标」被跳过。
 */

export type OpeningLocation = { lng: number; lat: number; address: string; name: string };

export function parseOpeningLocation(raw: unknown): OpeningLocation | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    lng: Number(record.lng),
    lat: Number(record.lat),
    address: typeof record.address === "string" ? record.address.trim() : "",
    name: typeof record.name === "string" ? record.name.trim() : "",
  };
}

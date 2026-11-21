import { createHash } from "node:crypto";

type OpeningVersionItem = {
  seq?: unknown;
  kind?: unknown;
  content?: unknown;
  media_name?: unknown;
  delay_ms?: unknown;
  status?: unknown;
};

/** Hash only the ordered executable opening content, not database IDs or persona text. */
export function openingVersion(positionId: number, items: OpeningVersionItem[]): string {
  const number = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const openings = items.filter(item => item.status === undefined || item.status === "enabled")
    .map(item => ({
      seq: number(item.seq, 0),
      kind: String(item.kind ?? "text"),
      content: String(item.content ?? ""),
      media_name: String(item.media_name ?? ""),
      delay_ms: number(item.delay_ms, 2000),
    }))
    .sort((a, b) => a.seq - b.seq);
  return createHash("sha256").update(JSON.stringify({ position_id: number(positionId, 0), openings })).digest("hex");
}

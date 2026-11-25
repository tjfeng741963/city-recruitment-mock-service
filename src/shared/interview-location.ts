export type InterviewLocation = { name: string; address: string; lng: number; lat: number };

/** A saved job point is the authority; a favorite title is only legacy metadata. */
export function interviewLocation(value: unknown): InterviewLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const point = value as Record<string, unknown>;
  const name = typeof point.name === "string" ? point.name.trim().normalize("NFC") : "";
  const address = typeof point.address === "string" ? point.address.trim() : "";
  const coordinate = (raw: unknown) => (typeof raw === "number" || typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
  const lng = coordinate(point.lng), lat = coordinate(point.lat);
  if (!name || !address || !Number.isFinite(lng) || !Number.isFinite(lat) || !lng || !lat || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  return { name, address, lng, lat };
}

export function resolveInterviewLocation(points: unknown, name: string): InterviewLocation | null {
  if (!Array.isArray(points)) return null;
  const matches = points.filter(point => {
    const raw = typeof point === "string" ? point : point?.name;
    return typeof raw === "string" && raw.trim().normalize("NFC") === name;
  });
  return matches.length === 1 ? interviewLocation(matches[0]) : null;
}

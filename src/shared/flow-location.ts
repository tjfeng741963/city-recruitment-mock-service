import { interviewLocation, resolveInterviewLocation, type InterviewLocation } from "./interview-location.js";

export const WORK_LOCATION_KEY = "@work_address";
const WORK_LOCATION_NAME = "岗位工作地点";

export const flowLocationLabel = (key: string): string => key === WORK_LOCATION_KEY ? WORK_LOCATION_NAME : key;

export function validFlowCoordinates(lng: number, lat: number): boolean {
  return Number.isFinite(lng) && Number.isFinite(lat)
    && lng !== 0 && lat !== 0 && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

export function flowLocationOptions(position: Record<string, unknown> | null): Array<InterviewLocation & { key: string }> {
  if (!position) return [];
  const points: unknown[] = Array.isArray(position.interview_points) ? position.interview_points : [];
  const locations = points.flatMap(point => {
    const candidate = interviewLocation(point);
    if (!candidate || candidate.name === WORK_LOCATION_KEY || !resolveInterviewLocation(points, candidate.name)) return [];
    return [{ key: candidate.name, ...candidate }];
  });
  const address = typeof position.work_address === "string" ? position.work_address.trim() : "";
  const coordinates = typeof position.work_coordinates === "string" ? position.work_coordinates.split(/[,，]/) : [];
  const [lat, lng] = coordinates.map(Number);
  if (address && coordinates.length === 2 && validFlowCoordinates(lng, lat)) {
    locations.push({ key: WORK_LOCATION_KEY, name: WORK_LOCATION_NAME, address, lng, lat });
  }
  return locations;
}

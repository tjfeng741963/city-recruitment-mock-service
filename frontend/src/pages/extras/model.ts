import { ApiError } from "../../api/client";

export const PAGE_SIZES = [10, 20, 50];

export function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.detail : fallback;
}

export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function pageSlice<T>(items: T[], page: number, size: number): T[] {
  return items.slice((page - 1) * size, page * size);
}

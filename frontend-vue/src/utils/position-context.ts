const key = (user: string | number) => `recruitment-position:${user}`;
export function readPositionContext(user: string | number): number {
  const id = Number(localStorage.getItem(key(user)));
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}
export function savePositionContext(user: string | number, id: number): void {
  if (id > 0) localStorage.setItem(key(user), String(id));
  else localStorage.removeItem(key(user));
}

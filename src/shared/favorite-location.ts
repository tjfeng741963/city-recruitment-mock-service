type Point = Record<string, unknown>;

export type FavoriteLocationPreview =
  | { status: "needs_point"; point_names: string[] }
  | { status: "not_configured" | "position_disabled"; point_name?: string }
  /** 面试点已绑定采集到的位置卡（迁移 061）→ 客户端可以直接粘出原生卡 */
  | { status: "ready"; point_name: string; card_sha: string; trigger?: "navigation_requested"; after_address_delay_ms?: number }
  | { status: "windows_unavailable"; point_name: string; favorite_title: string; trigger?: "navigation_requested"; after_address_delay_ms?: number };

const objectPoint = (value: unknown): value is Point =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const titleText = (value: string) => value.trim().normalize("NFC");
const invalidTitle = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const CARD_SHA = /^[a-f0-9]{64}$/;

export const favoriteTitleError = "企微收藏名称须为 100 字以内的单行文字";
export const favoriteDelayError = "Dify 的位置卡等待时间须为 0 到 60 秒";
const validDelay = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 60_000;

export function favoritePointTitles(raw: unknown): Array<{ name: string; title: string; delay: number; cardSha: string }> {
  return Array.isArray(raw) ? raw.flatMap(point => {
    const name = typeof point === "string" ? titleText(point)
      : objectPoint(point) && typeof point.name === "string" ? titleText(point.name) : "";
    if (!name) return [];
    const raw = objectPoint(point) ? point.favorite_title : undefined;
    const title = typeof raw === "string" && !invalidTitle.test(raw) ? titleText(raw) : "";
    const delay = objectPoint(point) ? point.favorite_delay_ms : undefined;
    const cardSha = objectPoint(point) && typeof point.location_card_sha === "string" && CARD_SHA.test(point.location_card_sha)
      ? point.location_card_sha : "";
    return [{ name, title: title.length <= 100 ? title : "", delay: validDelay(delay) ? delay : 0, cardSha }];
  }) : [];
}

/** Preserve existing point formats and other saved point fields. */
export function prepareFavoriteTitles(position: Point): string | undefined {
  if (!Array.isArray(position.interview_points)) return;
  const points: unknown[] = [];
  for (const point of position.interview_points) {
    if (!objectPoint(point) || !Object.hasOwn(point, "favorite_title") && !Object.hasOwn(point, "favorite_delay_ms") && !Object.hasOwn(point, "location_card_sha")) {
      points.push(point);
      continue;
    }
    const { favorite_title: raw = "", favorite_delay_ms: delay, location_card_sha: cardSha, ...other } = point;
    if (typeof raw !== "string" || invalidTitle.test(raw)) return favoriteTitleError;
    const favorite_title = titleText(raw);
    if (favorite_title.length > 100 || (favorite_title && (typeof point.name !== "string" || !point.name.trim()))) return favoriteTitleError;
    if (delay !== undefined && !validDelay(delay)) return favoriteDelayError;
    // 位置卡只认 64 位小写 hex；前端传了脏值就当没绑，别让发送端拿着坏 sha 去找卡。
    const location_card_sha = typeof cardSha === "string" && CARD_SHA.test(cardSha) ? cardSha : "";
    points.push({
      ...other,
      ...(favorite_title && { favorite_title }),
      ...(delay !== undefined && favorite_title && { favorite_delay_ms: delay }),
      ...(location_card_sha && { location_card_sha }),
    });
  }
  position.interview_points = points;
}

export function previewFavoriteLocation(question: string, rawPoints: unknown, enabled: boolean, engine?: "dify"): FavoriteLocationPreview | undefined {
  const query = question.normalize("NFC").trim();
  if (!/定位|导航|地图/.test(query) || /不要|不用|不必|别发|取消/.test(query)) return;
  if (/宿舍|住宿|食堂|餐厅|上班|工作|我在|我的定位|我发(?:个|个我的|了|给你)/.test(query)) return;
  if (!/^(?:定位|导航|地图)[？?。！!]*$|(?:发|给|求|要|哪里|怎么|面试|集合).{0,24}(?:定位|导航|地图)|(?:定位|导航|地图).{0,8}(?:在哪|怎么)/.test(query)) return;
  if (!enabled) return { status: "position_disabled" };

  const points = favoritePointTitles(rawPoints);
  if (!points.length) return { status: "not_configured" };
  const mentioned = points.filter(point => query.includes(point.name));
  const [point] = points.length === 1 ? points : mentioned;
  if (points.length > 1 && mentioned.length !== 1) {
    return { status: "needs_point", point_names: [...new Set(points.map(item => item.name))] };
  }
  // 采到卡就发卡（原生位置卡）；只配了收藏名称的仍按旧口径报「Windows 未启用」。
  if (point.cardSha) {
    return { status: "ready", point_name: point.name, card_sha: point.cardSha,
      ...(engine === "dify" && { trigger: "navigation_requested", after_address_delay_ms: point.delay }) };
  }
  return point.title
    ? { status: "windows_unavailable", point_name: point.name, favorite_title: point.title,
        ...(engine === "dify" && { trigger: "navigation_requested", after_address_delay_ms: point.delay }) }
    : { status: "not_configured", point_name: point.name };
}

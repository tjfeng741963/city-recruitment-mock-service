import { useCallback, useEffect, useState } from "react";
import { positionsApi, type Holiday, type Position } from "../../api/admin";
import { ApiError, type City } from "../../api/client";

export interface PositionsData {
  cities: City[];
  positionsByCity: Map<number, Position[]>;
}

export function usePositionsData() {
  const [data, setData] = useState<PositionsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { items: cities } = await positionsApi.cities();
      const lists = await Promise.all(cities.map((c) => positionsApi.positionsInCity(c.city_name).then((r) => r.items)));
      setData({ cities, positionsByCity: new Map(cities.map((c, i) => [c.id, lists[i]])) });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "加载失败");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, error, refresh };
}

export function useHolidays(positionIds: number[]) {
  const [byPosition, setByPosition] = useState<Map<number, Holiday[]>>(new Map());
  const key = positionIds.join(",");

  const load = useCallback(async () => {
    const ids = key ? key.split(",").map(Number) : [];
    const entries = await Promise.all(
      ids.map((id) =>
        positionsApi
          .holidays(id)
          .then((r) => [id, r.items] as const)
          .catch(() => [id, [] as Holiday[]] as const),
      ),
    );
    return new Map(entries);
  }, [key]);

  useEffect(() => {
    let cancelled = false;
    load().then((map) => {
      if (!cancelled) setByPosition(map);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const reload = useCallback(async () => setByPosition(await load()), [load]);
  return { byPosition, reload };
}

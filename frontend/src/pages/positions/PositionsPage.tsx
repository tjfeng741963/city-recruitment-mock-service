import { useMemo, useState } from "react";
import { positionsApi, type Position } from "../../api/admin";
import { ApiError, type City } from "../../api/client";
import { navigate } from "../../app/router";
import { Alert, Badge, Button, EmptyState, SearchField, SegmentedControl, Skeleton, Switch } from "@ui";
import { useAuth } from "../../context/AuthContext";
import { CreateCityDialog, CreatePositionDialog } from "./PositionDialogs";
import { groupByStore, isCityActive, isOnHoliday, localDate } from "./model";
import { useHolidays, usePositionsData } from "./usePositions";

type StatusFilter = "all" | "active" | "paused";

function CityList({ cities, counts, selectedId, onSelect }: { cities: City[]; counts: Map<number, number>; selectedId?: number; onSelect: (id: number) => void }) {
  return (
    <ul className="ps-cities" aria-label="城市">
      {cities.map((c) => (
        <li key={c.id}>
          <button type="button" className={`ps-city ${c.id === selectedId ? "is-selected" : ""}`} aria-current={c.id === selectedId || undefined} onClick={() => onSelect(c.id)}>
            <span className="ps-city-name">{c.city_name}</span>
            {!isCityActive(c) && <span className="ps-city-paused">已暂停</span>}
            <span className="ps-city-count ui-num">{counts.get(c.id) ?? 0}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PositionRow({ position, onHoliday, onToggleFeatured, disabled }: { position: Position; onHoliday: boolean; onToggleFeatured: () => void; disabled: boolean }) {
  const meta = [position.gender, position.age_range, position.job_type].filter(Boolean).join(" · ");
  return (
    <li className={`ps-row ${position.is_active ? "" : "is-off"}`}>
      <a className="ps-row-main" href={`/service-positions/${position.id}/edit`}>
        <span className="ps-row-title">{position.position_name}</span>
        {meta && <span className="ps-row-meta">{meta}</span>}
      </a>
      <span className="ps-row-flags">
        {onHoliday && <Badge tone="neutral">今天放假</Badge>}
        {!position.is_active && <Badge tone="neutral">已停招</Badge>}
      </span>
      <button type="button" className={`ps-star ${position.is_featured ? "is-on" : ""}`} aria-pressed={position.is_featured} disabled={disabled} onClick={onToggleFeatured}>
        {position.is_featured ? "主推" : "设为主推"}
      </button>
    </li>
  );
}

function Head() {
  return (
    <header className="mod-head">
      <h1>岗位</h1>
      <nav className="mod-tabs" aria-label="岗位页签">
        <span className="mod-tab is-active" aria-current="page">城市与岗位</span>
        <a className="mod-tab" href="/holiday-schedules">放假总表</a>
        <a className="mod-tab" href="/city-links">城市关联</a>
      </nav>
    </header>
  );
}

export function PositionsPage({ cityId, featuredOnly = false }: { cityId?: number; featuredOnly?: boolean }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data, error, refresh } = usePositionsData();
  const [selectedId, setSelectedId] = useState<number | undefined>(cityId);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [onlyFeatured, setOnlyFeatured] = useState(featuredOnly);
  const [dialog, setDialog] = useState<"city" | "position" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = localDate(Date.now());

  const counts = useMemo(() => {
    const map = new Map<number, number>();
    data?.positionsByCity.forEach((list, id) => map.set(id, list.filter((p) => p.is_active).length));
    return map;
  }, [data]);

  const visibleCities = useMemo(() => {
    const q = query.trim();
    return (data?.cities ?? [])
      .filter((c) => status === "all" || (status === "active") === isCityActive(c))
      .filter((c) => !q || c.city_name.includes(q) || c.province.includes(q))
      .sort((a, b) => Number(isCityActive(b)) - Number(isCityActive(a)) || a.city_name.localeCompare(b.city_name, "zh"));
  }, [data, query, status]);

  const city = visibleCities.find((c) => c.id === selectedId) ?? visibleCities[0];
  const positions = useMemo(() => {
    const list = (city && data?.positionsByCity.get(city.id)) ?? [];
    return onlyFeatured ? list.filter((p) => p.is_featured) : list;
  }, [city, data, onlyFeatured]);
  const { byPosition: holidays } = useHolidays(positions.map((p) => p.id));
  const groups = groupByStore(positions);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.detail : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  const cityDialog = dialog === "city" && (
    <CreateCityDialog onClose={() => setDialog(null)} onCreated={(c) => { setDialog(null); setSelectedId(c.id); refresh(); }} />
  );

  if (!data) {
    return (
      <div className="mod-page">
        <Head />
        {error ? <Alert tone="danger" title={error} /> : <Skeleton width="50%" height={22} />}
      </div>
    );
  }

  if (data.cities.length === 0) {
    return (
      <div className="mod-page">
        <Head />
        <EmptyState
          icon="city"
          title="先建一个城市"
          description={isAdmin ? "AI 回答工价、住宿、放假这些问题时，用的就是这里的岗位信息。" : "还没有分配给你的城市，请联系管理员。"}
          action={isAdmin ? <Button onClick={() => setDialog("city")}>新建城市</Button> : undefined}
        />
        {cityDialog}
      </div>
    );
  }

  return (
    <div className="mod-page ps-page">
      <Head />
      {(error || actionError) && <Alert tone="danger" title={actionError ?? `${error}（显示的是上一次的数据）`} />}

      <div className="ps-split">
        <aside className="ps-side">
          <SearchField value={query} onChange={setQuery} label="搜索城市或省份" placeholder="城市 / 省份" />
          <SegmentedControl
            size="sm"
            label="招聘状态"
            value={status}
            onChange={(v) => setStatus(v as StatusFilter)}
            options={[{ value: "all", label: "全部" }, { value: "active", label: "招聘中" }, { value: "paused", label: "已暂停" }]}
          />
          {visibleCities.length ? (
            <CityList cities={visibleCities} counts={counts} selectedId={city?.id} onSelect={setSelectedId} />
          ) : (
            <p className="ps-none">没有符合条件的城市</p>
          )}
          {isAdmin && <Button variant="ghost" size="sm" onClick={() => setDialog("city")}>新建城市</Button>}
        </aside>

        <section className="ps-main" aria-label={city ? `${city.city_name}的岗位` : "岗位"}>
          {city && (
            <>
              <div className="ps-main-head">
                <div>
                  <h2>{city.city_name}</h2>
                  <span className="ps-sub">{city.province || "未填省份"} · 在招 {counts.get(city.id) ?? 0} 个岗位</span>
                </div>
                <div className="ps-main-actions">
                  <Switch
                    id="ps-city-status"
                    label={isCityActive(city) ? "招聘中" : "已暂停"}
                    checked={isCityActive(city)}
                    disabled={busy}
                    onChange={() => run(() => positionsApi.setCityStatus(city.id, isCityActive(city) ? "paused" : "active"))}
                  />
                  <Button size="sm" onClick={() => setDialog("position")}>新建岗位</Button>
                </div>
              </div>
              <div className="ps-filter">
                <Switch id="ps-featured" label="只看主推" checked={onlyFeatured} onChange={(e) => setOnlyFeatured(e.target.checked)} />
              </div>
              {groups.length === 0 ? (
                <EmptyState
                  icon="briefcase"
                  title={onlyFeatured ? "这个城市还没有主推岗位" : "这个城市还没有岗位"}
                  description={onlyFeatured ? "在岗位右侧点「设为主推」，AI 会优先推荐它。" : "建好岗位后，AI 才能回答这个城市的工价和要求。"}
                  action={onlyFeatured ? undefined : <Button onClick={() => setDialog("position")}>新建岗位</Button>}
                />
              ) : (
                groups.map((g) => (
                  <div key={g.store} className="ps-group">
                    <h3 className="ps-group-title">{g.store}</h3>
                    <ul className="ps-list">
                      {g.items.map((p) => (
                        <PositionRow
                          key={p.id}
                          position={p}
                          disabled={busy}
                          onHoliday={isOnHoliday(holidays.get(p.id) ?? [], today)}
                          onToggleFeatured={() => run(() => positionsApi.toggleFeatured(p.id))}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </>
          )}
        </section>
      </div>

      {cityDialog}
      {dialog === "position" && city && (
        <CreatePositionDialog
          city={city}
          stores={groups.map((g) => g.store)}
          onClose={() => setDialog(null)}
          onCreated={(p) => navigate(`/service-positions/${p.id}/edit`)}
        />
      )}
    </div>
  );
}

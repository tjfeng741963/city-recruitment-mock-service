import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Checkbox, Dialog, EmptyState, Icon, Skeleton, useFeedback } from "@ui";
import { mobileApi, type FeaturedCity, type FeaturedPosition } from "../../../api/extras";
import { errorText } from "../model";

const DEFAULT_MAX = 3;

function chosenPositions(city: FeaturedCity): FeaturedPosition[] {
  const byId = new Map((city.positions ?? []).map((p) => [p.id, p]));
  return (city.position_ids ?? []).map((id) => byId.get(id)).filter((p): p is FeaturedPosition => Boolean(p));
}

function initialPick(city: FeaturedCity, max: number): number[] {
  if (city.has_custom) return [...(city.position_ids ?? [])];
  return (city.positions ?? []).filter((p) => p.is_featured).map((p) => p.id).slice(0, max);
}

function PickSheet({ city, max, onClose, onSaved }: { city: FeaturedCity; max: number; onClose: () => void; onSaved: () => void }) {
  const { toast } = useFeedback();
  const [picked, setPicked] = useState(() => initialPick(city, max));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const positions = city.positions ?? [];

  function toggle(id: number) {
    if (picked.includes(id)) setPicked(picked.filter((x) => x !== id));
    else if (picked.length >= max) setFailure(`每个城市最多设 ${max} 个主推岗位`);
    else setPicked([...picked, id]);
  }

  async function save() {
    setSaving(true);
    setFailure(null);
    try {
      await mobileApi.setCityFeatured(city.city_name, picked);
      toast(picked.length ? "已保存" : "已清空，恢复跟随公用主推");
      onSaved();
    } catch (err) {
      setFailure(errorText(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      variant="sheet"
      onClose={onClose}
      title={`${city.city_name} · 已选 ${picked.length}/${max}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button loading={saving} onClick={save}>保存</Button>
        </>
      }
    >
      {positions.length === 0 ? (
        <p className="ex-muted">这个城市还没有启用的岗位。</p>
      ) : (
        <div className="mx-pick">
          {positions.map((p) => (
            <Checkbox
              key={p.id}
              id={`mf-${p.id}`}
              checked={picked.includes(p.id)}
              onChange={() => toggle(p.id)}
              label={<>{p.position_name} {p.is_featured && <Badge tone="accent">公用主推</Badge>}</>}
              description={[p.store_name, p.district].filter(Boolean).join(" · ") || undefined}
            />
          ))}
        </div>
      )}
      {failure && <Alert tone="danger" title={failure} />}
    </Dialog>
  );
}

export function MobileFeatured({ onBack }: { onBack: () => void }) {
  const [cities, setCities] = useState<FeaturedCity[] | null>(null);
  const [max, setMax] = useState(DEFAULT_MAX);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FeaturedCity | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await mobileApi.featuredCities();
      setCities(r.cities ?? []);
      setMax(r.max_featured || DEFAULT_MAX);
    } catch (err) {
      setError(errorText(err, "主推设置加载失败"));
      setCities((c) => c ?? []);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="mx-detail" aria-label="主推设置">
      <header className="mx-bar">
        <button type="button" className="mx-icon-btn" aria-label="返回" onClick={onBack}>
          <Icon name="chevronLeft" size={22} />
        </button>
        <div className="mx-bar-title">
          <span className="mx-bar-name">主推设置</span>
        </div>
      </header>
      <div className="mx-scroll">
        <p className="mx-note">给你负责的城市设主推岗位（每城最多 {max} 个）。没设的城市跟随岗位管理里的公用主推。</p>
        {error && <Alert tone="danger" title={error} action={<Button size="sm" variant="secondary" onClick={load}>重试</Button>} />}
        {cities === null && <Skeleton height={88} />}
        {cities?.length === 0 && !error && <EmptyState icon="city" title="还没有负责的城市" description="请联系主账号给你分配城市。" />}
        {cities?.map((c) => {
          const chosen = chosenPositions(c);
          return (
            <article key={c.city_name} className="mx-card">
              <div className="mx-card-head">
                <strong>{c.city_name}</strong>
                <Badge tone={c.has_custom ? "accent" : "neutral"}>{c.has_custom ? "自定义" : "跟随公用"}</Badge>
              </div>
              {chosen.length ? (
                <ul className="mx-card-list">
                  {chosen.map((p) => (
                    <li key={p.id}>
                      {p.position_name} <span className="ex-muted">{p.store_name || p.district || ""}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ex-muted">未设置主推</p>
              )}
              <Button variant="tinted" size="sm" onClick={() => setEditing(c)}>设置主推</Button>
            </article>
          );
        })}
      </div>
      {editing && (
        <PickSheet
          city={editing}
          max={max}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </section>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { positionsApi, type Position } from "../../api/admin";
import { ApiError } from "../../api/client";
import { Button, EmptyState, Input, ListGroup, ListRow, Skeleton, Switch, Textarea } from "@ui";
import { EDITABLE_SECTIONS, localDate, positionPayload, upcomingHolidays } from "./model";
import { useHolidays } from "./usePositions";

type TextField = "store_name" | "district" | "gender" | "age_range" | "job_type" | "accommodation" | "interview_time" | "contact_phone";

const BASIC_FIELDS: Array<[TextField, string, string]> = [
  ["store_name", "工厂", "富士康龙华"],
  ["district", "区县", "龙华区"],
  ["gender", "性别", "男女不限"],
  ["age_range", "年龄", "18-45 岁"],
  ["job_type", "班制", "两班倒"],
  ["accommodation", "住宿", "包住，8 人间"],
  ["interview_time", "面试时间", "每天 9:00"],
  ["contact_phone", "驻场电话", ""],
];

function HolidaySection({ positionId }: { positionId: number }) {
  const { byPosition, reload } = useHolidays([positionId]);
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = localDate(Date.now());
  const upcoming = upcomingHolidays(byPosition.get(positionId) ?? [], today);

  async function act(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!date) return;
    if (await act(() => positionsApi.addHoliday(positionId, label.trim() || "放假", date))) {
      setDate("");
      setLabel("");
    }
  }

  return (
    <ListGroup header="放假日期" footer="放假当天岗位列表会标「今天放假」。已过去的日期不再显示。">
      {upcoming.map((h) => (
        <ListRow
          key={h.id}
          icon="clock"
          iconTone="neutral"
          title={h.holiday_date === today ? `${h.holiday_date}（今天）` : h.holiday_date}
          subtitle={h.label || undefined}
          trailing={<Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => positionsApi.removeHoliday(positionId, h.id))}>删除</Button>}
        />
      ))}
      <form className="ui-row ps-holiday-add" onSubmit={add}>
        <Input id="ps-hol-date" type="date" label="日期" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
        <Input id="ps-hol-label" label="说明" placeholder="国庆" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button type="submit" variant="secondary" size="sm" disabled={!date} loading={busy}>加放假日期</Button>
      </form>
      {error && <p className="mod-error ps-holiday-error" role="alert">{error}</p>}
    </ListGroup>
  );
}

function NotFound() {
  return (
    <div className="mod-page">
      <EmptyState
        icon="briefcase"
        title="找不到这个岗位"
        description="可能已被删除，或不在你负责的城市。"
        action={<a className="ui-btn ui-btn-secondary ui-btn-md" href="/service-positions"><span className="ui-btn-label">回到岗位</span></a>}
      />
    </div>
  );
}

export function PositionEditPage({ positionId }: { positionId: number }) {
  const [position, setPosition] = useState<Position | null>(null);
  const [draft, setDraft] = useState<Position | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    positionsApi
      .position(positionId)
      .then((p) => {
        setPosition(p);
        setDraft(p);
      })
      .catch((err) => setLoadError(err instanceof ApiError && err.status === 404 ? "not-found" : "加载失败，请刷新重试"));
  }, [positionId]);

  if (loadError === "not-found") return <NotFound />;
  if (!position || !draft) {
    return <div className="mod-page">{loadError ? <p className="mod-error" role="alert">{loadError}</p> : <Skeleton width="40%" height={28} />}</div>;
  }

  const current = draft;
  const dirty = JSON.stringify(positionPayload(position, {})) !== JSON.stringify(positionPayload(current, {}));
  const nameOk = current.position_name.trim() !== "";
  const update = (patch: Partial<Position>) => {
    setDraft({ ...current, ...patch });
    setSaved(false);
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!position || !nameOk) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await positionsApi.updatePosition(position.id, positionPayload(position, current));
      setPosition(result);
      setDraft(result);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.detail : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mod-page mod-narrow">
      <nav className="mod-crumb" aria-label="位置">
        <a href="/service-positions">岗位</a> / {position.store_name || "未填工厂"} / {position.position_name}
      </nav>
      <form onSubmit={save}>
        <header className="mod-head">
          <h1>{position.position_name}</h1>
          <div className="ps-save">
            {saved && !dirty && <span className="ps-saved" role="status">已保存</span>}
            <Button type="submit" loading={saving} disabled={!dirty || !nameOk}>保存</Button>
          </div>
        </header>
        {saveError && <p className="mod-error" role="alert">{saveError}</p>}

        <ListGroup header="状态">
          <div className="ui-row">
            <Switch
              id="ps-active"
              label="在招"
              description="停招后 AI 不再向候选人推荐这个岗位"
              checked={current.is_active}
              onChange={(e) => update({ is_active: e.target.checked })}
            />
          </div>
        </ListGroup>

        <section className="ps-form-card" aria-labelledby="ps-basic">
          <h2 className="ps-form-title" id="ps-basic">基本信息</h2>
          <div className="ps-form-grid">
            <Input
              id="ps-f-name"
              label="岗位名称"
              value={current.position_name}
              onChange={(e) => update({ position_name: e.target.value })}
              required
              error={nameOk ? undefined : "岗位名称不能为空"}
            />
            {BASIC_FIELDS.map(([key, label, placeholder]) => (
              <Input key={key} id={`ps-f-${key}`} label={label} placeholder={placeholder} value={current[key]} onChange={(e) => update({ [key]: e.target.value })} />
            ))}
          </div>
        </section>

        <section className="ps-form-card" aria-labelledby="ps-sections">
          <h2 className="ps-form-title" id="ps-sections">工价与要求</h2>
          <p className="ps-form-hint">AI 回答候选人时直接引用这些文字，写成你会对候选人说的话。</p>
          {EDITABLE_SECTIONS.map((key) => (
            <Textarea
              key={key}
              id={`ps-s-${key}`}
              label={current.base_section_labels[key] || key}
              rows={key === "salary_detail" ? 4 : 2}
              value={current.base_sections[key] ?? ""}
              onChange={(e) => update({ base_sections: { ...current.base_sections, [key]: e.target.value } })}
            />
          ))}
          <p className="ps-form-hint">工作环境、体检、行李等其余话术在原页面编辑。</p>
        </section>
      </form>

      <HolidaySection positionId={position.id} />
    </div>
  );
}

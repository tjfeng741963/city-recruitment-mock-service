import { useState, type FormEvent } from "react";
import { Alert, Button, Dialog, Input, Select, Switch, Textarea, useFeedback } from "@ui";
import { holidayApi, type HolidayInput, type HolidaySchedule, type MyCity } from "../../api/extras";
import { errorText } from "./model";

type Errors = Partial<Record<"city_name" | "holiday_name" | "start_date" | "end_date", string>>;

export function yearOptions(now = new Date().getFullYear()): number[] {
  return [now - 1, now, now + 1, now + 2];
}

function blank(): HolidayInput {
  return {
    city_name: "",
    interview_site_name: "",
    year: new Date().getFullYear(),
    holiday_name: "",
    start_date: "",
    end_date: "",
    can_interview: false,
    is_makeup_day: false,
    special_note: "",
    sort_order: 0,
    is_active: true,
  };
}

function fromRow(row: HolidaySchedule): HolidayInput {
  const { id: _id, updated_at: _updated, ...input } = row;
  return { ...blank(), ...input };
}

function validate(f: HolidayInput): Errors {
  const errors: Errors = {};
  if (!f.city_name) errors.city_name = "请选择城市";
  if (!f.holiday_name.trim()) errors.holiday_name = "请填写节假日名称，如：春节";
  if (!f.start_date) errors.start_date = "请选择开始日期";
  if (!f.end_date) errors.end_date = "请选择结束日期";
  else if (f.start_date && f.end_date < f.start_date) errors.end_date = "结束日期不能早于开始日期";
  return errors;
}

export function HolidayDialog({
  editing,
  cities,
  onClose,
  onSaved,
}: {
  editing: HolidaySchedule | null;
  cities: MyCity[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useFeedback();
  const [form, setForm] = useState<HolidayInput>(() => (editing ? fromRow(editing) : blank()));
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const city = cities.find((c) => c.city_name === form.city_name);
  const sites = city?.interview_site_name ? [city.city_name, city.interview_site_name] : [];
  const set = <K extends keyof HolidayInput>(key: K, value: HolidayInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    setFailure(null);
    const input = { ...form, holiday_name: form.holiday_name.trim(), special_note: form.special_note.trim() };
    try {
      if (editing) await holidayApi.update(editing.id, input, city?.id);
      else await holidayApi.create(input, city?.id);
      toast(editing ? "已更新" : "已添加");
      onSaved();
    } catch (err) {
      setFailure(errorText(err, "保存失败，请重试"));
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>取消</Button>
      <Button loading={saving} onClick={() => submit()}>保存</Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title={editing ? "编辑放假安排" : "添加放假安排"} footer={footer}>
      <form className="ex-form" onSubmit={submit}>
        <div className="ex-form-grid">
          <Select
            id="hd-city"
            label="城市"
            required
            placeholder="选择城市"
            value={form.city_name}
            error={errors.city_name}
            options={cities.map((c) => ({ value: c.city_name, label: c.city_name }))}
            onChange={(e) => setForm((f) => ({ ...f, city_name: e.target.value, interview_site_name: "" }))}
          />
          <Select
            id="hd-site"
            label="面试点"
            helperText={form.city_name && !sites.length ? "这个城市没有设置面试点" : "不选表示整个城市"}
            value={form.interview_site_name}
            options={[{ value: "", label: "整个城市" }, ...sites.map((s) => ({ value: s, label: s }))]}
            onChange={(e) => set("interview_site_name", e.target.value)}
          />
          <Select
            id="hd-year"
            label="年份"
            required
            value={String(form.year)}
            options={yearOptions().map((y) => ({ value: String(y), label: `${y} 年` }))}
            onChange={(e) => set("year", Number(e.target.value))}
          />
          <Input id="hd-name" label="节假日名称" required placeholder="如：元旦、春节" value={form.holiday_name} error={errors.holiday_name} onChange={(e) => set("holiday_name", e.target.value)} />
          <Input id="hd-start" type="date" label="开始日期" required value={form.start_date} error={errors.start_date} onChange={(e) => set("start_date", e.target.value)} />
          <Input id="hd-end" type="date" label="结束日期" required value={form.end_date} min={form.start_date || undefined} error={errors.end_date} onChange={(e) => set("end_date", e.target.value)} />
        </div>
        <div className="ex-form-switches">
          <Switch id="hd-interview" label="放假期间可以面试" checked={form.can_interview} onChange={(e) => set("can_interview", e.target.checked)} />
          <Switch id="hd-makeup" label="这是补班日" checked={form.is_makeup_day} onChange={(e) => set("is_makeup_day", e.target.checked)} />
          <Switch id="hd-active" label="启用" description="停用后 AI 不再按这条安排回答" checked={form.is_active} onChange={(e) => set("is_active", e.target.checked)} />
        </div>
        <Input id="hd-sort" type="number" min={0} label="排序" helperText="数字小的排在前面" value={String(form.sort_order)} onChange={(e) => set("sort_order", Math.max(0, Number(e.target.value) || 0))} />
        <Textarea id="hd-note" label="特殊说明" rows={2} placeholder="如：面试时间以应聘者回复为准" value={form.special_note} onChange={(e) => set("special_note", e.target.value)} />
        {failure && <Alert tone="danger" title={failure} />}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

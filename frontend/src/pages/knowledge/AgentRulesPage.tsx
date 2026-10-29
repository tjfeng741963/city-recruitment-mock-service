import { useCallback, useEffect, useState, type FormEvent } from "react";
import { agentRulesApi, type FollowupConfig, type ReminderConfig } from "../../api/knowledge";
import { Alert, Button, Input, RadioGroup, Skeleton, Switch, Textarea, useFeedback } from "@ui";
import { useAuth } from "../../context/AuthContext";
import { ModuleTabs, RetryAlertAction, errorText } from "./shared";

function intIn(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : null;
}

function useSave<T>(save: (v: T) => Promise<T>) {
  const { toast } = useFeedback();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(value: T): Promise<T | null> {
    setSaving(true);
    setError(null);
    try {
      const result = await save(value);
      toast("已保存", "success");
      return result;
    } catch (err) {
      setError(errorText(err, "保存失败"));
      return null;
    } finally {
      setSaving(false);
    }
  }
  return { saving, error, run };
}

function ReminderForm({ initial, canEdit }: { initial: ReminderConfig; canEdit: boolean }) {
  const [cfg, setCfg] = useState(initial);
  const [hours, setHours] = useState(String(initial.advance_hours));
  const [fieldError, setFieldError] = useState<{ hours?: string; time?: string }>({});
  const { saving, error, run } = useSave(agentRulesApi.saveReminder);
  const off = !cfg.enabled || !canEdit;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const h = intIn(hours, 2, 72);
    const found = {
      hours: cfg.mode === "advance" && h === null ? "请填 2 到 72 之间的整数" : undefined,
      time: cfg.mode === "fixed" && !/^\d{2}:\d{2}$/.test(cfg.fixed_time) ? "请选择提醒时间" : undefined,
    };
    setFieldError(found);
    if (found.hours || found.time) return;
    const saved = await run({ ...cfg, advance_hours: h ?? cfg.advance_hours });
    if (saved) {
      setCfg(saved);
      setHours(String(saved.advance_hours));
    }
  }

  return (
    <form className="ps-form-card kn-rule-card" onSubmit={submit} noValidate>
      <div className="kn-rule-head">
        <h2>面试提醒</h2>
        <Switch id="kn-reminder-on" label="开启" checked={cfg.enabled} disabled={!canEdit} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
      </div>
      <p className="ps-form-hint">在面试前给已约面的候选人发一条提醒消息。</p>
      <RadioGroup
        name="kn-reminder-mode"
        legend="提醒方式"
        disabled={off}
        value={cfg.mode}
        onChange={(v) => setCfg({ ...cfg, mode: v === "fixed" ? "fixed" : "advance" })}
        options={[
          { value: "advance", label: "面试前 N 小时提醒" },
          { value: "fixed", label: "面试当天固定时间提醒" },
        ]}
      />
      {cfg.mode === "advance" ? (
        <Input
          id="kn-reminder-hours"
          label="提前几小时"
          type="number"
          min={2}
          max={72}
          step={1}
          required
          disabled={off}
          helperText="最少 2 小时。离面试不到 2 小时就不再发提醒。"
          value={hours}
          error={fieldError.hours}
          onChange={(e) => setHours(e.target.value)}
        />
      ) : (
        <Input
          id="kn-reminder-time"
          label="提醒时间"
          type="time"
          required
          disabled={off}
          value={cfg.fixed_time}
          error={fieldError.time}
          onChange={(e) => setCfg({ ...cfg, fixed_time: e.target.value })}
        />
      )}
      <Textarea
        id="kn-reminder-script"
        label="提醒话术"
        rows={3}
        disabled={off}
        placeholder="明天{面试时间}面试，记得带身份证。有问题打{联系电话}"
        helperText="可以用占位符：{面试日期} {面试时间} {联系电话}"
        value={cfg.script}
        onChange={(e) => setCfg({ ...cfg, script: e.target.value })}
      />
      {error && <p className="mod-error" role="alert">{error}</p>}
      {canEdit && (
        <div className="st-actions">
          <Button type="submit" loading={saving}>保存面试提醒</Button>
        </div>
      )}
    </form>
  );
}

function FollowupForm({ initial, canEdit }: { initial: FollowupConfig; canEdit: boolean }) {
  const [cfg, setCfg] = useState(initial);
  const [intervalText, setIntervalText] = useState(String(initial.interval_seconds));
  const [maxCount, setMaxCount] = useState(String(initial.max_count));
  const [fieldError, setFieldError] = useState<{ interval?: string; max?: string }>({});
  const { saving, error, run } = useSave(agentRulesApi.saveFollowup);
  const off = !cfg.enabled || !canEdit;

  function setScript(i: number, text: string) {
    setCfg({ ...cfg, scripts: cfg.scripts.map((s, j) => (j === i ? text : s)) });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const iv = intIn(intervalText, 60, 3600);
    const mc = intIn(maxCount, 1, 10);
    const scripts = cfg.scripts.map((s) => s.trim()).filter(Boolean);
    const found = {
      interval: iv === null ? "请填 60 到 3600 之间的整数" : undefined,
      max: mc === null ? "请填 1 到 10 之间的整数" : undefined,
    };
    setFieldError(found);
    if (found.interval || found.max || iv === null || mc === null) return;
    const saved = await run({ ...cfg, interval_seconds: iv, max_count: mc, scripts });
    if (saved) {
      setCfg(saved);
      setIntervalText(String(saved.interval_seconds));
      setMaxCount(String(saved.max_count));
    }
  }

  return (
    <form className="ps-form-card kn-rule-card" onSubmit={submit} noValidate>
      <div className="kn-rule-head">
        <h2>自动追问</h2>
        <Switch id="kn-followup-on" label="开启" checked={cfg.enabled} disabled={!canEdit} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
      </div>
      <p className="ps-form-hint">候选人一段时间没回复时，AI 从话术里挑一条再问一次。</p>
      <div className="ps-form-grid">
        <Input id="kn-followup-interval" label="追问间隔（秒）" type="number" min={60} max={3600} step={60} required disabled={off} helperText="60 到 3600 秒" value={intervalText} error={fieldError.interval} onChange={(e) => setIntervalText(e.target.value)} />
        <Input id="kn-followup-max" label="最多追问几次" type="number" min={1} max={10} step={1} required disabled={off} helperText="超过后标记为沉默" value={maxCount} error={fieldError.max} onChange={(e) => setMaxCount(e.target.value)} />
      </div>
      <fieldset className="kn-scripts" disabled={off}>
        <legend className="ui-field-label">追问话术</legend>
        {cfg.scripts.length === 0 && <p className="kn-muted">还没有话术。开启追问前请至少加一条。</p>}
        {cfg.scripts.map((s, i) => (
          <div className="kn-script-row" key={i}>
            <Input id={`kn-script-${i}`} aria-label={`第 ${i + 1} 条话术`} placeholder="在吗？岗位还有名额，要不要先帮你约个面试？" value={s} onChange={(e) => setScript(i, e.target.value)} />
            <Button size="sm" variant="ghost" onClick={() => setCfg({ ...cfg, scripts: cfg.scripts.filter((_, j) => j !== i) })}>删除</Button>
          </div>
        ))}
        <div>
          <Button size="sm" variant="secondary" onClick={() => setCfg({ ...cfg, scripts: [...cfg.scripts, ""] })}>添加话术</Button>
        </div>
      </fieldset>
      {error && <p className="mod-error" role="alert">{error}</p>}
      {canEdit && (
        <div className="st-actions">
          <Button type="submit" loading={saving}>保存自动追问</Button>
        </div>
      )}
    </form>
  );
}

export function AgentRulesPage() {
  const { user } = useAuth();
  const canEdit = user?.role === "admin";
  const [data, setData] = useState<{ reminder: ReminderConfig; followup: FollowupConfig } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([agentRulesApi.getReminder(), agentRulesApi.getFollowup()])
      .then(([reminder, followup]) => alive && setData({ reminder, followup: { ...followup, scripts: followup.scripts ?? [] } }))
      .catch((err) => alive && setError(errorText(err, "回复规则加载失败")));
    return () => {
      alive = false;
    };
  }, [version]);

  return (
    <div className="mod-page mod-narrow">
      <header className="mod-head">
        <h1>知识库</h1>
        <ModuleTabs active="rules" />
      </header>
      {!canEdit && <p className="st-note">只有管理员能修改回复规则。</p>}
      {error ? (
        <Alert tone="danger" title="回复规则加载失败" action={<RetryAlertAction onRetry={reload} />}>{error}</Alert>
      ) : !data ? (
        <div className="kn-sheet-skeleton">
          <Skeleton height={260} />
          <Skeleton height={260} />
        </div>
      ) : (
        <>
          <ReminderForm key={`r-${version}`} initial={data.reminder} canEdit={canEdit} />
          <FollowupForm key={`f-${version}`} initial={data.followup} canEdit={canEdit} />
        </>
      )}
    </div>
  );
}

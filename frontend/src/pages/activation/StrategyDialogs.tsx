import { useState, type FormEvent } from "react";
import { Alert, Button, Dialog, Input, Switch, useFeedback } from "@ui";
import { activationApi, type Strategy, type StrategyPatch, type StrategyTestResult } from "../../api/activation";
import { errText, strategyLabel } from "./shared";

const DEFAULT_OFFSETS = [1, 3, 7];
const TIER_LABELS = ["第 1 档", "第 2 档", "第 3 档"];

function windowOf(s: Strategy): [string, string] {
  const w = Array.isArray(s.send_window) ? s.send_window : [];
  return [w[0] ?? "", w[1] ?? ""];
}

const toInt = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

export function ParamsDialog({ strategy, onClose, onSaved }: { strategy: Strategy; onClose: () => void; onSaved: (s: Strategy) => void }) {
  const { toast } = useFeedback();
  const isA = strategy.code === "no_reply";
  const [start, end] = windowOf(strategy);
  const offsets = strategy.auto_push?.offsets_days?.length ? strategy.auto_push.offsets_days : DEFAULT_OFFSETS;
  const [draft, setDraft] = useState({
    start,
    end,
    daily: String(strategy.daily_limit ?? 20),
    min: String(strategy.stale_days ?? 2),
    max: String(strategy.stale_days_max ?? 3),
    push: Boolean(strategy.auto_push?.enabled),
    days: [0, 1, 2].map((i) => String(offsets[i] ?? DEFAULT_OFFSETS[i])),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const windowError = !draft.start || !draft.end || draft.start >= draft.end ? "开始时间需早于结束时间" : undefined;
  const dailyError = Number(draft.daily) < 1 || Number(draft.daily) > 500 ? "请填 1–500 之间的整数" : undefined;
  const rangeError = isA && toInt(draft.min) > toInt(draft.max) ? "起始天数不能大于上限天数" : undefined;
  const d = draft.days.map(toInt);
  const daysError = isA && draft.push && !(d[0] < d[1] && d[1] < d[2]) ? "三档间隔需逐档递增（第 1 档 < 第 2 档 < 第 3 档）" : undefined;
  const invalid = Boolean(windowError || dailyError || rangeError || daysError);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    const patch: StrategyPatch = { send_window: [draft.start, draft.end], daily_limit: Math.max(1, toInt(draft.daily)) };
    if (isA) {
      patch.stale_days = toInt(draft.min);
      patch.stale_days_max = toInt(draft.max);
      patch.auto_push = { enabled: draft.push, offsets_days: d };
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await activationApi.updateStrategy(strategy.code, patch));
      toast("参数已保存");
    } catch (err) {
      setError(errText(err, "保存失败"));
      setSaving(false);
    }
  }

  const set = (patch: Partial<typeof draft>) => setDraft((v) => ({ ...v, ...patch }));

  return (
    <Dialog
      open
      onClose={onClose}
      title={`调整参数 · ${strategyLabel(strategy.code)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="ac-params-form" loading={saving} disabled={invalid}>保存</Button>
        </>
      }
    >
      <form id="ac-params-form" className="mod-form" noValidate onSubmit={submit}>
        <div className="ac-form-grid">
          <Input id="ac-p-start" type="time" step={1800} label="发送开始" required value={draft.start} onChange={(e) => set({ start: e.target.value })} />
          <Input id="ac-p-end" type="time" step={1800} label="发送结束" required value={draft.end} error={windowError} onChange={(e) => set({ end: e.target.value })} />
        </div>
        <Input
          id="ac-p-daily"
          type="number"
          min={1}
          max={500}
          label="每日总量（条/天）"
          required
          value={draft.daily}
          error={dailyError}
          helperText="三档自动推送全设备合计的每日上限；每台设备另有限流，在「设备」页设置。"
          onChange={(e) => set({ daily: e.target.value })}
        />
        {isA && (
          <>
            <div className="ac-form-grid">
              <Input id="ac-p-min" type="number" min={0} max={30} label="入单窗口：沉默至少（天）" value={draft.min} onChange={(e) => set({ min: e.target.value })} />
              <Input id="ac-p-max" type="number" min={0} max={30} label="入单窗口：沉默至多（天）" value={draft.max} error={rangeError} onChange={(e) => set({ max: e.target.value })} />
            </div>
            <p className="ac-muted">每天只扫描沉默在此区间内、且首次对话在 10 天内的客户入单，保证完整上下文都在 Dify 记忆窗口里。</p>
            <Switch
              id="ac-p-push"
              label="三档推送"
              description="入单后自动推送：上一档没回复到点推下一档，客户回复或人工接管即停。"
              checked={draft.push}
              onChange={(e) => set({ push: e.target.checked })}
            />
            {draft.push && (
              <fieldset className="ac-fieldset">
                <legend className="ac-label">推送间隔（从入单时间起算，单位：天）</legend>
                <div className="ac-form-grid ac-form-grid-3">
                  {TIER_LABELS.map((label, i) => (
                    <Input
                      key={label}
                      id={`ac-p-day-${i}`}
                      type="number"
                      min={0}
                      max={90}
                      label={label}
                      value={draft.days[i]}
                      onChange={(e) => set({ days: draft.days.map((v, j) => (j === i ? e.target.value : v)) })}
                    />
                  ))}
                </div>
                {daysError && <Alert tone="danger" title={daysError} />}
              </fieldset>
            )}
          </>
        )}
        {error && <Alert tone="danger" title={error} />}
      </form>
    </Dialog>
  );
}

export function TestDialog({ code, onClose }: { code: string; onClose: () => void }) {
  const [customerId, setCustomerId] = useState("");
  const [result, setResult] = useState<StrategyTestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const missing = !customerId.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (missing) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await activationApi.testStrategy(code, customerId.trim()));
    } catch (err) {
      setResult(null);
      setError(errText(err, "预览失败"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`测试预览 · ${strategyLabel(code)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>关闭</Button>
          <Button type="submit" form="ac-test-form" loading={running}>生成预览</Button>
        </>
      }
    >
      <div className="ac-stack">
        <Alert tone="accent" title="只预览，不会实际发送消息">看激活会带什么上下文、从哪里切入。</Alert>
        <form id="ac-test-form" className="mod-form" noValidate onSubmit={submit}>
          <Input
            id="ac-test-customer"
            label="客户 ID"
            required
            placeholder="输入客户 ID"
            value={customerId}
            error={touched && missing ? "请输入客户 ID" : undefined}
            onChange={(e) => setCustomerId(e.target.value)}
          />
        </form>
        {error && <Alert tone="danger" title={error} />}
        {result && (
          <>
            <section className="ac-stack-sm">
              <h4 className="ac-label">激活依据（AI 摘要）</h4>
              <p className="ac-box">{result.summary || "暂无摘要"}</p>
            </section>
            <section className="ac-stack-sm">
              <h4 className="ac-label">激活方式</h4>
              <p className="ac-box">
                发送时从复聊话术库随机抽取一条作为激活消息（在「话术」页维护）；客户回复后仍转入原 Dify 智能体接管，带着该客户的全部历史对话继续主流程。
              </p>
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}

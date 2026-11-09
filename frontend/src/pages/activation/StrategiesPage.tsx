import { useState, type FormEvent } from "react";
import { Alert, Button, Input, Panel, Reveal, RevealItem, Skeleton, Switch, useFeedback } from "@ui";
import { activationApi, type Strategy, type StrategyList } from "../../api/activation";
import { ActivationHead, LoadError, errText, strategyLabel, useLoad } from "./shared";
import { ParamsDialog, TestDialog } from "./StrategyDialogs";

const loadStrategies = () => activationApi.strategies();

function windowText(s: Strategy): string {
  return Array.isArray(s.send_window) ? s.send_window.join(" 至 ") : s.send_window || "—";
}

function StrategyCard({
  strategy,
  onToggle,
  onEdit,
  onTest,
  toggling,
}: {
  strategy: Strategy;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onTest: () => void;
  toggling: boolean;
}) {
  const s = strategy;
  const isA = s.code === "no_reply";
  const meta: Array<[string, string]> = [
    ["触发条件", s.trigger],
    ["发送时段", windowText(s)],
  ];
  if (isA && s.auto_push) {
    meta.push(["三档推送", s.auto_push.enabled ? `开启 · 入单后第 ${s.auto_push.offsets_days.join("、")} 天各推一次` : "关闭"]);
  }
  if (isA && s.stale_days_max) {
    meta.push(["入单窗口", `沉默 ${s.stale_days}~${s.stale_days_max} 天且首次对话在 10 天内才入单`]);
  }
  if (isA && s.daily_limit) meta.push(["每日总量", `${s.daily_limit} 条/天（三档自动推送全设备合计）`]);

  return (
    <article className={`ac-card ${s.enabled ? "" : "is-off"}`}>
      <div className="ac-row-between">
        <div>
          <h3 className="ac-card-title">{strategyLabel(s.code)}</h3>
          <p className="ac-muted">{s.description}</p>
        </div>
        <Switch
          id={`ac-strategy-${s.code}`}
          label={<span className="ui-sr-only">启用 {strategyLabel(s.code)}</span>}
          checked={s.enabled}
          disabled={toggling}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </div>
      <dl className="ac-meta">
        {meta.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="ac-actions">
        <Button size="sm" onClick={onEdit}>调整参数</Button>
        <Button size="sm" variant="secondary" onClick={onTest}>测试预览</Button>
      </div>
    </article>
  );
}

function EngineForm({ engine, onSaved }: { engine: StrategyList["engine"]; onSaved: (e: StrategyList["engine"]) => void }) {
  const { toast } = useFeedback();
  const [time, setTime] = useState(engine.schedule_time ?? "");
  const [autoReview, setAutoReview] = useState(Boolean(engine.auto_review));
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const config = await activationApi.updateEngine({ auto_review: autoReview, schedule_time: time || undefined });
      onSaved({ auto_review: config.auto_review, freeze_days: config.freeze_days, schedule_time: config.schedule_time });
      toast("调度配置已保存");
    } catch (err) {
      toast(errText(err, "保存失败"), "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="调度引擎">
      <form className="mod-form" noValidate onSubmit={save}>
        <div className="ac-form-grid">
          <Input id="ac-engine-time" type="time" label="每日调度时间" helperText="每天到点扫描各策略名单，生成今日待激活队列" value={time} onChange={(e) => setTime(e.target.value)} />
          <Switch
            id="ac-engine-auto"
            label="免人工审核"
            description="开启后话术生成完直接进入发送队列；「误判捞回」策略不受影响，始终需要人工审核。"
            checked={autoReview}
            onChange={(e) => setAutoReview(e.target.checked)}
          />
        </div>
        <div className="ac-actions">
          <Button type="submit" loading={saving}>保存调度配置</Button>
        </div>
      </form>
    </Panel>
  );
}
export function StrategiesPage() {
  const { toast } = useFeedback();
  const { data, setData, error, reload } = useLoad(loadStrategies);
  const [editing, setEditing] = useState<Strategy | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  // Same as the old page: only the A strategy is shown and configurable.
  const strategies = (data?.items ?? []).filter((s) => s.code === "no_reply");

  function replace(next: Strategy) {
    setData((d) => (d ? { ...d, items: d.items.map((s) => (s.code === next.code ? next : s)) } : d));
  }

  async function toggle(s: Strategy, enabled: boolean) {
    setToggling(s.code);
    try {
      replace(await activationApi.updateStrategy(s.code, { enabled }));
      toast(`${strategyLabel(s.code)} 已${enabled ? "开启" : "关闭"}`);
    } catch (err) {
      toast(errText(err, "操作失败"), "danger");
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="mod-page">
      <ActivationHead title="激活策略" current="/activation/strategies" />
      <div className="ac-stack-sm">
        <p className="ac-muted">策略决定“谁在什么时候被激活”；激活消息从复聊话术库随机抽取（在「话术」页维护），客户回复后仍由原 Dify 对话接管。</p>
        <p className="ac-muted">配置按账号区分：管理员看到的是全局默认模板（各账号没自定义时生效）；总账号保存后会生成自己账号的独立配置，之后管理员改全局模板不再影响它。</p>
      </div>
      {error ? (
        <LoadError message={error} onRetry={reload} />
      ) : !data ? (
        <>
          <Skeleton height={200} />
          <Skeleton height={140} />
        </>
      ) : (
        <>
          {strategies.length === 0 ? (
            <Alert tone="warning" title="没有可配置的策略">后台没有返回 A 策略，请联系管理员检查策略配置。</Alert>
          ) : (
            <Reveal className="ac-cards">
              {strategies.map((s) => (
                <RevealItem key={s.code}>
                  <StrategyCard
                    strategy={s}
                    toggling={toggling === s.code}
                    onToggle={(enabled) => toggle(s, enabled)}
                    onEdit={() => setEditing(s)}
                    onTest={() => setTesting(s.code)}
                  />
                </RevealItem>
              ))}
            </Reveal>
          )}
          <EngineForm engine={data.engine} onSaved={(engine) => setData((d) => (d ? { ...d, engine } : d))} />
        </>
      )}
      {editing && (
        <ParamsDialog
          strategy={editing}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            replace(s);
            setEditing(null);
          }}
        />
      )}
      {testing && <TestDialog code={testing} onClose={() => setTesting(null)} />}
    </div>
  );
}

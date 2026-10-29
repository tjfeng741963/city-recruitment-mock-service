import { useCallback, useEffect, useState } from "react";
import { Badge, Button, DescriptionList, Dialog, EmptyState, Panel, Reveal, RevealItem, Skeleton, Textarea, Timeline, useFeedback, type TimelineEntry } from "@ui";
import { activationApi, type ActivationRecord, type ChatMessage, type CustomerDetail } from "../../api/activation";
import { LoadError, PausedBanner, errText, fullTime, statusMeta, strategyLabel } from "./shared";

const SUMMARY_MAX = 1000;

interface View {
  customer: Partial<ActivationRecord>;
  summary: string;
  messages: ChatMessage[];
  history: TimelineEntry[];
}

/** Old backend sent customer/messages/activation_history; the local one sends records only. Build the timeline from records when needed. */
function toView(id: string, data: CustomerDetail): View {
  const records = data.records ?? [];
  const customer = data.customer ?? records[0] ?? { customer_id: data.customer_id ?? id };
  const history: TimelineEntry[] = data.activation_history
    ? data.activation_history.map((h, i) => ({ id: i, time: h.time, title: h.title, body: h.desc, tone: i === data.activation_history!.length - 1 ? "accent" : "neutral" }))
    : [...records].reverse().map((r, i, all) => ({
        id: String(r.id),
        time: fullTime(r.updated_at ?? r.created_at),
        title: `${strategyLabel(r.strategy)} · ${statusMeta(r.status).label}`,
        body: r.tier > 0 ? `已推送 ${r.tier} 档` : `入单 ${fullTime(r.created_at)}`,
        tone: i === all.length - 1 ? "accent" : "neutral",
      }));
  return { customer, summary: data.summary ?? customer.summary ?? "", messages: data.messages ?? [], history };
}

function roleName(role: string, nickname: string): string {
  if (role === "customer") return nickname || "客户";
  if (role === "manual") return "招聘员代回复";
  return "AI";
}

function SummaryDialog({ id, initial, onClose, onSaved }: { id: string; initial: string; onClose: () => void; onSaved: (s: string) => void }) {
  const { toast } = useFeedback();
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await activationApi.updateSummary(id, text);
      toast("摘要已保存");
      onSaved(text);
    } catch (err) {
      setError(errText(err, "保存失败"));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="编辑 AI 摘要"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button loading={saving} onClick={save}>保存</Button>
        </>
      }
    >
      <Textarea
        id="ac-summary"
        label="摘要内容"
        rows={6}
        maxLength={SUMMARY_MAX}
        value={text}
        onChange={(e) => setText(e.target.value)}
        helperText={`${text.length} / ${SUMMARY_MAX}`}
        error={error ?? undefined}
      />
    </Dialog>
  );
}
export function CustomerPage({ id }: { id: string }) {
  const { toast } = useFeedback();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [editing, setEditing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setView(toView(id, await activationApi.customer(id)));
    } catch (err) {
      setError(errText(err, "客户详情加载失败"));
    }
    activationApi.config().then((c) => setPaused(c.paused)).catch(() => setPaused(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function regenerate() {
    setRegenerating(true);
    try {
      const result = await activationApi.regenerateSummary(id);
      setView((v) => (v ? { ...v, summary: result.summary ?? "" } : v));
      toast(result.summary ? "摘要已重新生成" : "已重新生成，但暂时没有可总结的对话", result.summary ? "success" : "warning");
    } catch (err) {
      toast(errText(err, "重新生成失败"), "danger");
    } finally {
      setRegenerating(false);
    }
  }

  const c = view?.customer;
  const status = statusMeta(c?.status);

  return (
    <div className="mod-page">
      <div className="mod-crumb"><a href="/activation/today">← 返回今日任务</a></div>
      <header className="mod-head">
        <h1>客户详情</h1>
      </header>
      {paused && <PausedBanner text="当前发送操作不可用，可在复聊总览页恢复。" />}
      {error ? (
        <LoadError message={error} onRetry={load} />
      ) : !view || !c ? (
        <div className="ac-grid">
          <Skeleton height={180} />
          <Skeleton height={180} />
        </div>
      ) : (
        <Reveal className="ac-stack">
          <RevealItem className="ac-grid">
            <Panel title="客户信息">
              <DescriptionList
                items={[
                  ["昵称", c.nickname || "—"],
                  ["客户 ID", <span className="ui-num">{c.customer_id ?? id}</span>],
                  ["设备", c.device_name || c.device_code || "—"],
                  ["招聘员", c.recruiter_id || "—"],
                  ["沉淀原因", strategyLabel(c.strategy)],
                  ["停滞时长", c.stale_days != null ? `${c.stale_days} 天` : "—"],
                  ["激活状态", <Badge tone={status.tone}>{status.label}</Badge>],
                ]}
              />
            </Panel>
            <Panel
              title="AI 摘要"
              actions={
                <>
                  <Button size="sm" variant="tinted" loading={regenerating} onClick={regenerate}>重新生成</Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>编辑</Button>
                </>
              }
            >
              {view.summary ? <p className="ac-box">{view.summary}</p> : <p className="ac-muted">暂无摘要。可点「重新生成」根据对话自动总结，或手动编辑。</p>}
            </Panel>
          </RevealItem>
          <RevealItem className="ac-grid">
            <Panel title="历史对话记录">
              {view.messages.length === 0 ? (
                <EmptyState icon="chat" title="暂无对话记录" description="这位客户和 AI 的聊天记录同步过来后会显示在这里。" />
              ) : (
                <ol className="ac-chat">
                  {view.messages.map((m, i) => (
                    <li key={i} className={`ac-chat-item ${m.role === "customer" ? "is-left" : "is-right"}`}>
                      <div className="ac-bubble">{m.content}</div>
                      <div className="ac-sub">{roleName(m.role, c.nickname ?? "")} · <span className="ui-num">{m.time}</span></div>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
            <Panel title="激活时间线">
              {view.history.length === 0 ? (
                <EmptyState icon="clock" title="暂无激活记录" description="这位客户进入激活名单后，每次入单和推送都会记在这里。" />
              ) : (
                <Timeline entries={view.history} />
              )}
            </Panel>
          </RevealItem>
        </Reveal>
      )}
      {editing && view && (
        <SummaryDialog
          id={id}
          initial={view.summary}
          onClose={() => setEditing(false)}
          onSaved={(s) => {
            setView((v) => (v ? { ...v, summary: s } : v));
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

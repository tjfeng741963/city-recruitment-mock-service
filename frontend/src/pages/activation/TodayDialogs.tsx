import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Button, DescriptionList, Dialog, Icon, Input, Skeleton, useFeedback } from "@ui";
import { activationApi, type ActivationRecord } from "../../api/activation";
import { errText, strategyLabel } from "./shared";

export function ApproveDialog({ record, onClose, onDone }: { record: ActivationRecord; onClose: () => void; onDone: () => void }) {
  const { toast } = useFeedback();
  const [script, setScript] = useState<{ id: number; content: string } | null>(null);
  const [drawing, setDrawing] = useState(true);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const draw = useCallback(async () => {
    setDrawing(true);
    try {
      setScript(await activationApi.randomScript());
      setDrawError(null);
    } catch (err) {
      setScript(null);
      setDrawError(errText(err, "话术库为空或加载失败"));
    } finally {
      setDrawing(false);
    }
  }, []);

  useEffect(() => {
    draw();
  }, [draw]);

  async function approve() {
    setSaving(true);
    try {
      await activationApi.approve(record.id, script?.id ?? null);
      toast(script ? "审核通过，将发送所选话术" : "审核通过，已加入发送队列（发送时随机抽话术）");
      onDone();
    } catch (err) {
      toast(errText(err, "操作失败"), "danger");
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="审核激活"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button loading={saving} onClick={approve}>通过并加入发送队列</Button>
        </>
      }
    >
      <div className="ac-stack">
        <DescriptionList
          items={[
            ["客户", record.nickname || String(record.customer_id)],
            ["策略", strategyLabel(record.strategy)],
            ["停滞", record.stale_days != null ? `${record.stale_days} 天` : "—"],
            ["设备", record.device_name || record.device_code || "—"],
          ]}
        />
        <section className="ac-stack-sm">
          <h4 className="ac-label">AI 摘要（激活依据）</h4>
          <p className="ac-box">{record.summary || "暂无摘要"}</p>
        </section>
        <section className="ac-stack-sm">
          <div className="ac-row-between">
            <h4 className="ac-label">话术预览</h4>
            <Button size="sm" variant="ghost" icon={<Icon name="refresh" size={14} />} disabled={drawing} onClick={draw}>换一条</Button>
          </div>
          {drawing ? <Skeleton height={48} /> : <p className="ac-box">{script?.content ?? drawError ?? "（没有可用话术）"}</p>}
        </section>
        <Alert tone="accent" title="发送内容即上面这条话术">点「换一条」可更换；客户回复后仍由原 Dify 对话接管。</Alert>
      </div>
    </Dialog>
  );
}

const DEFAULT_FREEZE_DAYS = 14;

export function FreezeDialog({
  records,
  onClose,
  onDone,
}: {
  records: ActivationRecord[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useFeedback();
  const [days, setDays] = useState(String(DEFAULT_FREEZE_DAYS));
  const [saving, setSaving] = useState(false);
  const n = Number(days);
  const invalid = !/^\d+$/.test(days) || n < 1;
  const single = records.length === 1 ? records[0] : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setSaving(true);
    let failed = 0;
    for (const r of records) {
      try {
        await activationApi.freeze(r.id, n);
      } catch {
        failed += 1;
      }
    }
    const okCount = records.length - failed;
    if (okCount) toast(single ? `已冷冻 ${n} 天：${single.nickname || single.customer_id}` : `已批量冷冻 ${okCount} 条，${n} 天`);
    if (failed) toast(`冷冻失败 ${failed} 条`, "danger");
    onDone();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={single ? `冷冻「${single.nickname || single.customer_id}」` : `批量冷冻 ${records.length} 条`}
      description="冷冻期间完全不发送，到期自动解冻。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="ac-freeze-form" loading={saving} disabled={invalid}>冷冻</Button>
        </>
      }
    >
      <form id="ac-freeze-form" className="mod-form" noValidate onSubmit={submit}>
        <Input
          id="ac-freeze-days"
          type="number"
          min={1}
          label="冷冻天数"
          required
          value={days}
          onChange={(e) => setDays(e.target.value)}
          error={invalid ? "请输入大于 0 的整数天数" : undefined}
        />
      </form>
    </Dialog>
  );
}

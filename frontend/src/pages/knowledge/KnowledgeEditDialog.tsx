import { useEffect, useState, type FormEvent } from "react";
import { knowledgeApi, type KnowledgeInput } from "../../api/knowledge";
import { Alert, Button, Dialog, Input, Skeleton, Switch, Textarea, useFeedback } from "@ui";
import { KeywordInput, errorText } from "./shared";

const EMPTY: KnowledgeInput = { question: "", answer: "", keywords: [], sort_order: 0, is_active: true };

interface Errors {
  question?: string;
  answer?: string;
  sort?: string;
}

/** Create (id undefined) or edit one knowledge entry in a side sheet. */
export function KnowledgeEditDialog({ id, onClose, onSaved }: { id?: number; onClose: () => void; onSaved: () => void }) {
  const { toast } = useFeedback();
  const isEdit = id !== undefined;
  const [form, setForm] = useState<KnowledgeInput | null>(isEdit ? null : EMPTY);
  const [sortText, setSortText] = useState("0");
  // The detail endpoint may not return the stored answer; then an empty answer means "keep it".
  const [answerKnown, setAnswerKnown] = useState(!isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (id === undefined) return;
    let alive = true;
    setLoadError(null);
    knowledgeApi
      .get(id)
      .then((item) => {
        if (!alive) return;
        setAnswerKnown(typeof item.answer === "string");
        setForm({ question: item.question, answer: item.answer ?? "", keywords: item.keywords ?? [], sort_order: item.sort_order, is_active: item.is_active });
        setSortText(String(item.sort_order ?? 0));
      })
      .catch((err) => alive && setLoadError(errorText(err, "没能读取这条知识")));
    return () => {
      alive = false;
    };
  }, [id, attempt]);

  function validate(f: KnowledgeInput): Errors {
    const next: Errors = {};
    if (!f.question.trim()) next.question = "请填写问题";
    if (answerKnown && !(f.answer ?? "").trim()) next.answer = "请填写回答";
    if (!/^\d+$/.test(sortText.trim())) next.sort = "请填 0 或正整数";
    return next;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    const answer = (form.answer ?? "").trim();
    const payload: KnowledgeInput = {
      question: form.question.trim(),
      keywords: form.keywords,
      sort_order: Number(sortText.trim()),
      is_active: form.is_active,
      ...(answer ? { answer } : {}),
    };
    setSaving(true);
    setSaveError(null);
    try {
      if (id === undefined) await knowledgeApi.create(payload);
      else await knowledgeApi.update(id, payload);
      toast(isEdit ? "已保存" : "已添加知识", "success");
      onSaved();
    } catch (err) {
      setSaveError(errorText(err, isEdit ? "保存失败" : "添加失败"));
      setSaving(false);
    }
  }

  const patch = (p: Partial<KnowledgeInput>) => form && setForm({ ...form, ...p });

  return (
    <Dialog
      open
      variant="sheet"
      onClose={onClose}
      title={isEdit ? "编辑知识" : "添加知识"}
      description="AI 遇到相同或相近的问题时，会用这里的回答回复候选人。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="kn-edit-form" loading={saving} disabled={!form}>保存</Button>
        </>
      }
    >
      {loadError ? (
        <Alert tone="danger" title="没能读取这条知识" action={<Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>重试</Button>}>
          {loadError}
        </Alert>
      ) : !form ? (
        <div className="kn-sheet-skeleton">
          <Skeleton height={40} />
          <Skeleton height={40} />
          <Skeleton height={120} />
        </div>
      ) : (
        <form id="kn-edit-form" className="mod-form" onSubmit={submit} noValidate>
          <Input
            id="kn-question"
            label="问题"
            required
            placeholder="例如：什么时候转正"
            value={form.question}
            error={errors.question}
            onChange={(e) => patch({ question: e.target.value })}
            autoFocus
          />
          <Textarea
            id="kn-answer"
            label="回答"
            required={answerKnown}
            rows={6}
            placeholder={answerKnown ? "输入回答内容" : "留空表示保留原来的回答"}
            helperText={answerKnown ? undefined : "系统没有返回原来的回答。填写后会覆盖，留空则不改。"}
            value={form.answer ?? ""}
            error={errors.answer}
            onChange={(e) => patch({ answer: e.target.value })}
          />
          <KeywordInput id="kn-keywords" value={form.keywords} onChange={(keywords) => patch({ keywords })} />
          <Input
            id="kn-sort"
            label="排序"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            helperText="数字越小越靠前"
            value={sortText}
            error={errors.sort}
            onChange={(e) => setSortText(e.target.value)}
          />
          <Switch
            id="kn-active"
            label="启用"
            description="关闭后 AI 不会使用这条知识"
            checked={form.is_active}
            onChange={(e) => patch({ is_active: e.target.checked })}
          />
          {saveError && <p className="mod-error" role="alert">{saveError}</p>}
        </form>
      )}
    </Dialog>
  );
}

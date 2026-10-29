import { useState, type FormEvent } from "react";
import { knowledgeApi, type KnowledgeBatchPatch, type KnowledgeExportItem } from "../../api/knowledge";
import { Alert, Button, Dialog, FileDrop, Input, Select, useFeedback } from "@ui";
import { errorText } from "./shared";

/** Accepts the same three shapes the old page did: [{question,answer}], {knowledge:{问:答}}, {问:答}. */
export function parseImportJson(text: string): KnowledgeExportItem[] | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "文件不是有效的 JSON，请检查格式。";
  }
  let items: KnowledgeExportItem[] = [];
  if (Array.isArray(data)) {
    items = data.filter((x): x is KnowledgeExportItem => Boolean(x) && typeof x === "object" && typeof (x as { question?: unknown }).question === "string");
  } else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const source = record.knowledge && typeof record.knowledge === "object" ? (record.knowledge as Record<string, unknown>) : record;
    const fromNested = source !== record;
    items = Object.entries(source)
      .filter(([, v]) => fromNested || typeof v === "string")
      .map(([question, answer]) => ({ question, answer: String(answer) }));
  }
  if (!items.length) return "没有识别出知识条目。支持的格式：[{question, answer}]、{knowledge: {问题: 回答}} 或 {问题: 回答}。";
  return items;
}

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { toast } = useFeedback();
  const [items, setItems] = useState<KnowledgeExportItem[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onFile(file: File) {
    setError(null);
    const result = parseImportJson(await file.text());
    if (typeof result === "string") {
      setItems(null);
      setParseError(result);
    } else {
      setItems(result);
      setParseError(null);
    }
  }

  async function submit() {
    if (!items?.length) return;
    setSaving(true);
    setError(null);
    try {
      const res = await knowledgeApi.importItems(items);
      toast(`导入完成：新增 ${res.created ?? 0} 条，跳过 ${res.skipped ?? 0} 条`, "success");
      onImported();
    } catch (err) {
      setError(errorText(err, "导入失败"));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="导入知识"
      description="选择一个 JSON 文件，确认条数后导入。问题已存在的条目会跳过。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button onClick={submit} loading={saving} disabled={!items?.length}>确认导入</Button>
        </>
      }
    >
      <div className="mod-form">
        <FileDrop accept=".json,application/json" label="拖入 JSON 文件，或点击选择" hint='格式：[{"question": "...", "answer": "...", "keywords": [...]}]' onFile={onFile} />
        {parseError && <Alert tone="danger" title={parseError} />}
        {items && (
          <p className="kn-note" role="status">
            识别出 <strong className="ui-num">{items.length}</strong> 条知识
          </p>
        )}
        {error && (
          <Alert tone="danger" title="导入失败">
            {error}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

const STATUS_OPTIONS = [
  { value: "", label: "不修改" },
  { value: "true", label: "启用" },
  { value: "false", label: "停用" },
];

export function BatchUpdateDialog({ ids, onClose, onUpdated }: { ids: number[]; onClose: () => void; onUpdated: () => void }) {
  const { toast } = useFeedback();
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const patch: KnowledgeBatchPatch = {};
    if (status) patch.is_active = status === "true";
    if (sort.trim()) {
      if (!/^\d+$/.test(sort.trim())) {
        setFieldError("请填 0 或正整数");
        return;
      }
      patch.sort_order = Number(sort.trim());
    }
    setFieldError(undefined);
    if (!Object.keys(patch).length) {
      setError("请至少改一项");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await knowledgeApi.batchUpdate(ids, patch);
      toast(`已修改 ${res.updated} 条`, "success");
      onUpdated();
    } catch (err) {
      setError(errorText(err, "批量修改失败"));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`批量修改 ${ids.length} 条知识`}
      description="留空的项不做修改。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="kn-batch-form" loading={saving}>确认修改</Button>
        </>
      }
    >
      <form id="kn-batch-form" className="mod-form" onSubmit={submit} noValidate>
        <Select id="kn-batch-status" label="状态" options={STATUS_OPTIONS} value={status} onChange={(e) => setStatus(e.target.value)} />
        <Input
          id="kn-batch-sort"
          label="排序"
          type="number"
          min={0}
          step={1}
          placeholder="不修改"
          value={sort}
          error={fieldError}
          onChange={(e) => setSort(e.target.value)}
        />
        {error && <Alert tone="danger" title={error} />}
      </form>
    </Dialog>
  );
}

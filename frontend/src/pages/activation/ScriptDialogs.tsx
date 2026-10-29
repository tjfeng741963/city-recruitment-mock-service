import { useState, type FormEvent } from "react";
import { Alert, Button, Dialog, FileDrop, Icon, Input, Switch, Textarea, useFeedback } from "@ui";
import { activationApi, type ImportResult, type Script } from "../../api/activation";
import { errText } from "./shared";

const CONTENT_MAX = 1000;
const EXPORT_NAME = "复聊话术_export.xlsx";

export function ScriptDialog({ script, onClose, onSaved }: { script: Script | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useFeedback();
  const [content, setContent] = useState(script?.content ?? "");
  const [category, setCategory] = useState(script?.category ?? "");
  const [active, setActive] = useState(script?.is_active ?? true);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = !content.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (empty) return;
    const input = { content, category: category.trim(), is_active: active };
    setSaving(true);
    setError(null);
    try {
      if (script) await activationApi.updateScript(script.id, input);
      else await activationApi.createScript(input);
      toast(script ? "话术已保存" : "话术已新增");
      onSaved();
    } catch (err) {
      setError(errText(err, "保存失败"));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={script ? "编辑话术" : "新增话术"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="ac-script-form" loading={saving}>保存</Button>
        </>
      }
    >
      <form id="ac-script-form" className="mod-form" noValidate onSubmit={submit}>
        <Textarea
          id="ac-script-content"
          label="话术内容"
          required
          rows={5}
          maxLength={CONTENT_MAX}
          placeholder="作为激活首条消息发给客户，支持多行"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          error={touched && empty ? "话术内容不能为空" : undefined}
          helperText={`${content.length} / ${CONTENT_MAX}`}
        />
        <Input id="ac-script-category" label="分类" placeholder="选填，便于分组管理（如：开场白、岗位推荐）" value={category} onChange={(e) => setCategory(e.target.value)} />
        <Switch id="ac-script-active" label="启用" description="停用后不参与随机抽取" checked={active} onChange={(e) => setActive(e.target.checked)} />
        {error && <p className="mod-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportExportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { toast } = useFeedback();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function exportAll() {
    setExporting(true);
    try {
      download(await activationApi.exportScripts(), EXPORT_NAME);
      toast("已开始下载");
    } catch (err) {
      toast(`导出失败：${errText(err, "请稍后重试")}`, "danger");
    } finally {
      setExporting(false);
    }
  }

  function pickFile(f: File) {
    setResult(null);
    if (!f.name.toLowerCase().endsWith(".xlsx")) {
      setFile(null);
      setFileError("只能上传 .xlsx 文件（从上方导出的 Excel 修改后导入）");
      return;
    }
    setFileError(null);
    setFile(f);
  }

  async function importFile() {
    if (!file) return;
    setImporting(true);
    try {
      const r = await activationApi.importScripts(file);
      setResult(r);
      toast("导入完成");
      onImported();
    } catch (err) {
      toast(errText(err, "导入失败"), "danger");
    } finally {
      setImporting(false);
    }
  }

  const hasErrors = Boolean(result?.errors?.length);

  return (
    <Dialog
      open
      onClose={onClose}
      title="复聊话术 · 导出 / 导入"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>关闭</Button>
          <Button loading={importing} disabled={!file} onClick={importFile}>开始导入</Button>
        </>
      }
    >
      <div className="ac-stack">
        <section className="ac-stack-sm">
          <h4 className="ac-label">导出</h4>
          <div>
            <Button variant="secondary" loading={exporting} icon={<Icon name="download" size={14} />} onClick={exportAll}>下载全部话术</Button>
          </div>
          <p className="ac-muted">
            Excel 内含「填写说明」。操作列：新增 = 添加话术（内容必填）；修改 = 按 ID 更新（填了才改）；删除 = 按 ID 删除；已有或留空 = 不改。
          </p>
        </section>
        <section className="ac-stack-sm">
          <h4 className="ac-label">导入</h4>
          <FileDrop accept=".xlsx" label="拖拽 .xlsx 文件到这里，或点击选择" hint="只能上传一个 .xlsx 文件" onFile={pickFile} />
          {fileError && <p className="mod-error" role="alert">{fileError}</p>}
        </section>
        {result && (
          <Alert tone={hasErrors ? "warning" : "success"} title={hasErrors ? "导入完成，部分数据有问题" : "导入成功"}>
            新增 {result.created ?? 0} 条，修改 {result.updated ?? 0} 条{result.skipped ? `，跳过 ${result.skipped} 条` : ""}。
            {hasErrors && (
              <ul className="ac-errors">
                {result.errors!.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

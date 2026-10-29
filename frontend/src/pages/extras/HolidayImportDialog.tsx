import { useState } from "react";
import { Alert, Button, Dialog, FileDrop, Icon, useFeedback } from "@ui";
import { holidayApi, type ImportResult } from "../../api/extras";
import { errorText, saveBlob } from "./model";

const HINT = "表里每行的「操作」列：新增 = 添加节假日（年份和起止日期必填）；删除 = 删掉这条（年份必填，日期不填则删掉同名节日的全部日期）；留空或「已有」= 不改。";

// Bulk edit of per-position holidays through the Excel round trip used by the old 岗位 page.
export function HolidayImportDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useFeedback();
  const [file, setFile] = useState<File | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function exportFile() {
    setExporting(true);
    setFailure(null);
    try {
      saveBlob(await holidayApi.exportPositionHolidays(), "岗位节假日.xlsx");
    } catch (err) {
      setFailure(errorText(err, "下载失败，请重试"));
    } finally {
      setExporting(false);
    }
  }

  async function importFile() {
    if (!file) return;
    setImporting(true);
    setFailure(null);
    try {
      const r = await holidayApi.importPositionHolidays(file);
      setResult(r);
      toast("导入完成");
    } catch (err) {
      setFailure(errorText(err, "导入失败，请检查文件后重试"));
    } finally {
      setImporting(false);
    }
  }

  const errors = result?.errors ?? [];
  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>关闭</Button>
      <Button loading={importing} disabled={!file} onClick={importFile}>开始导入</Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title="岗位节假日 导出 / 导入" footer={footer}>
      <div className="ex-form">
        <section className="ex-import-step">
          <h4>1. 下载表格</h4>
          <p className="ex-muted">包含本账号全部岗位的节假日，表内附「填写说明」。</p>
          <Button variant="secondary" size="sm" icon={<Icon name="download" size={15} />} loading={exporting} onClick={exportFile}>
            下载岗位节假日
          </Button>
        </section>
        <section className="ex-import-step">
          <h4>2. 改好后上传</h4>
          <p className="ex-muted">{HINT}</p>
          <FileDrop
            accept=".xlsx"
            label="拖入 .xlsx 文件，或点击选择"
            hint="只支持从上面下载的表格改过的文件"
            onFile={(f) => {
              setFile(f);
              setResult(null);
            }}
          />
        </section>
        {failure && <Alert tone="danger" title={failure} />}
        {result && (
          <Alert tone={errors.length ? "warning" : "success"} title={errors.length ? "导入完成，部分行有问题" : "导入成功"}>
            新增 {result.created ?? 0} 条，删除 {result.updated ?? 0} 条{result.skipped ? `，跳过 ${result.skipped} 条` : ""}
            {errors.length > 0 && (
              <ul className="ex-import-errors">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

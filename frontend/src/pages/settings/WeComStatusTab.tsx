import { useCallback, useEffect, useState } from "react";
import { wecomApi, type WeComStatus, type WeComSyncResult } from "../../api/wecom";
import { ApiError } from "../../api/client";
import { Alert, Badge, Button, Skeleton } from "@ui";

function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function useWeComStatus() {
  const [status, setStatus] = useState<WeComStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await wecomApi.status());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "加载企业微信状态失败");
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { status, error, refresh };
}

export function WeComStatusTab() {
  const { status, error, refresh } = useWeComStatus();
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<WeComSyncResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  async function runSync() {
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      setRunResult(await wecomApi.run());
      await refresh();
    } catch (err) {
      setRunError(err instanceof ApiError ? err.detail : "同步失败");
    } finally {
      setRunning(false);
    }
  }

  if (!status) return error ? <Alert tone="danger" title={error} /> : <Skeleton width="70%" height={24} />;

  return (
    <section className="st-section" aria-label="企业微信通道状态">
      <div className="st-section-head">
        <div>
          <h2 className="ps-form-title">企业微信客服通道</h2>
          <p className="st-note">这里展示服务端当前配置和同步游标；未完成配置时，入站消息会保留在队列中，不会发送 Mock 回复。</p>
        </div>
        {status.enabled && (
          <Button size="sm" loading={running} onClick={runSync}>手动同步</Button>
        )}
      </div>
      {error && <Alert tone="danger" title={error} />}
      {runError && <Alert tone="danger" title={runError} />}
      {runResult && <Alert tone="success" title={`同步完成：收到 ${runResult.received} 条，处理 ${runResult.processed} 条`} />}

      {!status.enabled ? (
        <div className="ps-form-card">
          <div className="st-item-head">
            <span className="st-item-name">未启用</span>
            <Badge tone="warning" dot>等待配置</Badge>
          </div>
          <p className="st-note">请在部署环境设置以下变量后重启 Node 服务：</p>
          <ul className="st-note">
            {status.missing.map((name) => <li key={name}><code>{name}</code></li>)}
          </ul>
        </div>
      ) : (
        <>
          <div className="st-tags">
            <Badge tone="success" dot>已启用</Badge>
            <Badge tone={status.auto_reply_ready ? "success" : "warning"} dot>
              {status.auto_reply_ready ? "自动回复已就绪" : "自动回复已阻断"}
            </Badge>
            <Badge tone="neutral">Dify：{status.dify_provider}</Badge>
          </div>
          <dl className="ps-form-card wecom-status-grid">
            <div><dt>企业 ID</dt><dd><code>{status.corp_id}</code></dd></div>
            <div><dt>客服账号</dt><dd><code>{status.open_kfid}</code></dd></div>
            <div><dt>绑定设备</dt><dd><code>{status.device_code}</code></dd></div>
            <div><dt>同步游标</dt><dd><code>{status.connection.cursor || "（尚未同步）"}</code></dd></div>
            <div><dt>最近同步</dt><dd>{formatTime(status.connection.last_sync_at)}</dd></div>
            <div><dt>最近错误</dt><dd>{status.connection.last_error || "无"}</dd></div>
          </dl>
          {!status.auto_reply_ready && <Alert tone="warning" title={status.auto_reply_blocked_reason ?? "自动回复尚未就绪"} />}
        </>
      )}
    </section>
  );
}

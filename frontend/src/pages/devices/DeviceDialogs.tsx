import { useState, type FormEvent } from "react";
import { devicesApi, type DeviceDetail } from "../../api/admin";
import { ApiError } from "../../api/client";
import { Button, Dialog, Input } from "@ui";

const CODE_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

export function BindDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (device: DeviceDetail) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const codeError = code && !CODE_PATTERN.test(code) ? "只能用字母、数字、- 和 _，3–64 位" : undefined;
  const valid = Boolean(name.trim()) && CODE_PATTERN.test(code);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await devicesApi.create(code, name.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "创建失败");
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="绑定新号"
      description="先登记这个号，下一步拿到连接口令，填到装微信的那台电脑上。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="dv-bind" loading={saving} disabled={!valid}>下一步</Button>
        </>
      }
    >
      <form id="dv-bind" className="mod-form" onSubmit={submit}>
        <Input id="dv-name" label="名称" placeholder="客服 3 号" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <Input
          id="dv-code"
          label="设备编号"
          placeholder="device-003"
          helperText="设备端 REA_DEVICE_CODE 填同一个值，之后不能改"
          value={code}
          onChange={(e) => setCode(e.target.value.trim())}
          error={codeError}
          required
        />
        {error && <p className="mod-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

export function PairDialog({ device, onClose }: { device: DeviceDetail; onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const envText = token ? `REA_DEVICE_CODE=${device.device_code}\nREA_DEVICE_TOKEN=${token}` : "";

  async function pair() {
    setWorking(true);
    setError(null);
    try {
      setToken((await devicesApi.pair(device.device_code)).device_token);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "生成失败");
    } finally {
      setWorking(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(envText);
      setCopied(true);
    } catch {
      setError("浏览器不让复制，请手动选中上面两行");
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={token ? "连接口令已生成" : `给「${device.name || device.device_code}」生成连接口令`}
      description={
        token
          ? "把下面两行填进设备端的 .env，然后重启设备程序。二维码会出现在那台电脑上，用要接入的微信扫码。口令只显示这一次。"
          : "生成新口令后旧口令立刻失效：如果这个号正在运行，会马上掉线，还没发出的消息会记为发送失败。只在第一次接入或口令丢失时使用。"
      }
      footer={
        token ? (
          <>
            <Button variant="secondary" onClick={copy}>{copied ? "已复制" : "复制"}</Button>
            <Button onClick={onClose}>完成</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>取消</Button>
            <Button variant="destructive" loading={working} onClick={pair}>生成新口令</Button>
          </>
        )
      }
    >
      {token && <pre className="dv-env">{envText}</pre>}
      {error && <p className="mod-error" role="alert">{error}</p>}
    </Dialog>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { devicesApi, type DeviceDetail } from "../../api/admin";
import { ApiError } from "../../api/client";
import { Alert, Button, Dialog, Input, Select } from "@ui";

const CODE_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

// 设备码字符集：去掉容易看错的 0/O/1/I/L，前缀 AG- 便于人工识别。
// 与客户端 register.py 自动注册的 pc-xxxx 前缀区分开：AG- 表示人工指定。
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_PREFIX = "AG-";
const CODE_LENGTH = 6;

function generateDeviceCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return CODE_PREFIX + out;
}

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
        <div className="mod-form-row">
          <Input
            id="dv-code"
            label="设备编号"
            placeholder="AG-7XK2M9"
            helperText="设备端 REA_DEVICE_CODE 填同一个值，之后不能改"
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
            error={codeError}
            required
          />
          <Button variant="secondary" onClick={() => setCode(generateDeviceCode())}>
            自动生成
          </Button>
        </div>
        {error && <Alert tone="danger" title={error} />}
      </form>
    </Dialog>
  );
}

export function LocationDialog({ device, onClose, onSaved }: { device: DeviceDetail; onClose: () => void; onSaved: () => void }) {
  const [factory, setFactory] = useState(device.factory_name ?? "");
  const [city, setCity] = useState(device.city ?? "");
  const [verticalId, setVerticalId] = useState(String(device.vertical_id ?? ""));
  const [verticals, setVerticals] = useState<Array<{ id: number; code: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 品类来自 vertical 表（工厂/地铁/物流/RPO/日结）。一个微信号只做一个板块，
  // 所以这里是必选——没有「综合号」，HR 明确说过大方向是定死的。
  useEffect(() => {
    let alive = true;
    adminApi
      .verticals()
      .then((res) => { if (alive) setVerticals((res.items ?? []).map((v) => ({ id: Number(v.id), code: String(v.code), name: String(v.name) }))); })
      .catch(() => { /* 拉不到列表时不阻塞，运营仍可保存其它字段 */ });
    return () => { alive = false; };
  }, []);

  const selected = verticals.find((v) => String(v.id) === verticalId);
  const verticalError = !verticalId ? "必须选择一个板块" : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!verticalId) return;
    setSaving(true);
    setError(null);
    try {
      await devicesApi.saveLocation(device.id, factory.trim(), city.trim(), Number(verticalId));
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "保存失败");
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`「${device.name || device.device_code}」的账号定位`}
      description="一个微信号只做一个板块。选定后，进线客户会直接收到该板块的岗位卡，不问方向。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="dv-location" loading={saving} disabled={!verticalId}>保存</Button>
        </>
      }
    >
      <form id="dv-location" className="mod-form" onSubmit={submit}>
        <Select
          id="dv-vertical"
          label="板块"
          helperText="决定这个号推哪类岗位，改完约 30 秒生效"
          value={verticalId}
          onChange={(e) => setVerticalId(e.target.value)}
          error={verticalError}
          options={verticals.map((v) => ({ value: String(v.id), label: v.name }))}
          placeholder="请选择"
          required
        />
        <Input
          id="dv-factory"
          label={selected?.code === "subway" ? "线路/站点（可选）" : "所属工厂"}
          placeholder={selected?.code === "subway" ? "留空 = 该城市全部" : "留空 = 该板块全部"}
          value={factory}
          onChange={(e) => setFactory(e.target.value)}
        />
        <Input id="dv-city" label="服务城市" placeholder="留空 = 不限城市" value={city} onChange={(e) => setCity(e.target.value)} />
        {error && <Alert tone="danger" title={error} />}
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
      {error && <Alert tone="danger" title={error} />}
    </Dialog>
  );
}

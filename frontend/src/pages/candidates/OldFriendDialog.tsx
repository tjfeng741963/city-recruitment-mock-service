import { useState } from "react";
import { Alert, Button, Dialog, Input, RadioGroup, Select } from "@ui";
import { oldFriendsApi, type MyDevice } from "../../api/candidates";
import { errorText } from "./shared";

type Errors = Partial<Record<"device" | "customer", string>>;

export function AddOldFriendDialog({ devices, onClose, onDone }: { devices: MyDevice[]; onClose: () => void; onDone: () => void }) {
  const [device, setDevice] = useState(devices[0]?.device_code ?? "");
  const [customerId, setCustomerId] = useState("");
  const [nickname, setNickname] = useState("");
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState("unreleased");
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    const next: Errors = {};
    if (!device) next.device = "请选择微信号";
    if (!customerId.trim()) next.customer = "请填写客户 ID";
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    setFailure(null);
    try {
      await oldFriendsApi.mark({ device_code: device, customer_id: customerId.trim(), nickname: nickname.trim(), account: account.trim(), status });
      onDone();
    } catch (err) {
      setFailure(errorText(err, "没能添加，请稍后再试"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="添加老朋友"
      description="标成老朋友后，AI 不会自动回复这个人，需要时再手动放行。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>取消</Button>
          <Button onClick={submit} loading={saving}>添加</Button>
        </>
      }
    >
      <div className="cd-form">
        {failure && <Alert tone="danger" title={failure} />}
        <Select
          id="of-device"
          label="微信号"
          required
          value={device}
          error={errors.device}
          onChange={(e) => setDevice(e.target.value)}
          placeholder={devices.length ? undefined : "还没有可用的微信号"}
          options={devices.map((d) => ({ value: d.device_code, label: d.name || d.device_code }))}
        />
        <Input id="of-customer" label="客户 ID" required value={customerId} error={errors.customer} onChange={(e) => setCustomerId(e.target.value)} />
        <Input id="of-nickname" label="昵称" value={nickname} onChange={(e) => setNickname(e.target.value)} />
        <Input id="of-account" label="招聘员" value={account} onChange={(e) => setAccount(e.target.value)} />
        <RadioGroup
          name="of-status"
          legend="添加后"
          value={status}
          onChange={setStatus}
          options={[
            { value: "unreleased", label: "不可聊", description: "AI 不回复" },
            { value: "released", label: "可聊", description: "AI 照常回复" },
          ]}
        />
      </div>
    </Dialog>
  );
}

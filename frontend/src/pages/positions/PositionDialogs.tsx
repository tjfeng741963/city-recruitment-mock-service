import { useState, type FormEvent, type ReactNode } from "react";
import { positionsApi, type Position } from "../../api/admin";
import { ApiError, type City } from "../../api/client";
import { Button, Dialog, Input } from "../../components/ui";
import { UNGROUPED } from "./model";

function FormDialog({
  id,
  title,
  description,
  valid,
  onClose,
  onSubmit,
  children,
}: {
  id: string;
  title: string;
  description: string;
  valid: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  children: ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "保存失败");
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form={id} loading={saving} disabled={!valid}>创建</Button>
        </>
      }
    >
      <form id={id} className="mod-form" onSubmit={submit}>
        {children}
        {error && <p className="mod-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

export function CreateCityDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (city: City) => void }) {
  const [name, setName] = useState("");
  const [province, setProvince] = useState("");
  return (
    <FormDialog
      id="ps-new-city"
      title="新建城市"
      description="建好后默认是招聘中。面试地点、社保、线路等详细信息可以之后在原页面补。"
      valid={Boolean(name.trim())}
      onClose={onClose}
      onSubmit={async () => onCreated(await positionsApi.createCity(name.trim(), province.trim()))}
    >
      <Input id="ps-city-name" label="城市" placeholder="苏州" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      <Input id="ps-city-province" label="省份" placeholder="江苏" value={province} onChange={(e) => setProvince(e.target.value)} />
    </FormDialog>
  );
}

export function CreatePositionDialog({
  city,
  stores,
  onClose,
  onCreated,
}: {
  city: City;
  stores: string[];
  onClose: () => void;
  onCreated: (position: Position) => void;
}) {
  const [name, setName] = useState("");
  const [store, setStore] = useState("");
  const known = stores.filter((s) => s !== UNGROUPED);
  return (
    <FormDialog
      id="ps-new-position"
      title={`在${city.city_name}新建岗位`}
      description="先填名称和工厂，创建后进入编辑页填工价和要求。"
      valid={Boolean(name.trim())}
      onClose={onClose}
      onSubmit={async () => onCreated(await positionsApi.createPosition(name.trim(), store.trim(), city))}
    >
      <Input id="ps-pos-name" label="岗位名称" placeholder="长白班普工" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      <Input
        id="ps-pos-store"
        label="工厂"
        placeholder="富士康龙华"
        helperText={known.length ? "可以选已有工厂，也可以填新的" : undefined}
        list="ps-store-options"
        value={store}
        onChange={(e) => setStore(e.target.value)}
      />
      <datalist id="ps-store-options">
        {known.map((s) => <option key={s} value={s} />)}
      </datalist>
    </FormDialog>
  );
}

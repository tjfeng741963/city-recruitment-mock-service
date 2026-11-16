import { useState, type FormEvent, type ReactNode } from "react";
import { positionsApi, type Factory, type Position } from "../../api/admin";
import { ApiError, type City } from "../../api/client";
import { Alert, Button, Dialog, Input, Select } from "@ui";

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
        {error && <Alert tone="danger" title={error} />}
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
  factories,
  onFactoryCreated,
  onClose,
  onCreated,
}: {
  city: City;
  factories: Factory[];
  onFactoryCreated: () => Promise<void>;
  onClose: () => void;
  onCreated: (position: Position) => void;
}) {
  const [name, setName] = useState("");
  const [factoryId, setFactoryId] = useState("");
  const [newFactory, setNewFactory] = useState("");
  const [creatingFactory, setCreatingFactory] = useState(false);
  const [factoryError, setFactoryError] = useState<string | null>(null);

  async function addFactory() {
    const factoryName = newFactory.trim();
    if (!factoryName) return;
    setCreatingFactory(true);
    setFactoryError(null);
    try {
      const factory = await positionsApi.createFactory(factoryName, city.id);
      await onFactoryCreated();
      setFactoryId(String(factory.id));
      setNewFactory("");
    } catch (err) {
      setFactoryError(err instanceof ApiError ? err.detail : "厂区创建失败");
    } finally {
      setCreatingFactory(false);
    }
  }

  const selected = factories.find((f) => String(f.id) === factoryId);
  return (
    <FormDialog
      id="ps-new-position"
      title={`在${city.city_name}新建岗位`}
      description="先选厂区再填岗位名。AI 回答候选人时按厂区取岗位，没挂厂区的岗位不会被念出来。"
      valid={Boolean(name.trim() && factoryId)}
      onClose={onClose}
      onSubmit={async () => {
        if (!selected) return;
        await onCreated(await positionsApi.createPosition(name.trim(), selected.factory_name, city, selected.id));
      }}
    >
      <Input id="ps-pos-name" label="岗位名称" placeholder="长白班普工" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      {factories.length ? (
        <Select
          id="ps-pos-factory"
          label="厂区"
          required
          placeholder="先选厂区"
          options={factories.map((f) => ({ value: String(f.id), label: f.factory_name }))}
          value={factoryId}
          onChange={(e) => setFactoryId(e.target.value)}
        />
      ) : (
        <p className="ps-form-hint">{city.city_name}还没有厂区，先在下面建一个。</p>
      )}
      <div className="ui-row">
        <Input id="ps-pos-new-factory" label={`在${city.city_name}新建厂区`} placeholder="富士康龙华" value={newFactory} onChange={(e) => setNewFactory(e.target.value)} />
        <Button type="button" variant="secondary" size="sm" disabled={!newFactory.trim()} loading={creatingFactory} onClick={addFactory}>建厂区</Button>
      </div>
      {factoryError && <Alert tone="danger" title={factoryError} />}
    </FormDialog>
  );
}


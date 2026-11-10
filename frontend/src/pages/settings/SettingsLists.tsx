import { useCallback, useEffect, useState, type FormEvent } from "react";
import { positionsApi, settingsApi, type AdminUser, type Recruiter } from "../../api/admin";
import { ApiError, type City } from "../../api/client";
import { Alert, Badge, Button, Dialog, EmptyState, Input, Select, Skeleton, Tag } from "@ui";

const ROLE_LABEL: Record<AdminUser["role"], string> = { admin: "管理员", customer: "运营", recruiter: "招聘员" };

function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "加载失败");
    }
  }, [load]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, error, setError, refresh };
}

const loadRecruiters = async () => {
  const [recruiters, cities] = await Promise.all([settingsApi.recruiters(), positionsApi.cities()]);
  return { recruiters: recruiters.items, cities: cities.items };
};

function RecruiterRow({
  recruiter,
  cities,
  editable,
  onChange,
}: {
  recruiter: Recruiter;
  cities: City[];
  editable: boolean;
  onChange: (action: () => Promise<unknown>) => void;
}) {
  const assigned = new Set(recruiter.cities.map((c) => c.id));
  const options = cities.filter((c) => !assigned.has(c.id));
  const label = recruiter.name || recruiter.recruiter_id;
  return (
    <li className="st-item">
      <div className="st-item-head">
        <span className="st-item-name">{label}</span>
        <span className="st-item-sub">{recruiter.recruiter_id}</span>
        {!recruiter.is_active && <Badge tone="neutral">已停用</Badge>}
      </div>
      <div className="st-tags">
        {recruiter.cities.length === 0 && <span className="st-muted">还没分配城市，看不到任何岗位和会话</span>}
        {recruiter.cities.map((c) => (
          <Tag key={c.id} onRemove={editable ? () => onChange(() => settingsApi.removeRecruiterCity(recruiter.id, c.id)) : undefined}>
            {c.city_name}
          </Tag>
        ))}
        {editable && options.length > 0 && (
          <select
            className="st-add-city"
            aria-label={`给${label}加城市`}
            value=""
            onChange={(e) => e.target.value && onChange(() => settingsApi.addRecruiterCity(recruiter.id, Number(e.target.value)))}
          >
            <option value="">+ 加城市</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>{c.city_name}</option>
            ))}
          </select>
        )}
      </div>
    </li>
  );
}

function NewRecruiterDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await settingsApi.createRecruiter(code.trim(), name.trim() || code.trim());
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "创建失败");
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="新建招聘员"
      description="建好后给他分配城市。要让他登录，再到「账号」页开一个账号挂在他下面。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="st-new-rec" loading={saving} disabled={!code.trim()}>创建</Button>
        </>
      }
    >
      <form id="st-new-rec" className="mod-form" onSubmit={submit}>
        <Input id="st-rec-code" label="招聘员编号" placeholder="zhangsan" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
        <Input id="st-rec-name" label="名字" placeholder="张三" value={name} onChange={(e) => setName(e.target.value)} />
        {error && <Alert tone="danger" title={error} />}
      </form>
    </Dialog>
  );
}

export function RecruitersTab({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, setError, refresh } = useLoad(loadRecruiters);
  const [creating, setCreating] = useState(false);

  async function change(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "操作失败");
    }
  }

  if (!data) return error ? <Alert tone="danger" title={error} /> : <Skeleton width="60%" height={22} />;

  return (
    <section className="st-section">
      <div className="st-section-head">
        <p className="st-note">招聘员只能看到分配给他的城市里的岗位和会话。</p>
        {isAdmin && <Button size="sm" onClick={() => setCreating(true)}>新建招聘员</Button>}
      </div>
      {error && <Alert tone="danger" title={error} />}
      {data.recruiters.length === 0 ? (
        <EmptyState icon="users" title="还没有招聘员" description="只有一个运营管所有号和城市时，不需要建招聘员。" />
      ) : (
        <ul className="st-list">
          {data.recruiters.map((r) => (
            <RecruiterRow key={r.id} recruiter={r} cities={data.cities} editable={isAdmin} onChange={change} />
          ))}
        </ul>
      )}
      {creating && <NewRecruiterDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }} />}
    </section>
  );
}

const loadAccounts = async () => {
  const [users, recruiters] = await Promise.all([settingsApi.users(), settingsApi.recruiters()]);
  return { users: users.items, recruiters: recruiters.items };
};

const MIN_PASSWORD = 8;

function NewAccountDialog({ recruiters, onClose, onCreated }: { recruiters: Recruiter[]; onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminUser["role"]>("customer");
  const [recruiterId, setRecruiterId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsRecruiter = role !== "admin";
  const passwordError = password && password.length < MIN_PASSWORD ? `至少 ${MIN_PASSWORD} 位` : undefined;
  const valid = Boolean(username.trim()) && password.length >= MIN_PASSWORD && (!needsRecruiter || Boolean(recruiterId));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await settingsApi.createUser({ username: username.trim(), password, role, recruiter_id: needsRecruiter ? recruiterId : "" });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "创建失败");
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="开账号"
      description="运营和招聘员账号要挂在一个招聘员下面，这决定了他能看哪些城市和微信号。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="st-new-user" loading={saving} disabled={!valid}>创建</Button>
        </>
      }
    >
      <form id="st-new-user" className="mod-form" onSubmit={submit}>
        <Input id="st-user-name" label="登录名" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        <Input id="st-user-pass" type="password" autoComplete="new-password" label="初始密码" value={password} error={passwordError} onChange={(e) => setPassword(e.target.value)} required />
        <Select
          id="st-user-role"
          label="角色"
          value={role}
          onChange={(e) => setRole(e.target.value as AdminUser["role"])}
          options={[{ value: "customer", label: "运营" }, { value: "recruiter", label: "招聘员" }, { value: "admin", label: "管理员" }]}
        />
        {needsRecruiter && (
          <Select
            id="st-user-rec"
            label="挂在哪个招聘员下"
            placeholder={recruiters.length ? "选择招聘员" : "先到「招聘员」页新建一个"}
            value={recruiterId}
            onChange={(e) => setRecruiterId(e.target.value)}
            options={recruiters.map((r) => ({ value: r.recruiter_id, label: r.name || r.recruiter_id }))}
            required
          />
        )}
        {error && <Alert tone="danger" title={error} />}
      </form>
    </Dialog>
  );
}

export function AccountsTab({ selfName }: { selfName: string }) {
  const { data, error, setError, refresh } = useLoad(loadAccounts);
  const [creating, setCreating] = useState(false);
  const [disabling, setDisabling] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);

  async function disable(user: AdminUser) {
    setBusy(true);
    try {
      await settingsApi.disableUser(user.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "停用失败");
    } finally {
      setDisabling(null);
      setBusy(false);
    }
  }

  if (!data) return error ? <Alert tone="danger" title={error} /> : <Skeleton width="60%" height={22} />;

  return (
    <section className="st-section">
      <div className="st-section-head">
        <p className="st-note">这一页只有管理员能看到。</p>
        <Button size="sm" onClick={() => setCreating(true)}>开账号</Button>
      </div>
      {error && <Alert tone="danger" title={error} />}
      <ul className="st-list">
        {data.users.map((u) => (
          <li key={u.id} className={`st-item st-item-row ${u.is_active ? "" : "is-off"}`}>
            <div className="st-item-head">
              <span className="st-item-name">{u.username}</span>
              <Badge tone={u.role === "admin" ? "accent" : "neutral"}>{ROLE_LABEL[u.role]}</Badge>
              {u.recruiter_id && <span className="st-item-sub">{u.recruiter_id}</span>}
              {!u.is_active && <Badge tone="neutral">已停用</Badge>}
            </div>
            {Boolean(u.is_active) && u.username !== selfName && (
              <Button variant="ghost" size="sm" onClick={() => setDisabling(u)}>停用</Button>
            )}
          </li>
        ))}
      </ul>
      {creating && (
        <NewAccountDialog recruiters={data.recruiters} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }} />
      )}
      {disabling && (
        <Dialog
          open
          onClose={() => setDisabling(null)}
          title={`停用「${disabling.username}」？`}
          description="停用后这个账号不能再登录，已有的数据不受影响。"
          footer={
            <>
              <Button variant="secondary" onClick={() => setDisabling(null)}>取消</Button>
              <Button variant="destructive" loading={busy} onClick={() => disable(disabling)}>停用</Button>
            </>
          }
        />
      )}
    </section>
  );
}

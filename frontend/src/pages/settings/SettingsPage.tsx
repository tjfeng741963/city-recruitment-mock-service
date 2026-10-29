import { useEffect, useState, type FormEvent } from "react";
import { settingsApi, type Settings } from "../../api/admin";
import { ApiError } from "../../api/client";
import { Button, Input, Skeleton } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";
import { AccountsTab, RecruitersTab } from "./SettingsLists";

type Tab = "general" | "recruiters" | "accounts";
const TAB_PATH: Record<Tab, string> = { general: "/settings", recruiters: "/recruiters", accounts: "/users" };

interface Draft {
  company: string;
  ageRange: string;
  ageMin: string;
  ageMax: string;
  model: string;
  newKey: string;
}

function toDraft(s: Settings): Draft {
  const { min, max } = s.requirements.age_limit;
  return { company: s.company_name, ageRange: s.requirements.age_range, ageMin: min ? String(min) : "", ageMax: max ? String(max) : "", model: s.dedup_llm_model, newKey: "" };
}

function GeneralTab({ canEdit }: { canEdit: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    settingsApi
      .get()
      .then((s) => {
        setSettings(s);
        setDraft(toDraft(s));
      })
      .catch((err) => setError(err instanceof ApiError ? err.detail : "加载失败"));
  }, []);

  if (!settings || !draft) return error ? <p className="mod-error" role="alert">{error}</p> : <Skeleton width="60%" height={22} />;

  const current = draft;
  const min = Number(current.ageMin || 0);
  const max = Number(current.ageMax || 0);
  const ageError = current.ageMin && current.ageMax && min > max ? "最小年龄不能大于最大年龄" : undefined;
  const field = (key: keyof Draft) => ({
    value: current[key],
    onChange: (e: { target: { value: string } }) => {
      setDraft({ ...current, [key]: e.target.value });
      setSaved(false);
    },
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (ageError) return;
    setSaving(true);
    setError(null);
    try {
      const result = await settingsApi.save({
        company_name: current.company.trim(),
        dedup_llm_model: current.model.trim(),
        requirements: { age_range: current.ageRange.trim(), age_limit: { min, max } },
        ...(current.newKey.trim() ? { dedup_llm_api_key: current.newKey.trim() } : {}),
      });
      setSettings(result);
      setDraft(toDraft(result));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="st-form" onSubmit={save}>
      {!canEdit && <p className="st-note">只有管理员能改这些设置。</p>}
      <fieldset className="ps-form-card" disabled={!canEdit}>
        <legend className="ps-form-title">公司</legend>
        <Input id="st-company" label="公司名称" helperText="AI 自我介绍时会用到" {...field("company")} />
      </fieldset>
      <fieldset className="ps-form-card" disabled={!canEdit}>
        <legend className="ps-form-title">默认招聘要求</legend>
        <Input id="st-age-range" label="年龄说明" placeholder="18-45 岁" helperText="岗位没有单独填年龄时，AI 用这句话回答" {...field("ageRange")} />
        <div className="ps-form-grid">
          <Input id="st-age-min" type="number" min={0} max={99} label="最小年龄" {...field("ageMin")} />
          <Input id="st-age-max" type="number" min={0} max={99} label="最大年龄" error={ageError} {...field("ageMax")} />
        </div>
      </fieldset>
      <fieldset className="ps-form-card" disabled={!canEdit}>
        <legend className="ps-form-title">候选人去重模型</legend>
        <Input id="st-model" label="模型名称" {...field("model")} />
        <Input
          id="st-key"
          type="password"
          autoComplete="new-password"
          label="API Key"
          placeholder={settings.dedup_llm_api_key ? "已设置，留空表示不改" : "未设置"}
          {...field("newKey")}
        />
      </fieldset>
      {error && <p className="mod-error" role="alert">{error}</p>}
      {canEdit && (
        <div className="st-actions">
          {saved && <span className="ps-saved" role="status">已保存</span>}
          <Button type="submit" loading={saving} disabled={Boolean(ageError)}>保存</Button>
        </div>
      )}
    </form>
  );
}

export function SettingsPage({ tab }: { tab: Tab }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const active: Tab = tab === "accounts" && !isAdmin ? "general" : tab;
  const tabs: Array<[Tab, string]> = [["general", "通用"], ["recruiters", "招聘员"]];
  if (isAdmin) tabs.push(["accounts", "账号"]);

  return (
    <div className="mod-page mod-narrow">
      <header className="mod-head">
        <h1>设置</h1>
        <nav className="mod-tabs" aria-label="设置页签">
          {tabs.map(([key, label]) =>
            key === active ? (
              <span key={key} className="mod-tab is-active" aria-current="page">{label}</span>
            ) : (
              <a key={key} className="mod-tab" href={TAB_PATH[key]}>{label}</a>
            ),
          )}
        </nav>
      </header>
      {active === "general" && <GeneralTab canEdit={isAdmin} />}
      {active === "recruiters" && <RecruitersTab isAdmin={isAdmin} />}
      {active === "accounts" && <AccountsTab selfName={user?.username ?? ""} />}
    </div>
  );
}

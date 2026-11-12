import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../context/AuthContext";
import { getToken } from "../api/client";
import { useDeviceStream, type DeviceStreamEvent } from "../hooks/useDeviceStream";
import { MODULES, type ModuleKey } from "../app/routes";
import { motion } from "framer-motion";
import { EASE_SIGNATURE, Icon } from "@ui";

const ROLE_LABEL: Record<string, string> = { admin: "管理员", customer: "运营", recruiter: "招聘员" };

const REASON_LABEL: Record<string, string> = { reported: "上报离线", heartbeat_timeout: "心跳超时" };
const DEDUP_WINDOW_MS = 5_000;
const RECOVERY_TOAST_MS = 3_000;

export function Shell({ active, pageKey, children, fullBleed = false }: { active: ModuleKey; pageKey: string; children: ReactNode; fullBleed?: boolean }) {
  const { user, logout } = useAuth();
  const [primary, ...rest] = MODULES;

  // 掉线提醒：device_code=all 仅 admin 可订阅（非 admin 不建连）。
  const isAdmin = user?.role === "admin";
  const [offline, setOffline] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [recoveryToast, setRecoveryToast] = useState<string | null>(null);
  const seen = useRef(new Map<string, number>());
  const toastTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  const showRecoveryToast = (message: string) => {
    setRecoveryToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setRecoveryToast(null), RECOVERY_TOAST_MS);
  };

  const handleDeviceEvent = (event: DeviceStreamEvent) => {
    // 同设备 5 秒内重复事件去重，防多标签页/重连风暴。
    const key = `${event.device_code}|${event.online}|${event.reason ?? ""}`;
    const now = Date.now();
    if (now - (seen.current.get(key) ?? 0) < DEDUP_WINDOW_MS) return;
    seen.current.set(key, now);

    if (event.online) {
      setOffline((map) => {
        if (!(event.device_code in map)) return map;
        const next = { ...map };
        delete next[event.device_code];
        return next;
      });
      setDismissed((list) => list.filter((code) => code !== event.device_code));
      showRecoveryToast(`设备 ${event.device_code} 已恢复在线`);
    } else {
      // 新的离线事件视为重新发生，之前手动关掉的提醒条要回来。
      setDismissed((list) => list.filter((code) => code !== event.device_code));
      setOffline((map) => (event.device_code in map ? map : { ...map, [event.device_code]: event.reason ?? "reported" }));
    }
  };

  useDeviceStream(isAdmin ? getToken() : null, handleDeviceEvent);

  const offlineBanners = Object.entries(offline).filter(([code]) => !dismissed.includes(code));

  return (
    <div className="shell">
      {offlineBanners.length > 0 && (
        <div className="device-alert-stack" role="status">
          {offlineBanners.map(([code, reason]) => (
            <div key={code} className="device-alert-bar">
              <span>设备 {code} 已离线（{REASON_LABEL[reason] ?? "上报离线"}）</span>
              <button
                type="button"
                className="device-alert-close"
                aria-label={`关闭设备 ${code} 的离线提醒`}
                onClick={() => setDismissed((list) => (list.includes(code) ? list : [...list, code]))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {recoveryToast && (
        <div className="device-recovery-toast" role="status">
          {recoveryToast}
        </div>
      )}
      <aside className="rail">
        <div className="rail-brand">城市招聘</div>
        <nav className="rail-nav" aria-label="主导航">
          <a
            href={primary.home}
            className={`rail-item rail-item-primary ${active === primary.key ? "is-active" : ""}`}
            aria-current={active === primary.key ? "page" : undefined}
          >
            {active === primary.key && <ActivePill />}
            <Icon name={primary.icon} size={18} />
            <span>{primary.label}</span>
          </a>
          <div className="rail-sep" role="presentation" />
          {rest.map((m) => (
            <a key={m.key} href={m.home} className={`rail-item ${active === m.key ? "is-active" : ""}`} aria-current={active === m.key ? "page" : undefined}>
              {active === m.key && <ActivePill />}
              <Icon name={m.icon} size={16} />
              <span>{m.label}</span>
            </a>
          ))}
        </nav>
        <div className="rail-footer">
          <div className="rail-user">
            <span className="rail-user-name">{user?.username}</span>
            <span className="rail-user-role">{ROLE_LABEL[user?.role ?? ""] ?? user?.role}</span>
          </div>
          <button type="button" className="rail-logout" onClick={logout}>
            退出
          </button>
        </div>
      </aside>
      <main className={`content ${fullBleed ? "is-full-bleed" : ""}`}>
        <div key={pageKey} className="ui-page-enter content-page">
          {children}
        </div>
      </main>
    </div>
  );
}

function ActivePill() {
  return <motion.span layoutId="rail-active" className="rail-pill" aria-hidden="true" transition={{ duration: 0.38, ease: EASE_SIGNATURE }} />;
}

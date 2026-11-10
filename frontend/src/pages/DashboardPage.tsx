import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { api, ApiError, type City } from "../api/client";

const STATUS_LABEL: Record<string, string> = {
  enabled: "招聘中",
  active: "招聘中",
  disabled: "已暂停",
  paused: "已暂停",
};

function statusTone(status: string): "up" | "down" {
  return status === "enabled" || status === "active" ? "up" : "down";
}

export function DashboardPage() {
  const [cities, setCities] = useState<City[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);

  const loadCities = useCallback(async () => {
    try {
      const result = await api.listCities();
      setCities(result.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "加载失败");
    }
  }, []);

  useEffect(() => {
    loadCities();
  }, [loadCities]);

  const stats = useMemo(() => {
    const items = cities ?? [];
    const active = items.filter((city) => statusTone(city.recruitment_status) === "up").length;
    const provinces = new Set(items.map((city) => city.province).filter(Boolean)).size;
    return {
      total: items.length,
      active,
      paused: items.length - active,
      provinces,
    };
  }, [cities]);

  async function handleToggle(city: City) {
    const next = statusTone(city.recruitment_status) === "up" ? "disabled" : "enabled";
    setPendingId(city.id);
    try {
      const updated = await api.setCityStatus(city.id, next);
      setCities((prev) => (prev ? prev.map((item) => (item.id === city.id ? updated : item)) : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "更新失败");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>城市总览</h1>
          <p className="dashboard-subtitle">查看并管理各城市的招聘开放状态</p>
        </div>
      </header>

      <motion.section
        className="kpi-row"
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.06 } } }}
      >
        {[
          { label: "城市总数", value: stats.total, icon: "🏙️" },
          { label: "招聘中", value: stats.active, icon: "✅" },
          { label: "已暂停", value: stats.paused, icon: "⏸️" },
          { label: "覆盖省份", value: stats.provinces, icon: "📍" },
        ].map((tile) => (
          <motion.div
            key={tile.label}
            className="kpi-tile"
            variants={{ hidden: { opacity: 0, y: 14 }, visible: { opacity: 1, y: 0 } }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="kpi-icon">{tile.icon}</div>
            <div className="kpi-label">{tile.label}</div>
            <div className="kpi-value">{tile.value}</div>
          </motion.div>
        ))}
      </motion.section>

      {error && <div className="banner-error">{error}</div>}

      <section className="table-card">
        <div className="table-card-head">
          <h2>城市列表</h2>
          <span className="table-card-count">{cities ? `共 ${cities.length} 条` : "加载中…"}</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>城市</th>
              <th>省份</th>
              <th>流程类型</th>
              <th>主城市</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <AnimatePresence initial={false}>
              {cities === null &&
                Array.from({ length: 5 }).map((_, index) => (
                  <tr key={`skeleton-${index}`} className="skeleton-row">
                    <td colSpan={6}>
                      <div className="skeleton-bar" />
                    </td>
                  </tr>
                ))}
              {cities?.map((city) => {
                const tone = statusTone(city.recruitment_status);
                return (
                  <motion.tr
                    key={city.id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <td className="cell-strong">{city.city_name}</td>
                    <td>{city.province || "—"}</td>
                    <td>{city.flow_type || "standard"}</td>
                    <td>{city.is_primary ? "是" : "否"}</td>
                    <td>
                      <span className={`status-chip status-${tone}`}>
                        {STATUS_LABEL[city.recruitment_status] ?? city.recruitment_status}
                      </span>
                    </td>
                    <td className="cell-actions">
                      <motion.button
                        type="button"
                        className="ghost-button"
                        whileTap={{ scale: 0.95 }}
                        disabled={pendingId === city.id}
                        onClick={() => handleToggle(city)}
                      >
                        {pendingId === city.id ? "处理中…" : tone === "up" ? "暂停招聘" : "恢复招聘"}
                      </motion.button>
                    </td>
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </tbody>
        </table>
        {cities?.length === 0 && <div className="empty-state">暂无城市数据</div>}
      </section>
    </div>
  );
}

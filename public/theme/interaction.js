const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
const HOSTS = [
  ".el-button:not(.is-text):not(.is-link)",
  ".sidebar-menu .el-menu-item",
  ".sidebar-menu .el-sub-menu__title",
  ".el-pager li",
  ".el-radio-button__inner",
  ".customer-item",
  ".device-item",
  ".m-conv-item",
].join(",");
const RIPPLE_MS = 520;

document.addEventListener(
  "pointerdown",
  (event) => {
    if (REDUCED.matches || event.button !== 0) return;
    const host = event.target instanceof Element ? event.target.closest(HOSTS) : null;
    if (!host || host.matches(".is-disabled, [disabled]")) return;

    if (!host.classList.contains("rk-ripple-host")) {
      host.classList.add("rk-ripple-host");
      if (getComputedStyle(host).position === "static") host.classList.add("rk-ripple-static");
    }
    const box = host.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const size = 2 * Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y));

    const ripple = document.createElement("span");
    ripple.className = "rk-ripple";
    ripple.setAttribute("aria-hidden", "true");
    ripple.style.setProperty("--rk-ripple-x", `${x}px`);
    ripple.style.setProperty("--rk-ripple-y", `${y}px`);
    ripple.style.setProperty("--rk-ripple-size", `${size}px`);
    host.appendChild(ripple);
    setTimeout(() => ripple.remove(), RIPPLE_MS);
  },
  { passive: true, capture: true },
);

const SPOT_HOSTS = ".stat-card, .chart-card, .admin-overview-card, .city-card, .strategy-card, .engine-card, .summary-card";
const FINE_POINTER = matchMedia("(hover: hover) and (pointer: fine)");
let spotFrame = 0;
let spotEvent = null;

document.addEventListener(
  "pointermove",
  (event) => {
    if (REDUCED.matches || !FINE_POINTER.matches) return;
    spotEvent = event;
    if (spotFrame) return;
    spotFrame = requestAnimationFrame(() => {
      spotFrame = 0;
      const target = spotEvent.target instanceof Element ? spotEvent.target.closest(SPOT_HOSTS) : null;
      if (!target) return;
      const box = target.getBoundingClientRect();
      target.style.setProperty("--rk-px", `${spotEvent.clientX - box.left}px`);
      target.style.setProperty("--rk-py", `${spotEvent.clientY - box.top}px`);
    });
  },
  { passive: true },
);

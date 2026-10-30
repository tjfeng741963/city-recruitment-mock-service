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

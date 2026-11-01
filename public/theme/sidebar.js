{
  const STORAGE_KEY = "rk-nav-collapsed";
  const COLLAPSED_CLASS = "rk-nav-collapsed";
  const NARROW = matchMedia("(max-width: 1200px)");
  const root = document.documentElement;

  const ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="4"/><path d="M9.5 4.5v15"/><path class="rk-nav-chevron" d="m15.5 10-2 2 2 2"/></svg>';

  function readPreference() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return NARROW.matches;
  }

  function apply(collapsed) {
    root.classList.toggle(COLLAPSED_CLASS, collapsed);
    const button = document.querySelector(".rk-nav-toggle");
    if (!button) return;
    const label = collapsed ? "展开侧栏" : "收起侧栏";
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", label);
    button.dataset.rkLabel = label;
    button.querySelector(".rk-nav-toggle-text").textContent = label;
  }

  function labelItems(sidebar) {
    for (const item of sidebar.querySelectorAll(
      ".el-menu-item, .el-sub-menu__title",
    )) {
      const text = item.querySelector(":scope > span")?.textContent.trim();
      if (text && item.dataset.rkLabel !== text) item.dataset.rkLabel = text;
    }
  }

  function mount() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    labelItems(sidebar);
    if (sidebar.querySelector(".rk-nav-toggle")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rk-nav-toggle";
    button.innerHTML = `${ICON}<span class="rk-nav-toggle-text"></span>`;
    button.addEventListener("click", () => {
      const collapsed = !root.classList.contains(COLLAPSED_CLASS);
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
      apply(collapsed);
    });
    sidebar.appendChild(button);
    apply(root.classList.contains(COLLAPSED_CLASS));
  }

  apply(readPreference());

  function start() {
    let frame = 0;
    new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        mount();
      });
    }).observe(document.body, { childList: true, subtree: true });
    mount();

    const tip = document.createElement("div");
    tip.className = "rk-nav-tip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);

    function showTip(event) {
      const host =
        event.target instanceof Element
          ? event.target.closest(".sidebar [data-rk-label]")
          : null;
      if (!host || !root.classList.contains(COLLAPSED_CLASS)) return hideTip();
      const box = host.getBoundingClientRect();
      tip.textContent = host.dataset.rkLabel;
      tip.style.top = `${box.top + box.height / 2}px`;
      tip.style.left = `${box.right + 12}px`;
      tip.classList.add("is-visible");
    }

    function hideTip() {
      tip.classList.remove("is-visible");
    }

    document.addEventListener("pointerover", showTip, { passive: true });
    document.addEventListener("focusin", showTip);
    document.addEventListener("focusout", hideTip);
    document.addEventListener("scroll", hideTip, {
      passive: true,
      capture: true,
    });
    document.addEventListener("pointerdown", hideTip, { passive: true });
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });

  NARROW.addEventListener("change", () => {
    if (localStorage.getItem(STORAGE_KEY) === null) apply(NARROW.matches);
  });
}

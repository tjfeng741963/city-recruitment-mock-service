/**
 * 城市页合并厂区管理（2026-11-13 客户要求）。
 *
 * 线上后台是编译好的 Vue 包（public/assets/），没有 .vue 源码，无法改路由和菜单。
 * 这里按项目已有的做法（theme/sidebar.js、admin-enhancements.js 同一套路）在运行时补：
 *
 *   1. 隐藏侧栏「厂区管理」一级入口（/factories）
 *   2. 访问 /factories 时直接转到 /cities
 *   3. 城市列表每一行加「厂区 N」按钮，点开抽屉维护该城市的厂区
 *
 * 数据走 4222 现有接口：
 *   GET    /api/v1/cities/:id/factories   → 该城厂区列表
 *   POST   /api/v1/factories              → 新建厂区（带 city_id）
 *   PUT    /api/v1/factories/:id          → 改名 / 停用
 *   DELETE /api/v1/factories/:id          → 删除（有岗位挂载时后端会拦）
 *
 * 为什么不做成「改表格列」：Vue 的虚拟 DOM 会在下一次渲染把注入的列冲掉，
 * 而按钮挂在进行中的 DOM 上、靠 MutationObserver 续挂，是这套编译产物里唯一稳的做法。
 */
{
  const SELECTOR = ".action-btns";
  const MARK = "data-rk-factories";

  const token = () => localStorage.getItem("token") || "";

  async function api(path, init = {}) {
    const response = await fetch(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token()}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
    return body;
  }

  // ── 样式：跟现有一致（浅描边按钮 + 抽屉），不引入新的视觉语言 ──
  function styles() {
    if (document.getElementById("rk-factories-style")) return;
    const style = document.createElement("style");
    style.id = "rk-factories-style";
    style.textContent = `
      .rk-fac-btn{height:28px;padding:0 10px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#409eff;cursor:pointer;font:inherit;font-size:12px}
      .rk-fac-btn:hover{border-color:#409eff;background:#ecf5ff}
      .rk-fac-mask{position:fixed;inset:0;z-index:4000;display:flex;justify-content:flex-end;background:rgba(22,26,42,.42)}
      .rk-fac-panel{display:flex;flex-direction:column;width:min(560px,100%);height:100%;background:#fff;box-shadow:-8px 0 32px rgba(0,0,0,.16)}
      .rk-fac-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid #ebeef5}
      .rk-fac-head h2{margin:0;font-size:17px;font-weight:600;color:#303133}
      .rk-fac-head p{margin:4px 0 0;font-size:12px;color:#909399}
      .rk-fac-close{width:30px;height:30px;border:0;background:transparent;color:#606266;font-size:20px;cursor:pointer}
      .rk-fac-body{flex:1;overflow:auto;padding:16px 20px}
      .rk-fac-add{display:flex;gap:8px;margin-bottom:14px}
      .rk-fac-add input{flex:1;min-height:34px;padding:6px 9px;border:1px solid #dcdfe6;border-radius:4px;font:inherit}
      .rk-fac-add button{min-height:34px;padding:0 14px;border:1px solid #409eff;border-radius:4px;background:#409eff;color:#fff;cursor:pointer;font:inherit}
      .rk-fac-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f2f3f5}
      .rk-fac-row main{flex:1;min-width:0}
      .rk-fac-row strong{display:block;font-size:14px;color:#303133;font-weight:500;word-break:break-all}
      .rk-fac-row small{display:block;margin-top:2px;font-size:12px;color:#909399}
      .rk-fac-row.is-off strong{color:#c0c4cc;text-decoration:line-through}
      .rk-fac-row .rk-fac-actions{display:flex;gap:6px;flex-shrink:0}
      .rk-fac-row button{height:26px;padding:0 9px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#303133;cursor:pointer;font:inherit;font-size:12px}
      .rk-fac-row button:hover{border-color:#409eff;color:#409eff}
      .rk-fac-row button.danger{color:#c45656}
      .rk-fac-empty{padding:28px 0;text-align:center;color:#909399;font-size:13px}
      .rk-fac-error{margin-bottom:10px;color:#c45656;font-size:13px}
      .rk-fac-note{margin-top:12px;color:#909399;font-size:12px;line-height:1.6}
    `;
    document.head.append(style);
  }

  // ── 抽屉 ──
  async function openDrawer(city) {
    styles();
    const mask = document.createElement("div");
    mask.className = "rk-fac-mask";
    mask.setAttribute("role", "presentation");
    const panel = document.createElement("section");
    panel.className = "rk-fac-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", `${city.city_name}的厂区`);
    mask.append(panel);
    document.body.append(mask);
    mask.addEventListener("click", (event) => { if (event.target === mask) mask.remove(); });
    document.addEventListener("keydown", function onKey(event) {
      if (event.key !== "Escape") return;
      document.removeEventListener("keydown", onKey);
      mask.remove();
    });

    const head = document.createElement("div");
    head.className = "rk-fac-head";
    const titles = document.createElement("div");
    const h2 = document.createElement("h2");
    h2.textContent = `${city.city_name}的厂区`;
    const sub = document.createElement("p");
    sub.textContent = "岗位挂在这个城市的厂区下，AI 回答候选人时按厂区取岗位";
    titles.append(h2, sub);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "rk-fac-close";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    close.addEventListener("click", () => mask.remove());
    head.append(titles, close);

    const body = document.createElement("div");
    body.className = "rk-fac-body";
    panel.append(head, body);

    const error = document.createElement("div");
    error.className = "rk-fac-error";

    const form = document.createElement("form");
    form.className = "rk-fac-add";
    const input = document.createElement("input");
    input.placeholder = "新厂区名称，例如 佛山地铁安检";
    input.setAttribute("aria-label", "新厂区名称");
    const add = document.createElement("button");
    add.type = "submit";
    add.textContent = "新建厂区";
    form.append(input, add);

    const list = document.createElement("div");
    const note = document.createElement("p");
    note.className = "rk-fac-note";
    note.textContent = "停用的厂区不再向候选人推荐；删除前请确认没有岗位挂在它下面。";

    body.append(error, form, list, note);

    let items = [];

    const render = () => {
      list.replaceChildren();
      if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "rk-fac-empty";
        empty.textContent = "这个城市还没有厂区。先建一个，再去「岗位管理」把岗位挂上去。";
        list.append(empty);
        return;
      }
      for (const factory of items) {
        const row = document.createElement("div");
        row.className = `rk-fac-row${factory.is_active ? "" : " is-off"}`;
        const main = document.createElement("main");
        const name = document.createElement("strong");
        name.textContent = factory.factory_name;
        const meta = document.createElement("small");
        meta.textContent = factory.is_active ? "启用中" : "已停用";
        main.append(name, meta);

        const actions = document.createElement("div");
        actions.className = "rk-fac-actions";

        const rename = document.createElement("button");
        rename.type = "button";
        rename.textContent = "改名";
        rename.addEventListener("click", async () => {
          const next = window.prompt("新的厂区名称", factory.factory_name);
          if (next === null || next.trim() === "" || next.trim() === factory.factory_name) return;
          try {
            await api(`/api/v1/factories/${factory.id}`, { method: "PUT", body: JSON.stringify({ factory_name: next.trim() }) });
            await load();
          } catch (caught) { error.textContent = caught.message; }
        });

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.textContent = factory.is_active ? "停用" : "启用";
        toggle.addEventListener("click", async () => {
          try {
            await api(`/api/v1/factories/${factory.id}`, { method: "PUT", body: JSON.stringify({ is_active: !factory.is_active }) });
            await load();
          } catch (caught) { error.textContent = caught.message; }
        });

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger";
        remove.textContent = "删除";
        remove.addEventListener("click", async () => {
          if (!window.confirm(`删除厂区「${factory.factory_name}」？`)) return;
          try {
            await api(`/api/v1/factories/${factory.id}`, { method: "DELETE" });
            await load();
          } catch (caught) { error.textContent = caught.message; }
        });

        actions.append(rename, toggle, remove);
        row.append(main, actions);
        list.append(row);
      }
    };

    const load = async () => {
      error.textContent = "";
      try {
        const result = await api(`/api/v1/cities/${city.id}/factories`);
        items = Array.isArray(result.items) ? result.items : [];
        render();
        updateRowCounts();
      } catch (caught) {
        error.textContent = `厂区加载失败：${caught.message}`;
      }
    };

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      error.textContent = "";
      try {
        await api("/api/v1/factories", { method: "POST", body: JSON.stringify({ factory_name: name, city_id: city.id }) });
        input.value = "";
        await load();
      } catch (caught) { error.textContent = `新建失败：${caught.message}`; }
    });

    await load();
  }

  // ── 城市行：加「厂区 N」按钮 ──
  let cityCache = { at: 0, items: [] };

  async function cities() {
    if (Date.now() - cityCache.at < 30_000 && cityCache.items.length) return cityCache.items;
    const result = await api("/api/v1/cities?page=1&page_size=1000");
    cityCache = { at: Date.now(), items: Array.isArray(result.items) ? result.items : [] };
    return cityCache.items;
  }

  function cityOfRow(row, list) {
    const name = row.querySelector(".city-name")?.textContent.trim();
    if (!name) return null;
    return list.find((city) => city.city_name === name) || null;
  }

  function updateRowCounts() {
    for (const button of document.querySelectorAll(`[${MARK}]`)) {
      const count = button.dataset.rkCount;
      if (count !== undefined) button.textContent = `厂区 ${count}`;
    }
  }

  let decorating = false;
  async function decorate() {
    if (!location.pathname.startsWith("/cities")) return;
    if (decorating) return;
    decorating = true;
    try {
      const rows = document.querySelectorAll(".bd-table .el-table__row");
      if (!rows.length) return;
      const list = await cities();
      for (const row of rows) {
        const bar = row.querySelector(SELECTOR);
        if (!bar || bar.querySelector(`[${MARK}]`)) continue;
        const city = cityOfRow(row, list);
        if (!city) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rk-fac-btn";
        button.setAttribute(MARK, String(city.id));
        button.textContent = "厂区";
        button.title = `维护${city.city_name}的厂区`;
        button.addEventListener("click", () => openDrawer(city));
        bar.append(button);
        api(`/api/v1/cities/${city.id}/factories`)
          .then((result) => {
            const total = Array.isArray(result.items) ? result.items.length : 0;
            button.dataset.rkCount = String(total);
            button.textContent = `厂区 ${total}`;
          })
          .catch(() => {});
      }
    } catch { /* 城市没权限或接口失败：不加按钮，页面照常可用 */ }
    finally { decorating = false; }
  }

  // ── 隐藏侧栏入口 + 重定向 ──
  function hideMenu() {
    // 用 CSS 隐藏而不是 remove()：这个节点归 Vue 管理，
    // 直接删掉它的 DOM 会让下一次 patch 找不到节点而报错。
    for (const item of document.querySelectorAll(".sidebar-menu .el-menu-item")) {
      const text = item.querySelector(":scope > span")?.textContent.trim();
      if (text !== "厂区管理") continue;
      if (item.dataset.rkHidden === "1") continue;
      item.dataset.rkHidden = "1";
      item.style.display = "none";
    }
  }

  let redirected = false;
  function redirect() {
    if (redirected) return;
    if (location.pathname !== "/factories" && !location.pathname.startsWith("/factories/")) return;
    redirected = true;
    history.replaceState(null, "", "/cities");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  redirect();

  let frame = 0;
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      hideMenu();
      decorate();
    });
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);
  schedule();
}

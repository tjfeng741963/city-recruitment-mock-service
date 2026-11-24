/**
 * 面试登记页面（2026-11-18 第三版，按用户要求定形）。
 *
 * 与「对话管理」一模一样的形态：
 *   - 侧栏「坐席运营」分组内的标准菜单项（克隆原生 item，样式一致）
 *   - 点击后内容区（.main-scroll）渲染页面，不是弹窗/抽屉
 *   - 点其他菜单自动回到原生页面
 *
 * 为什么是注入不是改源码：线上后台是编译好的 Vue 包（仓库无 .vue 源码），
 * 本脚本运行时 DOM 注入，编译包不动。三端一致：代码进 main 部署即全端生效。
 */
(function () {
  "use strict";

  const MARK = "data-rk-arch-entry";
  let pageEl = null; // 内容区页面根节点
  let entryEl = null; // 侧栏菜单项

  const api = async (method, path, payload) => {
    let token = "";
    try { token = String(localStorage.getItem("token") || ""); } catch {}
    if (token.length > 1 && token.startsWith('"')) { try { token = JSON.parse(token); } catch {} }
    const headers = { accept: "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    const options = { method, headers };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(path, options);
    if (!response.ok) {
      let detail = "HTTP " + response.status;
      try { detail = (await response.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    return response.json();
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch] || ch));
  }

  // ── 样式（页面级，风格与编译版页面一致） ──────────────────────
  function injectStyle() {
    if (document.getElementById("rk-arch-style")) return;
    const style = document.createElement("style");
    style.id = "rk-arch-style";
    style.textContent = `
      /* 页面模式：隐藏原生路由内容，只显示注入页 */
      .main-scroll.rk-page-mode > *:not(.rk-arch-page){display:none}
      .rk-arch-page{display:flex;gap:14px;min-height:calc(100vh - 130px);font-family:var(--rk-font,inherit)}
      .rk-arch-left{flex:0 0 380px;display:flex;flex-direction:column;gap:12px;min-width:0}
      .rk-arch-right{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:12px}
      .rk-arch-card{padding:14px 16px;border:1px solid var(--rk-border,#e2e8f1);border-radius:12px;background:var(--rk-bg,#fff)}
      .rk-arch-card > b{font-size:13px;color:var(--rk-ink-1,#1f1f1f)}
      .rk-arch-list{display:flex;flex-direction:column;gap:8px;margin-top:10px;max-height:60vh;overflow:auto}
      .rk-arch-item{padding:10px 12px;border:1px solid var(--rk-border,#e2e8f1);border-radius:10px;background:#fff;cursor:pointer;font-size:12.5px;line-height:1.5}
      .rk-arch-item:hover{border-color:var(--rk-accent,#0b57d0)}
      .rk-arch-item.is-active{border-color:var(--rk-accent,#0b57d0);background:var(--rk-accent-soft,#d3e3fd)}
      .rk-arch-item .name{font-weight:600;color:var(--rk-ink-1,#1f1f1f)}
      .rk-arch-item .meta{color:var(--rk-ink-3,#5e5e5e);font-size:11.5px;margin-top:2px}
      .rk-arch-confirmed{color:#146c2e;font-weight:600}
      .rk-arch-unconfirmed{color:#b3261e;font-weight:600}
      .rk-arch-pill{display:inline-flex;align-items:center;height:22px;padding:0 10px;border-radius:999px;font-size:11.5px;font-weight:600}
      .rk-arch-pill.sent{background:#c4eed0;color:#146c2e}
      .rk-arch-pill.queued{background:#fff3c4;color:#8a6d00}
      .rk-arch-pill.failed{background:#fce8e6;color:#b3261e}
      .rk-arch-pill.no-group,.rk-arch-pill.incomplete,.rk-arch-pill.pending{background:#eef0f3;color:#8a929e}
      .rk-arch-arrival{height:28px;padding:0 8px;border:1px solid var(--rk-border-strong,rgba(31,31,31,.14));border-radius:6px;font:inherit;font-size:12px;color:var(--rk-ink-1,#1f1f1f);outline:none;background:#fff}
      .rk-arch-hint{margin:8px 0 0;font-size:11.5px;line-height:1.6;color:var(--rk-ink-3,#5e5e5e)}
      .rk-arch-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}
      .rk-arch-row select{height:30px;padding:0 8px;border:1px solid var(--rk-border-strong,rgba(31,31,31,.14));border-radius:6px;font:inherit;font-size:12px;color:var(--rk-ink-1,#1f1f1f);outline:none;background:#fff}
      .rk-arch-empty{padding:40px 20px;text-align:center;color:var(--rk-ink-3,#93a0b3);font-size:13px;line-height:1.8}
      .rk-arch-kv{display:grid;grid-template-columns:88px 1fr;gap:6px 10px;margin-top:10px;font-size:12.5px}
      .rk-arch-kv .k{color:var(--rk-ink-3,#5e5e5e)}
      .rk-arch-kv .v{color:var(--rk-ink-1,#1f1f1f);word-break:break-all}
    `;
    document.head.append(style);
  }

  // ── 侧栏入口：克隆原生菜单项 ─────────────────────────────────
  function findGroupMenu(titleText) {
    for (const sub of document.querySelectorAll(".sidebar .el-sub-menu")) {
      const title = sub.querySelector(".el-sub-menu__title");
      if (title && title.textContent.includes(titleText)) {
        return sub.querySelector(".el-menu");
      }
    }
    return null;
  }

  function mountEntry() {
    const menu = findGroupMenu("坐席运营");
    if (!menu || menu.querySelector(`[${MARK}]`)) return;
    // 克隆同组现有菜单项（坐席设备/对话管理），保样式一致
    const template = menu.querySelector(".el-menu-item");
    const entry = template ? template.cloneNode(true) : document.createElement("li");
    entry.className = "el-menu-item";
    entry.setAttribute(MARK, "1");
    entry.style.display = "";
    const label = entry.querySelector("span") || entry;
    if (entry.querySelector("span")) entry.querySelector("span").textContent = "面试登记";
    else label.textContent = "面试登记";
    entry.removeAttribute("id");
    entry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPage();
    });
    menu.append(entry);
    entryEl = entry;
  }

  // ── 页面挂载 / 卸载 ──────────────────────────────────────────
  function openPage() {
    const mainScroll = document.querySelector(".main-scroll");
    if (!mainScroll || pageEl) return;
    injectStyle();
    // 高亮自己，取消原生项高亮
    for (const item of document.querySelectorAll(".sidebar .el-menu-item")) {
      if (item === entryEl) item.classList.add("is-active");
      else item.classList.remove("is-active");
    }
    mainScroll.classList.add("rk-page-mode");
    pageEl = document.createElement("div");
    pageEl.className = "rk-arch-page";
    mainScroll.append(pageEl);
    armLeaveWatch(mainScroll);
    paintPage();
  }

  function closePage() {
    if (pageEl) { pageEl.remove(); pageEl = null; }
    document.querySelector(".main-scroll")?.classList.remove("rk-page-mode");
    if (entryEl) entryEl.classList.remove("is-active");
  }

  // 点其他原生菜单时自动回到原生页面（捕获阶段委托）
  // 卸载时机（不再依赖点击事件——Vue 重渲染侧栏后点击监听会丢）：
  // 监听内容区子节点变化——注入页存在时 Vue 渲染了新页面（路由切换）
  // → 立即卸载注入页并解除页面模式；document 级点击委托兜底。
  function armLeaveWatch(mainScroll) {
    if (armLeaveWatch._observer) return;
    armLeaveWatch._observer = new MutationObserver(() => {
      if (!pageEl || !mainScroll.isConnected) return;
      // 内容区里出现了不是注入页的元素子节点 → 路由已切换
      for (const child of mainScroll.children) {
        if (child !== pageEl && child.tagName !== "STYLE") {
          closePage();
          return;
        }
      }
    });
    armLeaveWatch._observer.observe(mainScroll, { childList: true });
    document.addEventListener("click", leaveClickGuard, true);
    window.addEventListener("popstate", closePage);
  }

  function leaveClickGuard(event) {
    if (!pageEl) return;
    const item = event.target.closest(".el-menu-item");
    if (item && item.hasAttribute(MARK)) return;
    if (item || event.target.closest(".el-sub-menu__title")) closePage();
  }

  function closePage() {
    if (pageEl) { pageEl.remove(); pageEl = null; }
    document.querySelector(".main-scroll")?.classList.remove("rk-page-mode");
    if (entryEl) entryEl.classList.remove("is-active");
    if (armLeaveWatch._observer) {
      armLeaveWatch._observer.disconnect();
      armLeaveWatch._observer = null;
    }
    document.removeEventListener("click", leaveClickGuard, true);
  }

  // ── 页面内容 ─────────────────────────────────────────────────
  const STATUS_TEXT = {
    sent: "已推送群聊", queued: "待设备发送", claimed: "设备发送中", failed: "推送失败",
    unknown: "发送结果待核对", "no-group": "未绑群聊", "group-unavailable": "未确认目标群",
    incomplete: "信息未齐", pending: "待推送",
  };
  const PILL_CLASS = (status) =>
    Object.hasOwn(STATUS_TEXT, status) ? status : "pending";

  async function paintPage() {
    if (!pageEl) return;
    pageEl.innerHTML = "";
    let items = [];
    let deviceList = [];
    try {
      const [archive, devices] = await Promise.all([
        api("GET", "/api/v1/agent/archive/list"),
        api("GET", "/api/v1/agent/devices").catch(() => ({ items: [] })),
      ]);
      items = archive.items || [];
      deviceList = devices.items || [];
    } catch (error) {
      pageEl.innerHTML = `<div class="rk-arch-empty">加载失败：${escapeHtml(error.message)}</div>`;
      return;
    }

    // ── 左栏：登记清单 ──
    const left = document.createElement("div");
    left.className = "rk-arch-left";
    const listCard = document.createElement("div");
    listCard.className = "rk-arch-card";
    listCard.innerHTML = `<b>面试登记清单（${items.length} 条）</b>`;
    const list = document.createElement("div");
    list.className = "rk-arch-list";
    if (!items.length) {
      list.innerHTML = `<div class="rk-arch-empty">还没有登记记录。Agent 对话收集到客户姓名、电话、面试时间后会自动出现在这里并推送群聊。</div>`;
    }
    let selected = null;
    for (const it of items) {
      const item = document.createElement("div");
      item.className = "rk-arch-item";
      item.innerHTML =
        `<div class="name">${escapeHtml(it.name || "（未登记姓名）")} <span style="font-weight:400">${escapeHtml(it.interview_date || "")} ${escapeHtml(it.interview_time || "")}</span></div>` +
        `<div class="meta">${escapeHtml(it.customer_nickname || "")} · ${escapeHtml(it.device_code || "")} · ${STATUS_TEXT[PILL_CLASS(it.notify_status)]}</div>`;
      item.addEventListener("click", () => {
        selected = it;
        for (const n of list.querySelectorAll(".rk-arch-item")) n.classList.remove("is-active");
        item.classList.add("is-active");
        paintDetail(it);
      });
      list.append(item);
      if (!selected) selected = it;
    }
    listCard.append(list);
    left.append(listCard);

    // ── 左栏下部：设备绑定群聊（登记完成自动推送「时间+姓名+电话」）──
    const groupCard = document.createElement("div");
    groupCard.className = "rk-arch-card";
    groupCard.innerHTML = `<b>设备绑定群聊（登记完成后自动推送）</b>`;
    for (const device of deviceList) {
      const row = document.createElement("div");
      row.className = "rk-arch-row";
      const label = document.createElement("span");
      label.style.cssText = "flex:0 0 auto;font-size:12px;font-weight:600;color:var(--rk-ink-2,#3c4043)";
      label.textContent = device.device_code;
      const select = document.createElement("select");
      select.style.flex = "1 1 140px";
      select.innerHTML = `<option value="">加载中…</option>`;
      select.addEventListener("change", async () => {
        select.disabled = true;
        try {
          await api("PUT", `/api/v1/agent/devices/${device.id}`, { group_chat: select.value });
        } catch (error) { /* 保存失败重绘时恢复 */ }
        select.disabled = false;
      });
      row.append(label, select);
      groupCard.append(row);
      // 异步拉设备已上报的群聊清单填充下拉
      api("GET", `/api/v1/agent/devices/${device.device_code}/groups`)
        .then((res) => {
          const groups = res.items || [];
          const current = device.group_chat || "";
          select.innerHTML =
            `<option value="">未绑定</option>` +
            groups
              .map((g) => `<option value="${escapeHtml(g.name)}" ${g.name === current ? "selected" : ""}>${escapeHtml(g.name)}</option>`)
              .join("");
        })
        .catch(() => { select.innerHTML = `<option value="">清单加载失败</option>`; });
    }
    left.append(groupCard);
    pageEl.append(left);

    // ── 右栏：详情 ──
    const right = document.createElement("div");
    right.className = "rk-arch-right";
    const detail = document.createElement("div");
    detail.className = "rk-arch-card";
    detail.id = "rk-arch-detail";
    if (selected) paintDetail(selected);
    else detail.innerHTML = `<div class="rk-arch-empty">选择左侧一条登记查看详情</div>`;
    right.append(detail);
    pageEl.append(right);
  }

  function paintDetail(it) {
    const detail = document.getElementById("rk-arch-detail");
    if (!detail) return;
    detail.innerHTML = `<b>登记详情</b>
      <div class="rk-arch-kv">
        <div class="k">姓名</div><div class="v">${escapeHtml(it.name || "-")}</div>
        <div class="k">电话</div><div class="v">${escapeHtml(it.phone || "-")}</div>
        <div class="k">城市</div><div class="v">${escapeHtml(it.city || "-")}</div>
        <div class="k">面试时间</div><div class="v">${escapeHtml(it.interview_date || "")} ${escapeHtml(it.interview_time || "")}</div>
        ${it.interview_point ? `<div class="k">面试点</div><div class="v">${escapeHtml(it.interview_point)}</div>` : ""}
        ${it.interview_address && it.interview_address !== it.interview_point ? `<div class="k">面试地址</div><div class="v">${escapeHtml(it.interview_address)}</div>` : ""}
        <div class="k">客户</div><div class="v">${escapeHtml(it.customer_nickname || "-")}</div>
        <div class="k">设备</div><div class="v">${escapeHtml(it.device_code || "-")}${it.group_chat ? "（群聊：" + escapeHtml(it.group_chat) + "）" : ""}</div>
        <div class="k">确认</div><div class="v"><span class="${it.interview_confirmed ? "rk-arch-confirmed" : "rk-arch-unconfirmed"}">${it.interview_confirmed ? "已确认" : "待确认"}</span></div>
        ${it.notify_status==="archive-only" ? "" : `<div class="k">群聊通知</div><div class="v"><span class="rk-arch-pill ${PILL_CLASS(it.notify_status)}">${STATUS_TEXT[PILL_CLASS(it.notify_status)] || it.notify_status}</span></div>`}
        <div class="k">更新时间</div><div class="v">${escapeHtml(it.updated_at || "-")}</div>
      </div>
      <div style="margin-top:12px"><b style="font-size:12.5px">到达状态</b></div>`;
    const row = document.createElement("div");
    row.className = "rk-arch-row";
    const select = document.createElement("select");
    select.className = "rk-arch-arrival";
    select.innerHTML = `
      <option value="" ${!it.arrival_status ? "selected" : ""}>待定</option>
      <option value="arrived" ${it.arrival_status === "arrived" ? "selected" : ""}>正常到达</option>
      <option value="noshow" ${it.arrival_status === "noshow" ? "selected" : ""}>爽约</option>`;
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        await api("PUT", `/api/v1/agent/archive/${encodeURIComponent(it.session_key)}/arrival`, { arrival_status: select.value });
        it.arrival_status = select.value;
      } catch (error) { select.value = it.arrival_status || ""; }
      select.disabled = false;
    });
    row.append(select);
    detail.append(row);
  }

  function start() {
    injectStyle();
    mountEntry();
    // Vue 重渲染侧栏时补挂菜单项
    new MutationObserver(() => {
      if (!document.querySelector(`[${MARK}]`)) {
        try { mountEntry(); } catch {}
      }
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

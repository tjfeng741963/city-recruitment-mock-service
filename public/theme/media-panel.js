/**
 * 素材库页面（2026-11-18 第二版，按用户要求定形）。
 *
 * 形态与面试登记一致：
 *   - 侧栏「基础配置」分组内的标准菜单项（在「周边城市设置」下面）
 *   - 点击后内容区渲染页面，不是弹窗
 *
 * 媒体分层：通用池（position_id=0，全岗位可发）+ 岗位专属（绑定岗位，
 * 如面试地点图——各城市地址不同，图跟岗位走）。
 */
(function () {
  "use strict";

  const MARK = "data-rk-media-entry";
  let pageEl = null;
  let entryEl = null;

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

  function injectStyle() {
    if (document.getElementById("rk-media-style")) return;
    const style = document.createElement("style");
    style.id = "rk-media-style";
    style.textContent = `
      .main-scroll.rk-media-page-mode > *:not(.rk-media-page){display:none}
      .rk-media-page{display:flex;flex-direction:column;gap:14px;min-height:calc(100vh - 130px)}
      .rk-media-card{padding:14px 16px;border:1px solid var(--rk-border,#e2e8f1);border-radius:12px;background:var(--rk-bg,#fff)}
      .rk-media-card > b{font-size:13px;color:var(--rk-ink-1,#1f1f1f)}
      .rk-media-hint{margin:8px 0 0;font-size:11.5px;line-height:1.6;color:var(--rk-ink-3,#5e5e5e)}
      .rk-media-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}
      .rk-media-row input,.rk-media-row select{height:30px;padding:0 8px;border:1px solid var(--rk-border-strong,rgba(31,31,31,.14));border-radius:6px;font:inherit;font-size:12px;color:var(--rk-ink-1,#1f1f1f);outline:none;background:#fff}
      .rk-media-row button{height:30px;padding:0 14px;border:none;border-radius:8px;background:var(--rk-accent,#0b57d0);color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
      .rk-media-row button:hover{opacity:.9}
      .rk-media-table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:10px}
      .rk-media-table th{text-align:left;padding:6px 8px;color:var(--rk-ink-3,#5e5e5e);font-weight:500;border-bottom:1px solid var(--rk-border,#e2e8f1)}
      .rk-media-table td{padding:6px 8px;border-bottom:1px solid var(--rk-border,#e2e8f1);color:var(--rk-ink-1,#1f1f1f)}
      .rk-media-table select{height:28px;padding:0 6px;border:1px solid var(--rk-border-strong,rgba(31,31,31,.14));border-radius:6px;font:inherit;font-size:11.5px;color:var(--rk-ink-1,#1f1f1f);outline:none;background:#fff}
      .rk-media-empty{padding:32px 20px;text-align:center;color:var(--rk-ink-3,#5e5e5e);font-size:12.5px;line-height:1.8}
    `;
    document.head.append(style);
  }

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
    const menu = findGroupMenu("基础配置");
    if (!menu || menu.querySelector(`[${MARK}]`)) return;
    // 克隆「周边城市设置」的菜单项（样式/图标一致），插到它后面
    const anchor = [...menu.querySelectorAll(".el-menu-item")].find((item) =>
      item.textContent.includes("周边城市设置"),
    );
    const template = anchor || menu.querySelector(".el-menu-item");
    if (!template) return;
    const entry = template.cloneNode(true);
    entry.className = "el-menu-item";
    entry.setAttribute(MARK, "1");
    entry.style.display = "";
    const label = entry.querySelector("span") || entry;
    if (entry.querySelector("span")) entry.querySelector("span").textContent = "素材库";
    else label.textContent = "素材库";
    entry.removeAttribute("id");
    entry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPage();
    });
    // 周边城市设置下面；找不到锚点就追加到组末尾
    if (anchor && anchor.nextSibling) menu.insertBefore(entry, anchor.nextSibling);
    else menu.append(entry);
    entryEl = entry;
  }

  function openPage() {
    const mainScroll = document.querySelector(".main-scroll");
    if (!mainScroll || pageEl) return;
    injectStyle();
    for (const item of document.querySelectorAll(".sidebar .el-menu-item")) {
      if (item === entryEl) item.classList.add("is-active");
      else item.classList.remove("is-active");
    }
    mainScroll.classList.add("rk-media-page-mode");
    pageEl = document.createElement("div");
    pageEl.className = "rk-media-page";
    mainScroll.append(pageEl);
    paintPage();
  }

  function closePage() {
    if (pageEl) { pageEl.remove(); pageEl = null; }
    document.querySelector(".main-scroll")?.classList.remove("rk-media-page-mode");
    if (entryEl) entryEl.classList.remove("is-active");
  }

  function watchLeave() {
    document.querySelector(".sidebar")?.addEventListener(
      "click",
      (event) => {
        const item = event.target.closest(".el-menu-item");
        if (item && item.hasAttribute(MARK)) return;
        if (item || event.target.closest(".el-sub-menu__title")) closePage();
      },
      true,
    );
    window.addEventListener("popstate", closePage);
  }

  async function paintPage() {
    if (!pageEl) return;
    pageEl.innerHTML = "";
    let mediaList = [];
    let positionList = [];
    try {
      const [media, positions] = await Promise.all([
        api("GET", "/api/v1/media"),
        api("GET", "/api/v1/service-positions?page=1&page_size=100").catch(() => ({ items: [] })),
      ]);
      mediaList = media.items || [];
      positionList = (positions.items || []).map((p) => ({ id: Number(p.id), name: String(p.position_name || p.id) }));
    } catch (error) {
      pageEl.innerHTML = `<div class="rk-media-empty">加载失败：${escapeHtml(error.message)}</div>`;
      return;
    }

    const card = document.createElement("div");
    card.className = "rk-media-card";
    card.innerHTML = `<b>岗位素材库（图/视频发给客户用）</b>`;
    const hint = document.createElement("p");
    hint.className = "rk-media-hint";
    hint.textContent =
      "通用素材（工作内容/宿舍/安检视频）所有岗位共用；面试地点图这类各城市不同的，绑定到具体岗位——Agent 只会发本岗位绑定的图。客户问路线时 Agent 自动发对应素材。绑定改了即时生效。";
    card.append(hint);

    const table = document.createElement("table");
    table.className = "rk-media-table";
    const bindOptions = (current) =>
      `<option value="0" ${!current ? "selected" : ""}>通用（所有岗位）</option>` +
      positionList
        .map((p) => `<option value="${p.id}" ${Number(current) === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
        .join("");
    const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB");
    if (!mediaList.length) {
      table.innerHTML = `<tbody><tr><td class="rk-media-empty">还没有素材，用下方表单上传第一张图/视频。</td></tr></tbody>`;
    } else {
      table.innerHTML =
        `<thead><tr><th>素材名</th><th>类型</th><th>大小</th><th>绑定岗位（改了即时生效）</th></tr></thead><tbody></tbody>`;
      const tbody = table.querySelector("tbody");
      for (const m of mediaList) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          `<td>${escapeHtml(m.name)}</td>` +
          `<td>${m.kind === "video" ? "视频" : "图片"}</td>` +
          `<td>${fmtSize(Number(m.bytes || 0))}</td>`;
        const td = document.createElement("td");
        const sel = document.createElement("select");
        sel.innerHTML = bindOptions(m.position_id);
        sel.addEventListener("change", async () => {
          sel.disabled = true;
          try {
            await api("PUT", `/api/v1/media/${m.id}/binding`, { position_id: Number(sel.value) });
            m.position_id = Number(sel.value);
          } catch (error) {
            sel.value = String(m.position_id || 0);
          }
          sel.disabled = false;
        });
        td.append(sel);
        tr.append(td);
        tbody.append(tr);
      }
    }
    card.append(table);

    const row = document.createElement("div");
    row.className = "rk-media-row";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*,video/*";
    const nameInput = document.createElement("input");
    nameInput.placeholder = "素材名（Agent 按这个名字发，默认用文件名）";
    nameInput.style.flex = "1 1 260px";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file && !nameInput.value.trim()) nameInput.value = file.name;
    });
    const upSel = document.createElement("select");
    upSel.innerHTML = bindOptions(0);
    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.textContent = "上传素材";
    upBtn.addEventListener("click", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) { upBtn.textContent = "先选文件"; return; }
      const kind = file.type.startsWith("video") ? "video" : "image";
      if (kind === "video" && file.size > 50 * 1048576) { upBtn.textContent = "视频超 50MB"; return; }
      const name = nameInput.value.trim() || file.name;
      upBtn.disabled = true;
      upBtn.textContent = "上传中…";
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64 = String(reader.result || "").split(",")[1] || "";
          await api("POST", "/api/v1/media", {
            name, kind, data_base64: base64, position_id: Number(upSel.value) || 0,
          });
          upBtn.textContent = "已上传 ✓";
          fileInput.value = "";
          nameInput.value = "";
          await paintPage();
        } catch (error) {
          upBtn.textContent = "失败：" + error.message;
        }
        setTimeout(() => { upBtn.textContent = "上传素材"; upBtn.disabled = false; }, 2200);
      };
      reader.readAsDataURL(file);
    });
    row.append(fileInput, nameInput, upSel, upBtn);
    card.append(row);
    pageEl.append(card);
  }

  function start() {
    injectStyle();
    mountEntry();
    watchLeave();
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

/**
 * 基础配置面板（2026-11-17）：侧栏「基础配置」入口 → 居中大面板。
 *
 * 为什么独立出来：面试登记抽屉只负责面试相关（清单/群聊/到达状态），
 * 素材库这类系统级配置混在里面职责不清（用户明确拆分）。
 *
 * 现有配置：岗位素材库（媒体分层：通用池 + 岗位专属，上传/绑定）。
 * 后续其他系统级配置（话术库管理等）加进这个面板即可。
 *
 * 修改方式说明（用户问过）：线上后台是编译好的 Vue 包（仓库无 .vue 源码），
 * 本脚本与 nav-adjust / archive-panel 等一样是运行时 DOM 注入补丁，
 * 编译包一个字节不动。
 */
(function () {
  "use strict";

  const ENTRY_ID = "rk-media-entry";
  let maskEl = null;

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

  function injectStyle() {
    if (document.getElementById("rk-media-style")) return;
    const style = document.createElement("style");
    style.id = "rk-media-style";
    style.textContent = `
      .rk-media-entry{display:flex;align-items:center;gap:10px;width:100%;margin:4px 0 6px;padding:0 14px;height:32px;border:1px solid var(--rk-border,#e2e8f1);border-radius:8px;background:var(--rk-accent-soft,#d3e3fd);color:var(--rk-accent,#0b57d0);cursor:pointer;font:inherit;font-size:12px;font-weight:600;text-align:left;transition:opacity .15s ease}
      .rk-media-entry:hover{opacity:.85}
      .rk-media-mask{position:fixed;inset:0;z-index:4000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(4,30,73,.32);backdrop-filter:blur(6px)}
      .rk-media-panel{display:flex;flex-direction:column;width:min(1100px,100%);max-height:100%;border-radius:22px;background:var(--rk-bg,#fff);box-shadow:var(--gl-shadow-float,0 24px 60px -24px rgba(20,40,90,.45));overflow:hidden}
      html.rk-media-locked,html.rk-media-locked body{overflow:hidden}
      .rk-media-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 26px 14px;border-bottom:1px solid var(--rk-border,#e2e8f1)}
      .rk-media-head h2{margin:0;font-size:17px;font-weight:600;color:var(--rk-ink-1,#1f1f1f)}
      .rk-media-head p{margin:4px 0 0;font-size:12px;color:var(--rk-ink-3,#5e5e5e)}
      .rk-media-close{flex:0 0 auto;width:30px;height:30px;border:1px solid var(--rk-border-strong,rgba(31,31,31,.14));border-radius:8px;background:transparent;color:var(--rk-ink-2,#5e5e5e);font-size:15px;cursor:pointer}
      .rk-media-close:hover{background:var(--rk-panel-2,#f0f4f9)}
      .rk-media-body{flex:1;min-height:0;overflow:auto;padding:16px 26px 24px}
      .rk-media-group{padding:12px 14px;border:1px solid var(--rk-border,#e2e8f1);border-radius:10px;background:var(--rk-bg,#fff)}
      .rk-media-group b{font-size:12.5px;color:var(--rk-ink-1,#1f1f1f)}
      .rk-media-hint{margin:8px 0 0;font-size:11.5px;line-height:1.6;color:var(--rk-ink-3,#5e5e5e)}
      .rk-media-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}
      .rk-media-row input,.rk-media-row select{height:30px;padding:0 8px;border:1px solid var(--rk-border-strong,rgba(31,31,31,.14));border-radius:6px;font:inherit;font-size:12px;color:var(--rk-ink-1,#1f1f1f);outline:none;background:#fff}
      .rk-media-row button{height:30px;padding:0 14px;border:none;border-radius:8px;background:var(--rk-accent,#0b57d0);color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
      .rk-media-row button:hover{opacity:.9}
      .rk-media-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px}
      .rk-media-table th{text-align:left;padding:6px 8px;color:var(--rk-ink-3,#5e5e5e);font-weight:500;border-bottom:1px solid var(--rk-border,#e2e8f1)}
      .rk-media-table td{padding:6px 8px;border-bottom:1px solid var(--rk-border,#e2e8f1);color:var(--rk-ink-1,#1f1f1f)}
      .rk-media-table select{height:28px;padding:0 6px;border:1px solid var(--rk-border-strong,rgba(31,31,31,.14));border-radius:6px;font:inherit;font-size:11.5px;color:var(--rk-ink-1,#1f1f1f);outline:none;background:#fff}
      .rk-media-empty{padding:32px 20px;text-align:center;color:var(--rk-ink-3,#5e5e5e);font-size:12.5px;line-height:1.8}
    `;
    document.head.append(style);
  }

  function closePanel() {
    if (maskEl) { maskEl.remove(); maskEl = null; }
    document.documentElement.classList.remove("rk-media-locked");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch] || ch));
  }

  async function paintBody() {
    const body = document.getElementById("rk-media-body");
    if (!body || !maskEl) return;
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
      body.textContent = "加载失败：" + error.message;
      return;
    }
    body.innerHTML = "";

    // ── 岗位素材库 ──
    const group = document.createElement("div");
    group.className = "rk-media-group";
    group.innerHTML = `<b>岗位素材库（图/视频发给客户用）</b>`;
    const hint = document.createElement("p");
    hint.className = "rk-media-hint";
    hint.textContent = "通用素材（工作内容/宿舍/安检视频）所有岗位共用；面试地点图这类各城市不同的，绑定到具体岗位——Agent 只会发本岗位绑定的图，客户问路线时自动发对应素材。绑定改了即时生效，无需重启。";
    group.append(hint);

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
    group.append(table);

    // ── 上传 ──
    const row = document.createElement("div");
    row.className = "rk-media-row";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*,video/*";
    const nameInput = document.createElement("input");
    nameInput.placeholder = "素材名（客户问路线时 Agent 按这个名字发，默认用文件名）";
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
          await paintBody();
        } catch (error) {
          upBtn.textContent = "失败：" + error.message;
        }
        setTimeout(() => { upBtn.textContent = "上传素材"; upBtn.disabled = false; }, 2200);
      };
      reader.readAsDataURL(file);
    });
    row.append(fileInput, nameInput, upSel, upBtn);
    group.append(row);
    body.append(group);
  }

  function openPanel() {
    closePanel();
    injectStyle();
    maskEl = document.createElement("div");
    maskEl.className = "rk-media-mask";
    const panel = document.createElement("div");
    panel.className = "rk-media-panel";
    const head = document.createElement("div");
    head.className = "rk-media-head";
    const headText = document.createElement("div");
    headText.append(Object.assign(document.createElement("h2"), { textContent: "基础配置" }));
    headText.append(Object.assign(document.createElement("p"), { textContent: "系统级配置：岗位素材库（媒体绑定）等。后续话术库管理等配置也放这里。" }));
    head.append(headText);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "rk-media-close";
    close.textContent = "×";
    close.addEventListener("click", closePanel);
    head.append(close);
    panel.append(head);
    const body = document.createElement("div");
    body.className = "rk-media-body";
    body.id = "rk-media-body";
    panel.append(body);
    maskEl.append(panel);
    maskEl.addEventListener("click", (event) => {
      if (event.target === maskEl) closePanel();
    });
    document.documentElement.classList.add("rk-media-locked");
    document.body.append(maskEl);
    paintBody();
  }

  function mountEntry() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar || document.getElementById(ENTRY_ID)) return;
    const entry = document.createElement("button");
    entry.id = ENTRY_ID;
    entry.type = "button";
    entry.className = "rk-media-entry";
    entry.textContent = "基础配置";
    entry.addEventListener("click", openPanel);
    // 挂进「坐席运营」分组（面试登记旁边），分组未渲染时退回侧栏末尾
    let host = null;
    for (const sub of sidebar.querySelectorAll(".el-sub-menu")) {
      const title = sub.querySelector(".el-sub-menu__title");
      if (title && title.textContent.includes("坐席运营")) {
        const inner = sub.querySelector(".el-menu");
        host = inner || null;
        break;
      }
    }
    if (!host) host = sidebar.querySelector(".sidebar-menu") || sidebar;
    host.append(entry);
  }

  function start() {
    injectStyle();
    mountEntry();
    new MutationObserver(() => {
      if (!document.getElementById(ENTRY_ID)) {
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

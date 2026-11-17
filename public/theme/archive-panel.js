{
  // 面试登记面板（2026-11-17）：侧栏注入「面试登记」入口，点开右侧抽屉。
  //
  // 数据：GET /api/v1/agent/archive/list（管理员）——Agent 会话链路把客户
  // 姓名/电话/面试时间抽进 agent_archive 后，这里列出登记清单；设备绑定的
  // 群聊（data_json.group_chat）收到「时间+姓名+电话」的推送通知。
  //
  // 本面板同时负责群聊绑定配置：选设备 → 填群聊名 → 保存走
  // PUT /api/v1/agent/devices/:id（浅合并 data_json，与 device-factories 同）。
  //
  // DOM 注入模式与 factory-overview.js 相同：侧栏入口 + MutationObserver 兜底。

  const ENTRY_ID = "rk-arch-entry";
  const STYLE_ID = "rk-arch-style";
  const api = async (method, path, body) => {
    let token = "";
    try { token = String(localStorage.getItem("token") || ""); } catch {}
    if (token.length > 1 && token.startsWith('"')) { try { token = JSON.parse(token); } catch {} }
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = "Bearer " + token;
    const response = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .rk-arch-entry{width:100%;height:34px;margin-top:8px;padding:0 14px;border:1px solid var(--rk-border,#e2e8f1);border-radius:var(--gl-r-control,8px);background:var(--rk-accent-soft,#d3e3fd);color:var(--rk-accent,#0b57d0);cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;display:flex;align-items:center;justify-content:center;transition:opacity .15s ease}
      .rk-arch-entry:hover{opacity:.85}
      .rk-arch-mask{position:fixed;inset:0;z-index:4000;display:flex;justify-content:flex-end;background:rgba(18,28,52,.26);backdrop-filter:blur(6px) saturate(1.2)}
      .rk-arch-panel{display:flex;flex-direction:column;width:min(640px,100%);height:100%;border:1px solid var(--gl-edge,#e2e8f1);border-radius:var(--gl-r-shell,14px) 0 0 var(--gl-r-shell);background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(250,252,255,.9));backdrop-filter:var(--gl-blur,blur(14px));box-shadow:var(--gl-shadow-float,0 24px 60px -24px rgba(20,40,90,.45))}
      .rk-arch-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--rk-border,#e2e8f1)}
      .rk-arch-head h2{margin:0;font-size:17px;font-weight:600;color:var(--rk-ink-1,#1f1f1f)}
      .rk-arch-head p{margin:4px 0 0;font-size:12px;color:var(--rk-ink-3,#5e5e5e)}
      .rk-arch-close{width:30px;height:30px;border:0;background:transparent;color:var(--rk-ink-2,#444746);font-size:20px;cursor:pointer;border-radius:999px}
      .rk-arch-close:hover{background:rgba(31,41,64,.06)}
      .rk-arch-body{flex:1;overflow:auto;padding:14px 20px 20px}
      .rk-arch-group{margin-top:14px;padding:12px 14px;border:1px solid var(--rk-border,#e2e8f1);border-radius:10px;background:var(--rk-bg,#fff)}
      .rk-arch-group b{font-size:12.5px;color:var(--rk-ink-1,#1f1f1f)}
      .rk-arch-row{display:flex;gap:8px;margin-top:8px}
      .rk-arch-row select,.rk-arch-row input{flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--rk-border-strong,rgba(31,31,31,.14));border-radius:8px;font:inherit;font-size:13px;color:var(--rk-ink-1,#1f1f1f);outline:none}
      .rk-arch-row select:focus,.rk-arch-row input:focus{border-color:var(--rk-accent,#0b57d0)}
      .rk-arch-row button{flex:0 0 auto;height:32px;padding:0 14px;border:0;border-radius:8px;background:var(--rk-grad-primary,linear-gradient(110deg,#0842a0,#0b57d0));color:#fff;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600}
      .rk-arch-row button:disabled{opacity:.55;cursor:default}
      .rk-arch-hint{margin:8px 0 0;font-size:11.5px;line-height:1.6;color:var(--rk-ink-3,#5e5e5e)}
      .rk-arch-table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12.5px;color:var(--rk-ink-1,#1f1f1f)}
      .rk-arch-table th{padding:8px 10px;text-align:left;background:var(--rk-panel-2,#f0f4f9);color:var(--rk-ink-2,#444746);font-weight:600;border-bottom:1px solid var(--rk-border,#e2e8f1);white-space:nowrap}
      .rk-arch-table td{padding:8px 10px;border-bottom:1px solid var(--rk-border,#e2e8f1);vertical-align:top}
      .rk-arch-pill{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}
      .rk-arch-pill.sent{background:#c4eed0;color:#146c2e}
      .rk-arch-pill.queued{background:#d3e3fd;color:#0b57d0}
      .rk-arch-pill.failed{background:#fce8e6;color:#b3261e}
      .rk-arch-pill.no-group,.rk-arch-pill.incomplete,.rk-arch-pill.pending{background:#fef0c7;color:#a14f00}
      .rk-arch-empty{padding:36px 16px;text-align:center;color:var(--rk-ink-3,#5e5e5e);font-size:13px;line-height:1.8}
      .rk-arch-confirmed{color:#146c2e;font-weight:600}
      .rk-arch-unconfirmed{color:#a14f00}
    `;
    document.head.append(style);
  }

  let maskEl = null;

  function closePanel() {
    if (maskEl) { maskEl.remove(); maskEl = null; }
  }

  function pillClass(status) {
    return ["sent", "queued", "failed", "no-group", "incomplete", "pending"].includes(status) ? status : "pending";
  }

  const STATUS_TEXT = {
    sent: "已推送群聊", queued: "待设备发送", failed: "推送失败",
    no_group: "未绑定群聊", incomplete: "信息未齐", pending: "待推送",
  };

  function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[ch]);
  }

  async function paintBody() {
    const body = document.getElementById("rk-arch-body");
    if (!body || !maskEl) return;
    try {
      const [archive, devices] = await Promise.all([
        api("GET", "/api/v1/agent/archive/list"),
        api("GET", "/api/v1/agent/devices"),
      ]);
      const items = archive.items || [];
      const deviceList = devices.items || [];
      body.innerHTML = "";

      // ── 群聊绑定配置 ──
      const group = document.createElement("div");
      group.className = "rk-arch-group";
      group.innerHTML = `<b>设备绑定群聊（登记完成后自动推送「时间+姓名+电话」）</b>`;
      const row = document.createElement("div");
      row.className = "rk-arch-row";
      const select = document.createElement("select");
      select.innerHTML = `<option value="">选择设备…</option>` + deviceList
        .map((d) => `<option value="${escapeHtml(d.device_code)}">${escapeHtml(d.name || d.device_code)}</option>`)
        .join("");
      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.textContent = "读取群聊";
      const select2 = document.createElement("select");
      select2.innerHTML = `<option value="">先读群聊再选…</option>`;
      select2.disabled = true;
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.textContent = "保存绑定";
      saveBtn.disabled = true;
      const current = deviceList.find((d) => d.group_chat) || deviceList[0];
      if (current && current.group_chat) {
        select2.innerHTML = `<option value="${escapeHtml(current.group_chat)}">${escapeHtml(current.group_chat)}（当前）</option>`;
        saveBtn.disabled = false;
      }
      loadBtn.addEventListener("click", async () => {
        const code = select.value;
        if (!code) { loadBtn.textContent = "先选设备"; return; }
        loadBtn.disabled = true;
        loadBtn.textContent = "读取中…";
        try {
          const res = await api("GET", `/api/v1/agent/devices/${code}/groups`);
          const groups = res.items || [];
          select2.innerHTML = groups.length
            ? `<option value="">选择群聊…</option>` + groups
                .map((g) => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`)
                .join("")
            : `<option value="">企微里没有群聊（先建群再读）</option>`;
          select2.disabled = false;
          loadBtn.textContent = "读取群聊";
          // 选了设备后把当前绑定值预填
          const target = deviceList.find((d) => d.device_code === code);
          if (target && target.group_chat) select2.value = target.group_chat;
        } catch (error) {
          loadBtn.textContent = "读取失败";
        }
        loadBtn.disabled = false;
      });
      select.addEventListener("change", () => { loadBtn.textContent = "读取群聊"; });
      saveBtn.addEventListener("click", async () => {
        const code = select.value;
        const groupChat = select2.value.trim();
        if (!code) { saveBtn.textContent = "先选设备"; return; }
        if (!groupChat) { saveBtn.textContent = "先读群聊再选"; return; }
        saveBtn.disabled = true;
        saveBtn.textContent = "保存中…";
        try {
          const target = deviceList.find((d) => d.device_code === code);
          await api("PUT", `/api/v1/agent/devices/${target.id}`, { group_chat: groupChat });
          saveBtn.textContent = "已保存 ✓";
          await paintBody();
        } catch (error) {
          saveBtn.textContent = "保存失败";
        }
        setTimeout(() => { saveBtn.textContent = "保存绑定"; saveBtn.disabled = false; }, 1800);
      });
      row.append(select, loadBtn, select2, saveBtn);
      group.append(row);
      const hint = document.createElement("p");
      hint.className = "rk-arch-hint";
      hint.textContent = "群聊名要与企微里的群聊名称完全一致（发送时按名字搜索会话）。Agent 登记客户面试信息（姓名+电话齐全）后，会自动把「时间+姓名+电话」发到这个群。";
      group.append(hint);
      body.append(group);

      // ── 登记清单 ──
      const title = document.createElement("div");
      title.style.cssText = "margin:18px 0 0;font-size:13px;font-weight:700;color:var(--rk-ink-1,#1f1f1f)";
      title.textContent = `面试登记清单（${items.length} 条，按更新时间倒序）`;
      body.append(title);

      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "rk-arch-empty";
        empty.textContent = "还没有登记记录。\nAgent 对话里收集到客户的姓名、电话、面试时间后，会自动出现在这里并推送群聊。";
        body.append(empty);
        return;
      }
      const table = document.createElement("table");
      table.className = "rk-arch-table";
      table.innerHTML = `
        <thead><tr>
          <th>面试时间</th><th>姓名</th><th>电话</th><th>客户</th>
          <th>设备</th><th>确认</th><th>群聊通知</th><th>更新时间</th>
        </tr></thead>
        <tbody>` + items.map((it) => `
        <tr>
          <td>${escapeHtml((it.interview_date || "") + " " + (it.interview_time || "") || "—")}</td>
          <td>${escapeHtml(it.name || "—")}</td>
          <td>${escapeHtml(it.phone || "—")}</td>
          <td>${escapeHtml(it.customer_nickname || "—")}</td>
          <td>${escapeHtml(it.device_code || "—")}</td>
          <td><span class="${it.interview_confirmed ? "rk-arch-confirmed" : "rk-arch-unconfirmed"}">${it.interview_confirmed ? "已确认" : "待确认"}</span></td>
          <td><span class="rk-arch-pill ${pillClass(it.notify_status)}">${STATUS_TEXT[pillClass(it.notify_status)] || it.notify_status}</span></td>
          <td style="color:var(--rk-ink-3,#5e5e5e)">${escapeHtml(String(it.updated_at || "").replace("T", " ").slice(0, 16))}</td>
        </tr>`).join("") + `</tbody>`;
      body.append(table);
    } catch (error) {
      const body2 = document.getElementById("rk-arch-body");
      if (body2) {
        body2.innerHTML = "";
        const empty = document.createElement("div");
        empty.className = "rk-arch-empty";
        empty.textContent = "加载失败：" + error.message + "（点入口重试）";
        body2.append(empty);
      }
    }
  }

  function openPanel() {
    closePanel();
    injectStyle();
    maskEl = document.createElement("div");
    maskEl.className = "rk-arch-mask";
    const panel = document.createElement("div");
    panel.className = "rk-arch-panel";
    const head = document.createElement("div");
    head.className = "rk-arch-head";
    const headText = document.createElement("div");
    headText.append(Object.assign(document.createElement("h2"), { textContent: "面试登记" }));
    headText.append(Object.assign(document.createElement("p"), { textContent: "Agent 登记的客户面试档案 + 群聊自动通知" }));
    head.append(headText);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "rk-arch-close";
    close.textContent = "×";
    close.addEventListener("click", closePanel);
    head.append(close);
    panel.append(head);
    const body = document.createElement("div");
    body.className = "rk-arch-body";
    body.id = "rk-arch-body";
    body.append(Object.assign(document.createElement("div"), { className: "rk-arch-empty", textContent: "加载中…" }));
    panel.append(body);
    maskEl.append(panel);
    maskEl.addEventListener("click", (event) => { if (event.target === maskEl) closePanel(); });
    document.addEventListener("keydown", function esc(event) {
      if (event.key === "Escape") { closePanel(); document.removeEventListener("keydown", esc); }
    });
    document.body.append(maskEl);
    paintBody();
  }

  function mountEntry() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar || document.getElementById(ENTRY_ID)) return;
    const menu = sidebar.querySelector(".sidebar-menu") || sidebar;
    const entry = document.createElement("button");
    entry.id = ENTRY_ID;
    entry.type = "button";
    entry.className = "rk-arch-entry";
    entry.textContent = "面试登记";
    entry.addEventListener("click", openPanel);
    menu.append(entry);
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
}

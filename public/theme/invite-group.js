/**
 * 内部邀约群配置（R1，2026-11-15）。
 *
 * 客户原话：「求职者给你发了这些什么名单之类的，OK 我们就自动去录名单，
 * 然后按照这个格式去发就行了」。格式是 `深11/9 谢子鑫 18077352958`。
 *
 * 为什么要有这个面板：后端本轮已实现「四要素齐全 → 自动发群」，但配置只能
 * 通过 PUT /api/v1/agent/invite-group 写入，运营在页面上没有入口 —— 等于功能
 * 没上线。这里沿用 kb-console.js / factory-overview.js 的既有做法：侧栏注入
 * 一个入口，点开是覆盖式面板，直接打接口，不动编译后的 Vue bundle。
 *
 * 城市简写按客户给的实际写法（深=深圳、万=万江），不做自动推导；
 * 映射里没有的城市取城市名首字兜底（佛山 → 佛），并在提示里说明。
 *
 * 数据源：
 *   GET /api/v1/agent/invite-group        → {enabled,groupName,deviceCode,cityAbbr}
 *   PUT /api/v1/agent/invite-group        → 同上（写入后回读）
 *   GET /api/v1/agent/invite-group/sends  → {items:[{content,status,error,created_at,group_name}]}
 *   GET /api/v1/agent/devices             → {items:[{device_code,name,online}]}
 */
{
  const ENTRY_ID = "rk-ig-entry";
  const STYLE_ID = "rk-ig-style";
  const TOKEN_KEY = "token";
  const TAG = "[invite-group]";

  function log() {
    try { console.info.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ 鉴权 / 请求 --
  // bundle 把 token 存进 localStorage["token"]，偶尔被 JSON.stringify 包一层引号。
  function readToken() {
    try {
      var raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return "";
      var value = String(raw).trim();
      if (value.length > 1 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
        try { value = JSON.parse(value); } catch (e) { value = value.slice(1, -1); }
      }
      return typeof value === "string" ? value.trim() : "";
    } catch (e) { return ""; }
  }

  function api(method, path, body) {
    var headers = { Accept: "application/json" };
    var token = readToken();
    if (token) headers.Authorization = "Bearer " + token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (res) {
        return res.text().then(function (raw) {
          var data = null;
          if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { detail: raw }; } }
          if (!res.ok) {
            var detail = data && data.detail;
            if (Array.isArray(detail)) detail = detail.map(function (d) { return d && (d.msg || d.type); }).join("; ");
            var error = new Error(typeof detail === "string" ? detail : "请求失败 " + res.status);
            error.status = res.status;
            throw error;
          }
          return data;
        });
      });
  }

  // --------------------------------------------------------------- 小工具 --
  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // 一律 textContent：群名和城市名可能带尖括号，绝不拼 innerHTML。
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }
  function text(value) { return value === undefined || value === null ? "" : String(value); }

  // 与后端 src/shared/invite-group.ts 同一套规则，页面只用于预览，不参与发送。
  function cityAbbrOf(city, mapping) {
    var name = text(city).trim();
    if (!name) return "";
    var bare = name.replace(/市$/, "");
    return mapping[name] || mapping[bare] || bare.slice(0, 1);
  }
  function monthDayOf(date) {
    var match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text(date).trim());
    if (!match) return "";
    return Number(match[2]) + "/" + Number(match[3]);
  }

  // ---------------------------------------------------------------- 样式 --
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".rk-ig-entry{display:flex;align-items:center;gap:8px;margin:6px 10px;padding:9px 12px;border:0;border-radius:10px;background:transparent;color:var(--rk-ink-2,#4a5568);font:inherit;font-size:13px;cursor:pointer;text-align:left;width:calc(100% - 20px)}",
      ".rk-ig-entry:hover{background:rgba(99,132,255,.10);color:var(--rk-ink-1,#1a202c)}",
      ".rk-ig-entry::before{content:'';width:6px;height:6px;border-radius:50%;background:#4c6ef5;flex:0 0 auto}",
      ".rk-ig-overlay{position:fixed;inset:0;background:rgba(15,23,42,.44);display:flex;align-items:center;justify-content:center;z-index:4200;padding:24px}",
      ".rk-ig-overlay[hidden]{display:none}",
      ".rk-ig-sheet{background:#fff;border-radius:16px;width:min(760px,100%);max-height:min(86vh,860px);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(15,23,42,.28)}",
      ".rk-ig-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 22px;border-bottom:1px solid #edf0f5}",
      ".rk-ig-head h2{margin:0;font-size:17px;color:#111827}",
      ".rk-ig-sub{margin:4px 0 0;font-size:12px;color:#6b7280;line-height:1.6}",
      ".rk-ig-close{border:1px solid #e5e7eb;background:#fff;border-radius:8px;padding:6px 12px;font-size:12px;color:#4b5563;cursor:pointer}",
      ".rk-ig-body{padding:18px 22px 24px;overflow:auto;display:flex;flex-direction:column;gap:18px}",
      ".rk-ig-field{display:flex;flex-direction:column;gap:6px}",
      ".rk-ig-label{font-size:12px;color:#374151;font-weight:600}",
      ".rk-ig-hint{font-size:11px;color:#6b7280;line-height:1.6}",
      ".rk-ig-input,.rk-ig-select{border:1px solid #dfe3ea;border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;color:#111827;background:#fff}",
      ".rk-ig-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}",
      ".rk-ig-check{display:flex;align-items:center;gap:8px;font-size:13px;color:#111827}",
      ".rk-ig-abbr-list{display:flex;flex-direction:column;gap:8px}",
      ".rk-ig-abbr-row{display:grid;grid-template-columns:1fr 90px auto;gap:8px;align-items:center}",
      ".rk-ig-btn{border:0;border-radius:8px;padding:8px 14px;font:inherit;font-size:13px;cursor:pointer}",
      ".rk-ig-btn-primary{background:#3b5bdb;color:#fff}",
      ".rk-ig-btn-ghost{background:#f3f4f6;color:#374151}",
      ".rk-ig-btn:disabled{opacity:.6;cursor:default}",
      ".rk-ig-preview{background:#f8fafc;border:1px dashed #d7ddea;border-radius:10px;padding:12px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#1f2937;white-space:pre-wrap}",
      ".rk-ig-table{width:100%;border-collapse:collapse;font-size:12px}",
      ".rk-ig-table th{text-align:left;color:#6b7280;font-weight:600;padding:6px 8px;border-bottom:1px solid #edf0f5}",
      ".rk-ig-table td{padding:6px 8px;border-bottom:1px solid #f3f4f6;color:#374151;vertical-align:top}",
      ".rk-ig-chip{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px}",
      ".rk-ig-chip[data-state=sent]{background:#dcfce7;color:#166534}",
      ".rk-ig-chip[data-state=failed]{background:#fee2e2;color:#991b1b}",
      ".rk-ig-chip[data-state=skipped]{background:#fef3c7;color:#92400e}",
      ".rk-ig-section-title{font-size:13px;font-weight:600;color:#111827;margin:0 0 8px}",
      ".rk-ig-status{font-size:12px;color:#6b7280;min-height:16px}",
    ].join("\n");
    document.head.appendChild(style);
  }

  // --------------------------------------------------------------- 面板 --
  var state = { open: false, devices: [], sends: [] };
  var panel = null;
  var form = {};

  function input(key, placeholder) {
    var node = document.createElement("input");
    node.className = "rk-ig-input";
    node.type = "text";
    node.placeholder = placeholder || "";
    form[key] = node;
    return node;
  }

  function field(label, control, hint) {
    var wrap = el("div", "rk-ig-field");
    if (label) wrap.appendChild(el("span", "rk-ig-label", label));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el("p", "rk-ig-hint", hint));
    return wrap;
  }

  function buildForm() {
    var wrap = el("section");
    wrap.appendChild(el("h3", "rk-ig-section-title", "群设置"));

    var enabledRow = el("label", "rk-ig-check");
    var enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.id = "rk-ig-enabled";
    enabledRow.appendChild(enabled);
    enabledRow.appendChild(el("span", null, "启用自动发群"));
    form.enabled = enabled;
    wrap.appendChild(field("", enabledRow, "关闭时名单只落库不发群，发送记录里记为「已跳过」。"));

    wrap.appendChild(field("群名称", input("groupName", "例如：内部邀约群"), "客户端会把这个名字输进企微搜索框来定位会话，必须和企微里的群名完全一致。只在「用客户端发群」时需要。"));

    // 群机器人 Webhook（推荐通道）：填了就走 HTTP POST，不依赖任何客户端。
    // 读回来是打码的（带 key 等同发送凭据），留空表示「不修改」。
    wrap.appendChild(field(
      "群机器人 Webhook（推荐）",
      input("webhookUrl", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."),
      "企业微信群里加「群机器人」后复制的地址。填了就优先走它：不依赖客户端、不用搜群名。地址会打码显示，留空表示不修改。",
    ));
    form.webhookHint = el("p", "rk-ig-hint", "");
    wrap.appendChild(form.webhookHint);

    var select = el("select", "rk-ig-select");
    select.id = "rk-ig-device";
    var auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "跟随候选人所在设备";
    select.appendChild(auto);
    form.deviceCode = select;
    wrap.appendChild(field("用哪台设备发", select, "一般留空。只有需要固定用某台电脑发群时才指定。"));

    var actions = el("div", "rk-ig-row");
    var save = el("button", "rk-ig-btn rk-ig-btn-primary", "保存设置");
    save.type = "button";
    save.addEventListener("click", function () { saveConfig(save); });
    actions.appendChild(save);
    form.status = el("span", "rk-ig-status", "");
    actions.appendChild(form.status);
    wrap.appendChild(actions);
    return wrap;
  }

  function buildMapSection() {
    var wrap = el("section");
    wrap.appendChild(el("h3", "rk-ig-section-title", "城市简写"));
    wrap.appendChild(el("p", "rk-ig-hint", "按群里实际写法填：深圳填「深」、万江填「万」。没配的城市取首字（佛山 → 佛）。"));
    var list = el("div", "rk-ig-abbr-list");
    form.mapList = list;
    wrap.appendChild(list);
    var add = el("button", "rk-ig-btn rk-ig-btn-ghost", "新增一行");
    add.type = "button";
    add.addEventListener("click", function () { addMapRow("", ""); });
    wrap.appendChild(add);
    return wrap;
  }

  function addMapRow(city, abbr) {
    if (!form.mapList) return;
    var row = el("div", "rk-ig-abbr-row");
    var cityInput = document.createElement("input");
    cityInput.className = "rk-ig-input";
    cityInput.placeholder = "城市名，如 深圳";
    cityInput.value = city;
    var abbrInput = document.createElement("input");
    abbrInput.className = "rk-ig-input";
    abbrInput.placeholder = "简写，如 深";
    abbrInput.value = abbr;
    var remove = el("button", "rk-ig-btn rk-ig-btn-ghost", "删除");
    remove.type = "button";
    remove.addEventListener("click", function () {
      row.remove();
      updatePreview();
    });
    cityInput.addEventListener("input", updatePreview);
    abbrInput.addEventListener("input", updatePreview);
    row.appendChild(cityInput);
    row.appendChild(abbrInput);
    row.appendChild(remove);
    form.mapList.appendChild(row);
  }

  function currentMap() {
    var map = {};
    if (!form.mapList) return map;
    var rows = form.mapList.querySelectorAll(".rk-ig-abbr-row");
    for (var i = 0; i < rows.length; i += 1) {
      var inputs = rows[i].querySelectorAll("input");
      var city = text(inputs[0] && inputs[0].value).trim();
      var abbr = text(inputs[1] && inputs[1].value).trim();
      if (city && abbr) map[city] = abbr;
    }
    return map;
  }

  function buildPreview() {
    var wrap = el("section");
    wrap.appendChild(el("h3", "rk-ig-section-title", "格式预览"));
    form.preview = el("div", "rk-ig-preview", "");
    wrap.appendChild(form.preview);
    wrap.appendChild(el("p", "rk-ig-hint", "用示例数据生成，方便核对简写和日期格式；实际发送取真实候选人字段。"));
    return wrap;
  }

  function updatePreview() {
    if (!form.preview) return;
    var map = currentMap();
    form.preview.textContent = cityAbbrOf("深圳", map) + monthDayOf("2026-11-09") + " 谢子鑫 18077352958";
  }

  function buildSends() {
    var wrap = el("section");
    wrap.appendChild(el("h3", "rk-ig-section-title", "最近发送记录"));
    form.sends = el("div");
    wrap.appendChild(form.sends);
    return wrap;
  }

  function renderSends() {
    if (!form.sends) return;
    form.sends.textContent = "";
    if (!state.sends.length) {
      form.sends.appendChild(el("p", "rk-ig-hint", "还没有发送记录。"));
      return;
    }
    var table = el("table", "rk-ig-table");
    var head = document.createElement("tr");
    ["时间", "内容", "状态"].forEach(function (label) {
      var th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    });
    table.appendChild(head);
    state.sends.slice(0, 20).forEach(function (row) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", null, text(row.created_at).replace("T", " ").slice(0, 19)));
      tr.appendChild(el("td", null, text(row.content) || "—"));
      var statusCell = document.createElement("td");
      var labels = { sent: "已发送", failed: "失败", skipped: "已跳过" };
      var chip = el("span", "rk-ig-chip", labels[text(row.status)] || text(row.status));
      chip.dataset.state = text(row.status);
      statusCell.appendChild(chip);
      if (text(row.error)) statusCell.appendChild(el("div", "rk-ig-hint", text(row.error)));
      tr.appendChild(statusCell);
      table.appendChild(tr);
    });
    form.sends.appendChild(table);
  }

  function buildPanel() {
    var root = el("div", "rk-ig-overlay");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "内部邀约群配置");
    root.hidden = true;

    var sheet = el("div", "rk-ig-sheet");

    var head = el("header", "rk-ig-head");
    var titleBox = el("div");
    titleBox.appendChild(el("h2", null, "内部邀约群"));
    titleBox.appendChild(el("p", "rk-ig-sub", "收齐姓名、手机号、面试日期、城市后，自动按「深11/9 谢子鑫 18077352958」的格式发到群里。"));
    head.appendChild(titleBox);
    var close = el("button", "rk-ig-close", "关闭");
    close.type = "button";
    close.addEventListener("click", function () { togglePanel(false); });
    head.appendChild(close);
    sheet.appendChild(head);

    var body = el("div", "rk-ig-body");
    body.appendChild(buildForm());
    body.appendChild(buildMapSection());
    body.appendChild(buildPreview());
    body.appendChild(buildSends());
    sheet.appendChild(body);

    root.appendChild(sheet);
    root.addEventListener("click", function (event) { if (event.target === root) togglePanel(false); });
    panel = root;
    document.body.appendChild(root);
    return root;
  }

  function fillConfig(config) {
    var cfg = config || {};
    if (form.enabled) form.enabled.checked = cfg.enabled === true;
    if (form.groupName) form.groupName.value = text(cfg.groupName);
    if (form.webhookUrl) form.webhookUrl.value = "";
    if (form.webhookHint) {
      const configured = cfg.webhookConfigured === true;
      form.webhookHint.textContent = configured
        ? `已配置：${text(cfg.webhookPreview) || "****"}（留空保存表示不修改）`
        : "尚未配置 Webhook；未配置时走客户端发群（需填群名）。";
      form.webhookHint.style.color = configured ? "#166534" : "#92400e";
    }
    if (form.deviceCode) {
      while (form.deviceCode.options.length > 1) form.deviceCode.remove(1);
      state.devices.forEach(function (device) {
        var option = document.createElement("option");
        option.value = text(device.device_code);
        option.textContent = (text(device.name) || text(device.device_code)) + (device.online ? "（在线）" : "（离线）");
        form.deviceCode.appendChild(option);
      });
      form.deviceCode.value = text(cfg.deviceCode);
    }
    if (form.mapList) {
      form.mapList.textContent = "";
      var map = cfg.cityAbbr && typeof cfg.cityAbbr === "object" ? cfg.cityAbbr : {};
      var keys = Object.keys(map);
      if (!keys.length) addMapRow("深圳", "");
      else keys.forEach(function (city) { addMapRow(city, text(map[city])); });
    }
    updatePreview();
  }

  function setStatus(message, isError) {
    if (!form.status) return;
    form.status.textContent = message || "";
    form.status.style.color = isError ? "#b91c1c" : "#166534";
  }

  function load() {
    return Promise.all([
      api("GET", "/api/v1/agent/invite-group").catch(function (error) { log("config failed", error && error.message); return {}; }),
      api("GET", "/api/v1/agent/devices").catch(function () { return { items: [] }; }),
      api("GET", "/api/v1/agent/invite-group/sends?limit=20").catch(function () { return { items: [] }; }),
    ]).then(function (results) {
      state.devices = (results[1] && results[1].items) || [];
      state.sends = (results[2] && results[2].items) || [];
      fillConfig(results[0]);
      renderSends();
    });
  }

  function saveConfig(button) {
    if (button) button.disabled = true;
    setStatus("保存中…", false);
    var payload = {
      enabled: form.enabled ? form.enabled.checked : false,
      group_name: form.groupName ? text(form.groupName.value).trim() : "",
      device_code: form.deviceCode ? text(form.deviceCode.value).trim() : "",
      city_abbr: currentMap(),
    };
    // 留空 = 不修改（读回来是打码值，不能拿它覆盖真值）；填了就校验并保存
    const webhookInput = form.webhookUrl ? text(form.webhookUrl.value).trim() : "";
    if (webhookInput) payload.webhook_url = webhookInput;
    api("PUT", "/api/v1/agent/invite-group", payload)
      .then(function (config) {
        fillConfig(config);
        setStatus("已保存", false);
      })
      .catch(function (error) {
        setStatus(error && error.message ? "保存失败：" + error.message : "保存失败", true);
      })
      .then(function () { if (button) button.disabled = false; });
  }

  function togglePanel(open) {
    if (open) {
      if (!panel) buildPanel();
      panel.hidden = false;
      state.open = true;
      load();
    } else if (panel) {
      panel.hidden = true;
      state.open = false;
    }
  }

  // ------------------------------------------------------------ 入口 --
  // 与 kb-console.js / factory-overview.js 同一套：找 .sidebar 把按钮追加进
  // .sidebar-menu，Vue 重渲染会冲掉注入节点，靠 MutationObserver 续挂。
  function mountEntry() {
    var sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    if (document.getElementById(ENTRY_ID)) return;
    var menu = sidebar.querySelector(".sidebar-menu") || sidebar;
    var entry = el("button", "rk-ig-entry");
    entry.id = ENTRY_ID;
    entry.type = "button";
    entry.appendChild(el("span", null, "内部邀约群"));
    entry.addEventListener("click", function () { togglePanel(true); });
    menu.appendChild(entry);
  }

  function start() {
    injectStyle();
    mountEntry();
    new MutationObserver(function () {
      if (!document.getElementById(ENTRY_ID)) {
        try { mountEntry(); } catch (e) { log("mount failed", e && e.message); }
      }
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && panel && !panel.hidden) togglePanel(false);
    });
    log("ready");
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

{
  // 知识库配置台：品类 / 区域 / 招工方 / 场景问答 / 模板包。
  //
  // 为什么不改 Vue 源码：public/ 里只有编译产物（93 个 chunk，无 sourcemap），
  // 没法加路由。所以沿用项目现有的注入层做法——在侧栏加一个入口，点开是
  // 覆盖式独立面板，直接打 /api/v1/verticals 等接口，和 Vue 主体互不干扰。
  //
  // 契约：docs/知识库方案-流程驱动-20261113.md §配置层
  const TAG = "[kb-console]";
  const TOKEN_KEY = "token";
  const ENTRY_ID = "rk-kb-entry";

  const TABS = [
    { key: "vertical", label: "品类", hint: "工厂 / 地铁 / 白领…一个品类一套话术" },
    { key: "location", label: "区域", hint: "省 → 市 → 区 → 工业区 → 面试点，层级不设死" },
    { key: "employer", label: "招工方", hint: "一个工业区十几家厂，靠这里分清" },
    { key: "faq", label: "场景问答", hint: "可以绑定到某个品类 / 城市 / 招工方" },
    { key: "template", label: "模板包", hint: "通用问答一键导入，导入后可单独改" },
  ];

  function log() {
    try { console.info.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
  }
  function warn() {
    try { console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
  }
  function safe(fn, label) {
    try { return fn(); } catch (e) { warn("failed:", label, e && e.message); return undefined; }
  }

  // ------------------------------------------------------------ 鉴权 / 请求 --
  // 和 realtime.js 同一套读法：bundle 存的是 localStorage["token"]，
  // 偶尔被 JSON.stringify 包了一层引号。
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
    return fetch(path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch (e) { data = { detail: raw }; }
        }
        if (!res.ok) {
          var detail = data && data.detail;
          if (Array.isArray(detail)) {
            detail = detail.map(function (d) { return d && (d.msg || d.type); }).join("; ");
          }
          var error = new Error(typeof detail === "string" ? detail : "请求失败 " + res.status);
          error.status = res.status;
          error.payload = data;
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
    // 一律用 textContent：运营填的厂名、答案都可能带尖括号，绝不拼 innerHTML。
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }
  function text(value) {
    return value === undefined || value === null ? "" : String(value);
  }
  function statusChip(status) {
    var on = status === "enabled" || status === "published";
    var chip = el("span", "rk-kb-chip", on ? "启用" : status);
    chip.dataset.state = on ? "on" : "off";
    return chip;
  }

  // --------------------------------------------------------------- 面板 --
  var state = { tab: "vertical", open: false, rows: [], lookups: { verticals: [], locations: [], employers: [] } };
  var panel = null;

  function buildPanel() {
    var root = el("div", "rk-kb-overlay");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "知识库配置");
    root.hidden = true;

    var sheet = el("div", "rk-kb-sheet");

    var head = el("header", "rk-kb-head");
    var titleBox = el("div", "rk-kb-title");
    titleBox.appendChild(el("h2", null, "知识库配置"));
    titleBox.appendChild(el("p", "rk-kb-sub", "先把品类、区域、招工方配清楚，客户问「包吃住吗」才不会串厂。"));
    head.appendChild(titleBox);
    var close = el("button", "rk-kb-close", "关闭");
    close.type = "button";
    close.addEventListener("click", function () { togglePanel(false); });
    head.appendChild(close);
    sheet.appendChild(head);

    var body = el("div", "rk-kb-body");

    var rail = el("nav", "rk-kb-rail");
    rail.setAttribute("aria-label", "知识库分组");
    TABS.forEach(function (tab) {
      var btn = el("button", "rk-kb-tab");
      btn.type = "button";
      btn.dataset.tab = tab.key;
      btn.appendChild(el("span", "rk-kb-tab-label", tab.label));
      btn.appendChild(el("span", "rk-kb-tab-hint", tab.hint));
      btn.addEventListener("click", function () { switchTab(tab.key); });
      rail.appendChild(btn);
    });
    body.appendChild(rail);

    var main = el("section", "rk-kb-main");
    main.appendChild(el("div", "rk-kb-hint"));
    main.appendChild(el("div", "rk-kb-list"));
    body.appendChild(main);

    sheet.appendChild(body);
    root.appendChild(sheet);
    root.addEventListener("click", function (event) {
      if (event.target === root) togglePanel(false);
    });
    document.body.appendChild(root);
    return root;
  }

  function ensurePanel() {
    if (!panel) panel = buildPanel();
    return panel;
  }

  function togglePanel(open) {
    var node = ensurePanel();
    state.open = open === undefined ? !state.open : !!open;
    node.hidden = !state.open;
    document.documentElement.classList.toggle("rk-kb-locked", state.open);
    if (state.open) {
      switchTab(state.tab);
      var close = node.querySelector(".rk-kb-close");
      if (close) close.focus();
    }
  }

  function switchTab(key) {
    state.tab = key;
    var node = ensurePanel();
    var buttons = node.querySelectorAll(".rk-kb-tab");
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].dataset.tab === key;
      buttons[i].classList.toggle("is-active", active);
      buttons[i].setAttribute("aria-current", active ? "page" : "false");
    }
    var tab = TABS.filter(function (t) { return t.key === key; })[0];
    node.querySelector(".rk-kb-hint").textContent = tab ? tab.hint : "";
    loadTab(key);
  }

  // --------------------------------------------------------------- 加载 --
  function loadLookups() {
    return Promise.all([
      api("GET", "/api/v1/verticals"),
      api("GET", "/api/v1/locations?page_size=1000"),
      api("GET", "/api/v1/employers"),
    ]).then(function (results) {
      state.lookups.verticals = (results[0] && results[0].items) || [];
      state.lookups.locations = (results[1] && results[1].items) || [];
      state.lookups.employers = (results[2] && results[2].items) || [];
    }).catch(function (error) {
      // 下拉选项缺失不该挡住主列表，只记日志
      warn("lookups failed", error.message);
    });
  }

  function loadTab(key) {
    var node = ensurePanel();
    var list = node.querySelector(".rk-kb-list");
    list.textContent = "";
    list.appendChild(el("p", "rk-kb-loading", "加载中…"));

    var request = key === "template"
      ? api("GET", "/api/v1/kb-templates")
      : key === "faq"
        ? api("GET", "/api/v1/kb-faqs?page_size=200")
        : api("GET", "/api/v1/" + key + "s");

    Promise.all([request, loadLookups()])
      .then(function (results) {
        var payload = results[0] || {};
        state.rows = payload.items || [];
        if (state.tab !== key) return;
        renderList(key, state.rows);
      })
      .catch(function (error) {
        list.textContent = "";
        var box = el("div", "rk-kb-empty");
        box.appendChild(el("p", null, error.status === 403 ? "需要管理员账号才能配置知识库。" : "加载失败：" + error.message));
        list.appendChild(box);
      });
  }

  function renderList(key, rows) {
    var node = ensurePanel();
    var list = node.querySelector(".rk-kb-list");
    list.textContent = "";

    var bar = el("div", "rk-kb-bar");
    bar.appendChild(el("span", "rk-kb-count", rows.length + " 条"));
    if (key !== "template") {
      var add = el("button", "rk-kb-primary", addLabel(key));
      add.type = "button";
      add.addEventListener("click", function () { openEditor(key, null); });
      bar.appendChild(add);
    }
    list.appendChild(bar);

    if (!rows.length) {
      list.appendChild(el("p", "rk-kb-empty", "还没有数据。点上面的按钮新建，或先导入模板包。"));
      return;
    }

    var table = el("table", "rk-kb-table");
    var thead = el("thead");
    var headRow = el("tr");
    columnsOf(key).forEach(function (col) { headRow.appendChild(el("th", null, col.label)); });
    headRow.appendChild(el("th", "rk-kb-col-ops", "操作"));
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el("tbody");
    rows.forEach(function (row) {
      var tr = el("tr");
      columnsOf(key).forEach(function (col) {
        var td = el("td");
        var value = col.render ? col.render(row) : row[col.field];
        if (value && value.nodeType) td.appendChild(value);
        else td.textContent = text(value);
        tr.appendChild(td);
      });
      var ops = el("td", "rk-kb-col-ops");
      if (key === "template") {
        var imp = el("button", "rk-kb-link", "导入");
        imp.type = "button";
        imp.addEventListener("click", function () { importTemplate(row.code); });
        ops.appendChild(imp);
      } else {
        var edit = el("button", "rk-kb-link", "编辑");
        edit.type = "button";
        edit.addEventListener("click", function () { openEditor(key, row); });
        ops.appendChild(edit);
        var del = el("button", "rk-kb-link rk-kb-danger", "删除");
        del.type = "button";
        del.addEventListener("click", function () { remove(key, row); });
        ops.appendChild(del);
      }
      tr.appendChild(ops);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    list.appendChild(table);
  }

  function addLabel(key) {
    return key === "vertical" ? "新建品类"
      : key === "location" ? "新建区域"
        : key === "employer" ? "新建招工方"
          : "新建问答";
  }

  function lookupName(list, id, field) {
    if (!id) return "";
    var hit = list.filter(function (row) { return Number(row.id) === Number(id); })[0];
    if (!hit) return "#" + id;
    // 招工方优先显示简称：列表里「松下」比全名好认
    return text(hit[field] || hit.short_name || hit.display_name || hit.name || hit.code);
  }

  function columnsOf(key) {
    if (key === "vertical") {
      return [
        { label: "编码", field: "code" },
        { label: "名称", field: "name" },
        { label: "排序", field: "sort_order" },
        { label: "状态", field: "status", render: function (row) { return statusChip(row.status); } },
      ];
    }
    if (key === "location") {
      return [
        { label: "层级", field: "level" },
        { label: "名称", field: "name" },
        { label: "上级", field: "parent_id", render: function (row) {
          return row.parent_id ? lookupName(state.lookups.locations, row.parent_id) : "—";
        } },
        { label: "地址", field: "address" },
        { label: "编码", field: "code" },
      ];
    }
    if (key === "employer") {
      return [
        { label: "编码", field: "employer_code" },
        { label: "全名", field: "display_name" },
        { label: "简称", field: "short_name" },
        { label: "品类", field: "vertical_id", render: function (row) {
          return lookupName(state.lookups.verticals, row.vertical_id, "name");
        } },
        { label: "位置", field: "location_id", render: function (row) {
          return row.location_id ? lookupName(state.lookups.locations, row.location_id) : "—";
        } },
        { label: "别名", field: "aliases", render: function (row) {
          return Array.isArray(row.aliases) ? row.aliases.join(" / ") : "";
        } },
      ];
    }
    if (key === "faq") {
      return [
        { label: "问题", field: "question" },
        { label: "答案", field: "answer" },
        { label: "作用域", field: "scope_level", render: function (row) {
          var label = row.scope_level === "employer" ? "招工方"
            : row.scope_level === "city" ? "城市"
              : row.scope_level === "vertical" ? "品类" : "全局";
          var target = row.scope_employer_id ? lookupName(state.lookups.employers, row.scope_employer_id)
            : row.scope_location_id ? lookupName(state.lookups.locations, row.scope_location_id) : "";
          return target ? label + "·" + target : label;
        } },
        { label: "优先级", field: "priority" },
      ];
    }
    return [
      { label: "编码", field: "code" },
      { label: "名称", field: "name" },
      { label: "品类", field: "vertical_code" },
      { label: "条目数", field: "item_count" },
    ];
  }

  // --------------------------------------------------------------- 编辑 --
  function openEditor(key, row) {
    var node = ensurePanel();
    var isNew = !row;
    var draft = isNew ? {} : Object.assign({}, row);

    var overlay = el("div", "rk-kb-modal");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    var card = el("form", "rk-kb-card");
    card.appendChild(el("h3", null, (isNew ? "新建" : "编辑") + TABS.filter(function (t) { return t.key === key; })[0].label));

    var fields = fieldsOf(key, draft);
    fields.forEach(function (field) { card.appendChild(renderField(field, draft, card)); });

    var error = el("p", "rk-kb-error");
    error.hidden = true;
    card.appendChild(error);

    var actions = el("div", "rk-kb-actions");
    var cancel = el("button", "rk-kb-ghost", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", function () { overlay.remove(); });
    actions.appendChild(cancel);
    var save = el("button", "rk-kb-primary", "保存");
    save.type = "submit";
    actions.appendChild(save);
    card.appendChild(actions);

    card.addEventListener("submit", function (event) {
      event.preventDefault();
      save.disabled = true;
      var payload = collectFields(card, fields);
      var request = isNew
        ? api("POST", "/api/v1/" + key + "s", payload)
        : api("PUT", "/api/v1/" + key + "s/" + draft.id, payload);
      request.then(function () {
        overlay.remove();
        loadTab(key);
      }).catch(function (err) {
        error.hidden = false;
        error.textContent = err.message;
        save.disabled = false;
      });
    });

    overlay.appendChild(card);
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) overlay.remove();
    });
    node.appendChild(overlay);
    var firstInput = card.querySelector("input:not([readonly]),select,textarea");
    if (firstInput) firstInput.focus();
  }

  function fieldsOf(key, draft) {
    if (key === "vertical") {
      return [
        { name: "code", label: "编码", required: true, placeholder: "factory / subway / domestic", readonly: !!draft.id },
        { name: "name", label: "名称", required: true, placeholder: "工厂 / 地铁安检 / 保姆" },
        { name: "sort_order", label: "排序", type: "number" },
      ];
    }
    if (key === "location") {
      return [
        { name: "level", label: "层级", required: true, placeholder: "province / city / district / park / point" },
        { name: "name", label: "名称", required: true, placeholder: "番禺区 / 钟村工业区" },
        { name: "parent_id", label: "上级区域", type: "select", source: "locations", allowEmpty: "（顶层）" },
        { name: "address", label: "地址", placeholder: "广东省广州市番禺区钟村" },
        { name: "walk_guide", label: "怎么走", type: "textarea", placeholder: "地铁 2 号线 C 出口，电梯上 7 楼 A7-A8" },
        { name: "code", label: "编码" },
      ];
    }
    if (key === "employer") {
      return [
        { name: "employer_code", label: "编码", required: true, placeholder: "GZ-PY-001", readonly: !!draft.id },
        { name: "display_name", label: "全名", required: true, placeholder: "松下万宝(广州)压缩机有限公司" },
        { name: "short_name", label: "简称", placeholder: "松下" },
        { name: "vertical_id", label: "品类", type: "select", source: "verticals", required: true },
        { name: "location_id", label: "所在地", type: "select", source: "locations", allowEmpty: "（未指定）" },
        { name: "aliases", label: "别名", type: "list", placeholder: "客户口语，逗号分隔：松下,万宝" },
      ];
    }
    return [
      { name: "question", label: "问题", required: true, placeholder: "包吃住吗" },
      { name: "keywords", label: "命中关键词", type: "list", placeholder: "逗号分隔：包吃,包住,吃住" },
      { name: "answer", label: "答案模板", type: "textarea", required: true, placeholder: "{welfare} 或直接写死一句话" },
      { name: "media", label: "图片/视频标记", type: "list", placeholder: "【图片:宿舍】【视频:车间】" },
      { name: "vertical_id", label: "限定品类", type: "select", source: "verticals", allowEmpty: "（通用）" },
      { name: "scope_level", label: "作用域", type: "select", options: [
        { value: "global", label: "全局" },
        { value: "vertical", label: "品类" },
        { value: "city", label: "城市" },
        { value: "employer", label: "招工方" },
      ] },
      { name: "scope_location_id", label: "作用城市（city 级必填）", type: "select", source: "locations", allowEmpty: "（不限）" },
      { name: "scope_employer_id", label: "作用招工方（employer 级必填）", type: "select", source: "employers", allowEmpty: "（不限）" },
      { name: "priority", label: "优先级", type: "number" },
    ];
  }

  function renderField(field, draft, card) {
    var wrap = el("label", "rk-kb-field");
    wrap.appendChild(el("span", "rk-kb-field-label", field.label + (field.required ? " *" : "")));
    var value = draft[field.name];
    var node;

    if (field.type === "select") {
      node = el("select", "rk-kb-input");
      if (field.allowEmpty !== undefined) {
        var empty = el("option", null, field.allowEmpty);
        empty.value = "";
        node.appendChild(empty);
      }
      var source = field.source ? state.lookups[field.source] || [] : [];
      var options = field.options || source.map(function (row) {
        return { value: row.id, label: text(row.short_name || row.display_name || row.name || row.code) };
      });
      options.forEach(function (option) {
        var opt = el("option", null, option.label);
        opt.value = String(option.value);
        node.appendChild(opt);
      });
      node.value = value === undefined || value === null ? "" : String(value);
    } else if (field.type === "textarea") {
      node = el("textarea", "rk-kb-input");
      node.rows = 3;
      if (field.placeholder) node.placeholder = field.placeholder;
      node.value = text(value);
    } else {
      node = el("input", "rk-kb-input");
      node.type = field.type === "number" ? "number" : "text";
      if (field.placeholder) node.placeholder = field.placeholder;
      if (field.readonly) {
        node.readOnly = true;
        node.classList.add("is-readonly");
      }
      node.value = field.type === "list"
        ? (Array.isArray(value) ? value.join(",") : text(value))
        : (value === undefined || value === null ? "" : String(value));
    }

    node.name = field.name;
    // 作用域联动：选了 employer 才需要 scope_employer_id，其余显灰提示
    if (field.name === "scope_employer_id" || field.name === "scope_location_id") {
      node.dataset.scopeField = field.name === "scope_employer_id" ? "employer" : "city";
      node.classList.add("is-optional");
    }
    wrap.appendChild(node);
    card.dataset.fieldCount = String((Number(card.dataset.fieldCount) || 0) + 1);
    return wrap;
  }

  function collectFields(card, fields) {
    var payload = {};
    fields.forEach(function (field) {
      var node = card.querySelector("[name=\"" + field.name + "\"]");
      if (!node) return;
      var raw = node.value;
      if (field.type === "list") {
        payload[field.name] = raw.split(/[,，]/).map(function (part) { return part.trim(); }).filter(Boolean);
      } else if (field.type === "number") {
        if (raw !== "") payload[field.name] = Number(raw);
      } else if (/_id$/.test(field.name)) {
        // 空串代表「不绑定」，必须传 null；传 0 会被当成不存在的 id
        payload[field.name] = raw === "" ? null : Number(raw);
      } else {
        payload[field.name] = raw;
      }
    });
    return payload;
  }

  function remove(key, row) {
    var name = row.display_name || row.name || row.question || row.code;
    if (!window.confirm("确定删除「" + text(name) + "」？")) return;
    api("DELETE", "/api/v1/" + key + "s/" + row.id)
      .then(function () { loadTab(key); })
      .catch(function (error) {
        // 被引用时后端回 409 并说明谁在用，原样展示，不吞
        window.alert(error.message);
      });
  }

  function importTemplate(code) {
    if (!window.confirm("导入模板包 " + code + "？已存在同问题的条目会跳过，不会覆盖改过的内容。")) return;
    api("POST", "/api/v1/kb-templates/" + encodeURIComponent(code) + "/import")
      .then(function (result) {
        window.alert("导入完成：新增 " + result.imported + " 条，跳过 " + result.skipped + " 条。");
        loadTab("template");
      })
      .catch(function (error) { window.alert("导入失败：" + error.message); });
  }

  // --------------------------------------------------------------- 入口 --
  function mountEntry() {
    var sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    if (document.getElementById(ENTRY_ID)) return;
    var menu = sidebar.querySelector(".sidebar-menu") || sidebar;
    var entry = el("button", "rk-kb-entry");
    entry.id = ENTRY_ID;
    entry.type = "button";
    entry.appendChild(el("span", "rk-kb-entry-dot"));
    entry.appendChild(el("span", "rk-kb-entry-label", "知识库配置"));
    entry.addEventListener("click", function () { togglePanel(true); });
    menu.appendChild(entry);
  }

  function injectStyle() {
    if (document.getElementById("rk-kb-style")) return;
    var style = document.createElement("style");
    style.id = "rk-kb-style";
    style.textContent = [
      "html.rk-kb-locked,html.rk-kb-locked body{overflow:hidden}",
      ".rk-kb-entry{display:flex;align-items:center;gap:10px;width:100%;margin-top:auto;margin-bottom:8px;padding:10px 14px;border:1px solid var(--rk-border);border-radius:12px;background:var(--rk-bg);color:var(--rk-ink-2);font:inherit;font-size:13px;cursor:pointer;text-align:left}",
      ".rk-kb-entry:hover{border-color:var(--rk-accent-soft);color:var(--rk-accent);box-shadow:var(--rk-shadow)}",
      ".rk-kb-entry-dot{width:7px;height:7px;border-radius:50%;background:var(--rk-accent);box-shadow:0 0 0 3px var(--rk-accent-soft);flex-shrink:0}",
      ".rk-nav-collapsed .rk-kb-entry{justify-content:center;padding:10px 0}",
      ".rk-nav-collapsed .rk-kb-entry-label{display:none}",
      ".rk-kb-overlay{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(4,30,73,.32);backdrop-filter:blur(6px)}",
      ".rk-kb-overlay[hidden]{display:none}",
      ".rk-kb-sheet{position:relative;display:flex;flex-direction:column;width:min(1180px,100%);max-height:100%;border-radius:22px;background:var(--rk-bg);box-shadow:var(--rk-shadow-lg);overflow:hidden;font-family:var(--rk-font);color:var(--rk-ink-1)}",
      ".rk-kb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:22px 26px 16px}",
      ".rk-kb-title h2{margin:0;font-size:19px;letter-spacing:-.01em}",
      ".rk-kb-sub{margin:4px 0 0;font-size:13px;color:var(--rk-ink-3)}",
      ".rk-kb-close,.rk-kb-ghost{border:1px solid var(--rk-border-strong);background:transparent;color:var(--rk-ink-2);border-radius:10px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer}",
      ".rk-kb-close:hover,.rk-kb-ghost:hover{background:var(--rk-panel-2)}",
      ".rk-kb-body{display:flex;flex:1;min-height:0;border-top:1px solid var(--rk-border)}",
      ".rk-kb-rail{width:236px;flex-shrink:0;padding:14px 12px;border-right:1px solid var(--rk-border);background:var(--rk-panel-2);overflow:auto}",
      ".rk-kb-tab{display:flex;flex-direction:column;gap:3px;width:100%;padding:11px 13px;margin-bottom:6px;border:0;border-radius:12px;background:transparent;font:inherit;text-align:left;cursor:pointer;color:var(--rk-ink-2)}",
      ".rk-kb-tab:hover{background:rgba(11,87,208,.06)}",
      ".rk-kb-tab.is-active{background:var(--rk-bg);box-shadow:var(--rk-shadow);color:var(--rk-accent)}",
      ".rk-kb-tab-label{font-size:14px;font-weight:600}",
      ".rk-kb-tab-hint{font-size:11.5px;line-height:1.45;color:var(--rk-ink-3)}",
      ".rk-kb-main{flex:1;min-width:0;display:flex;flex-direction:column;padding:18px 22px 22px;overflow:auto}",
      ".rk-kb-hint{font-size:12.5px;color:var(--rk-ink-3);margin-bottom:12px}",
      ".rk-kb-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}",
      ".rk-kb-count{font-size:12px;color:var(--rk-ink-3)}",
      ".rk-kb-primary{border:0;border-radius:10px;padding:8px 16px;background:var(--rk-grad-primary);color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer}",
      ".rk-kb-primary:hover{filter:brightness(1.05)}",
      ".rk-kb-primary:disabled{opacity:.6;cursor:default}",
      ".rk-kb-table{width:100%;border-collapse:collapse;font-size:13px}",
      ".rk-kb-table th{position:sticky;top:0;background:var(--rk-bg);padding:9px 10px;text-align:left;font-weight:600;color:var(--rk-ink-3);border-bottom:1px solid var(--rk-border);white-space:nowrap}",
      ".rk-kb-table td{padding:10px;border-bottom:1px solid var(--rk-border);vertical-align:top;word-break:break-word}",
      ".rk-kb-table tr:hover td{background:var(--rk-panel-2)}",
      ".rk-kb-col-ops{width:110px;white-space:nowrap;text-align:right}",
      ".rk-kb-link{border:0;background:transparent;color:var(--rk-accent);font:inherit;font-size:12.5px;cursor:pointer;padding:4px 6px;border-radius:6px}",
      ".rk-kb-link:hover{background:var(--rk-accent-soft)}",
      ".rk-kb-danger{color:var(--rk-down)}",
      ".rk-kb-danger:hover{background:var(--rk-err-soft)}",
      ".rk-kb-chip{display:inline-block;padding:1px 9px;border-radius:999px;font-size:11.5px}",
      ".rk-kb-chip[data-state=on]{background:var(--rk-up-soft);color:var(--rk-up)}",
      ".rk-kb-chip[data-state=off]{background:var(--rk-warn-soft);color:var(--rk-warn)}",
      ".rk-kb-empty,.rk-kb-loading{padding:36px 0;text-align:center;font-size:13px;color:var(--rk-ink-3)}",
      ".rk-kb-modal{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(4,30,73,.28)}",
      ".rk-kb-card{width:min(560px,100%);max-height:100%;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:22px;border-radius:18px;background:var(--rk-bg);box-shadow:var(--rk-shadow-lg)}",
      ".rk-kb-card h3{margin:0 0 4px;font-size:16px}",
      ".rk-kb-field{display:flex;flex-direction:column;gap:6px}",
      ".rk-kb-field-label{font-size:12.5px;color:var(--rk-ink-3)}",
      ".rk-kb-input{padding:9px 11px;border:1px solid var(--rk-border-strong);border-radius:10px;font:inherit;font-size:13.5px;background:var(--rk-bg);color:var(--rk-ink-1)}",
      ".rk-kb-input:focus{outline:none;border-color:var(--rk-accent);box-shadow:0 0 0 3px var(--rk-accent-soft)}",
      ".rk-kb-input.is-readonly{background:var(--rk-panel-2);color:var(--rk-ink-3)}",
      ".rk-kb-input.is-optional{opacity:.92}",
      ".rk-kb-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}",
      ".rk-kb-error{margin:0;font-size:12.5px;color:var(--rk-down)}",
      "@media (max-width:820px){.rk-kb-body{flex-direction:column}.rk-kb-rail{width:100%;display:flex;gap:8px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--rk-border)}.rk-kb-tab{min-width:150px}}",
    ].join("\n");
    document.head.appendChild(style);
  }

  function start() {
    injectStyle();
    mountEntry();
    // Vue 重建侧栏时把入口补回去；面板不重建，避免打断正在填的表单。
    new MutationObserver(function () {
      if (!document.getElementById(ENTRY_ID)) safe(mountEntry, "mount entry");
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !state.open) return;
      var modal = panel && panel.querySelector(".rk-kb-modal");
      if (modal) modal.remove();
      else togglePanel(false);
    });
    log("ready");
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

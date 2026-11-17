/**
 * 工厂配置总览（2026-11-15）。
 *
 * 为什么是运行时补丁而不是改 Vue 源码：线上后台是编译好的 Vue 包（public/assets/，
 * 93 个 chunk、无 sourcemap、无 .vue 源码），加不了路由也改不了侧栏。沿用项目里
 * kb-console.js / device-factories.js 的既有做法——在侧栏注入
 * 一个入口按钮，点开是覆盖式独立面板，直接打 /api/v1/* 接口，与 Vue 主体互不干扰。
 *
 * 一眼看清每个工厂：绑了哪些设备 / 有哪些岗位 / 知识库配了什么。
 *
 * 数据源（全部是现有 GET 接口，字段已对照 src/ 路由源码逐一确认，见各 api 调用处注释）：
 *   GET /api/v1/factories?page=1&page_size=1000  → 工厂主表 {items:[{id,factory_name,city_id,address,contact,salary,is_active}]}
 *     （response-serializers.ts FACTORY_FIELDS，没有 city_name，要拿 /cities 自己拼）
 *   GET /api/v1/cities?page=1&page_size=1000     → {items:[{id,city_name,...}]}，city_id → 城市名
 *   GET /api/v1/agent/devices                    → {items:[{id,device_code,name,online,...,factory_ids,factories:[{id,name,city_name}]}]}
 *     （agent.routes.ts 列表路由在序列化结果上追加 factory_ids 与 factories，设备→工厂多选绑定）
 *   GET /api/v1/service-positions?page=1&page_size=1000 → {items:[{id,position_name,factory_id,city_name,store_name,is_active}]}
 *     （POSITION_KEYS 含 factory_id：岗位→工厂是一对一外键，4fe4ec5 起显式归属）
 *     {items:[{id,position_id,stage,title,content,media,status}]}，stage ∈ 五时点 key
 *   GET /api/v1/employers                        → {items:[{id,employer_code,display_name,short_name,vertical_id,location_id,status,aliases}]}
 *   GET /api/v1/kb-faqs?page_size=1000&page=N    → {items:[{id,question,answer,scope_level,scope_employer_id,scope_position_id,vertical_id,status,priority}],total}
 *   GET /api/v1/kb-publish/history               → {target_url,target_id,items:[{id,created_at}]}，最近一次发布时间
 *
 * 口径说明（重要）：本系统里「工厂」(factories 表) 和「招工方」(employer 表) 是两张独立表，
 * 没有外键。设备 / 岗位 / 话术都挂在 factories 上；知识库 FAQ 的 scope_employer_id 指向
 * employer。所以每张卡的 KB 区块按「厂名 ↔ 招工方名称/简称/别名」做名称匹配——匹配不上的
 * 只显示全局层，并明确标注「未匹配到招工方档案」，不假装关联。
 *
 * 发布状态：kb_faq 表本身没有「已发布到回复服务」的逐条标记（发布记录在回复服务侧，
 * GET 侧只有 /kb-publish/history 的发布流水）。所以 FAQ 行只能显示 启用/停用 状态，
 * 页头展示最近发布时间；「某条是否已在回复服务生效」无法从现有 GET 判断，不做假标注。
 *
 * 并发控制：全部请求按批（每批 ≤5 个）用 Promise.all 并行，批间串行；FAQ 翻页顺序拉，
 * 避免一次打几十个请求。
 */
{
  const ENTRY_ID = "rk-fo-entry";
  const STYLE_ID = "rk-fo-style";
  const TAG = "[factory-overview]";

  function log() {
    try { console.info.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ 鉴权 / 请求 --
  // bundle 把 token 存在 localStorage["token"]，偶尔被 JSON.stringify 包一层引号，
  // 与 kb-console.js readToken() 同一套读法。
  function readToken() {
    try {
      var raw = localStorage.getItem("token");
      if (!raw) return "";
      var value = String(raw).trim();
      if (value.length > 1 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
        try { value = JSON.parse(value); } catch (e) { value = value.slice(1, -1); }
      }
      return typeof value === "string" ? value.trim() : "";
    } catch (e) { return ""; }
  }

  function api(path) {
    var headers = { Accept: "application/json" };
    var token = readToken();
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(path, { method: "GET", headers: headers }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var error = new Error((data && data.detail) || "HTTP " + res.status);
          error.status = res.status;
          throw error;
        }
        return data;
      });
    });
  }

  // ------------------------------------------------------------ 小工具 --
  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // 一律 textContent：厂名 / FAQ 都可能带尖括号，绝不拼 innerHTML。
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }
  function itemsOf(payload) {
    return payload && Array.isArray(payload.items) ? payload.items : [];
  }
  // 分批并行：每批 ≤ size 个请求，批间 await，避免一次打几十个请求。
  function runBatches(tasks, size) {
    var results = new Array(tasks.length);
    var index = 0;
    function nextBatch() {
      if (index >= tasks.length) return Promise.resolve(results);
      var end = Math.min(index + size, tasks.length);
      var batch = [];
      for (var i = index; i < end; i++) batch.push(i);
      index = end;
      return Promise.all(batch.map(function (i) {
        return tasks[i]().then(
          function (value) { results[i] = { ok: true, value: value }; },
          function (error) { results[i] = { ok: false, error: error }; }
        );
      })).then(nextBatch);
    }
    return nextBatch();
  }
  // FAQ 全量翻页：kb-faqs 支持 page_size=1000，超过一页时顺序补拉（不并行，压力最小）。
  function loadAllFaqs() {
    return api("/api/v1/kb-faqs?page_size=1000&page=1").then(function collect(first) {
      var rows = itemsOf(first).slice();
      function more(page) {
        return api("/api/v1/kb-faqs?page_size=1000&page=" + page).then(function (payload) {
          rows = rows.concat(itemsOf(payload));
          if (payload && Number(payload.total) > rows.length && itemsOf(payload).length) return more(page + 1);
          return rows;
        });
      }
      return first && Number(first.total) > rows.length ? more(2) : rows;
    });
  }

  // ------------------------------------------------------------ 数据模型 --
  // 一个 section 失败只让对应区块显示「—」，不阻塞整页。
  function fetchData() {
    var tasks = [
      function () { return api("/api/v1/factories?page=1&page_size=1000"); },   // 0 工厂
      function () { return api("/api/v1/cities?page=1&page_size=1000"); },      // 1 城市
      function () { return api("/api/v1/agent/devices"); },                     // 2 设备（含 factory_ids）
      function () { return api("/api/v1/service-positions?page=1&page_size=1000"); }, // 3 岗位（含 factory_id）
      function () { return api("/api/v1/employers"); },                         // 5 招工方（KB 归属）
      loadAllFaqs,                                                              // 6 FAQ 全量
      function () { return api("/api/v1/kb-publish/history"); },                // 7 最近发布时间
    ];
    return runBatches(tasks, 5).then(function (results) {
      return {
        factories: results[0].ok ? itemsOf(results[0].value) : null,
        cities: results[1].ok ? itemsOf(results[1].value) : null,
        devices: results[2].ok ? itemsOf(results[2].value) : null,
        positions: results[3].ok ? itemsOf(results[3].value) : null,
        employers: results[5].ok ? itemsOf(results[5].value) : null,
        faqs: results[6].ok ? results[6].value : null,
        publish: results[7].ok ? results[7].value : null,
      };
    });
  }

  // 厂名 ↔ 招工方名称匹配。两张表没有外键，只能按名称对：
  // 先精确匹配（去空格、小写化后 display_name / short_name / 别名），再退化为双向包含。
  function normalizeName(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, "");
  }
  function matchEmployer(factoryName, employers) {
    if (!factoryName || !employers || !employers.length) return null;
    var key = normalizeName(factoryName);
    for (var i = 0; i < employers.length; i++) {
      var employer = employers[i];
      var names = [employer.display_name, employer.short_name]
        .concat(Array.isArray(employer.aliases) ? employer.aliases : []);
      for (var j = 0; j < names.length; j++) {
        if (normalizeName(names[j]) && normalizeName(names[j]) === key) return employer;
      }
    }
    for (var k = 0; k < employers.length; k++) {
      var other = employers[k];
      var shorts = [other.short_name, other.display_name].filter(Boolean).map(normalizeName);
      for (var m = 0; m < shorts.length; m++) {
        var name = shorts[m];
        if (name.length >= 2 && (key.indexOf(name) >= 0 || name.indexOf(key) >= 0)) return other;
      }
    }
    return null;
  }

  function buildModel(data) {
    var cityName = {};
    (data.cities || []).forEach(function (city) { cityName[Number(city.id)] = String(city.city_name || ""); });

    // 设备：factory_ids → {工厂id: [设备名]}
    var deviceNames = {};
    var deviceFailed = data.devices === null;
    (data.devices || []).forEach(function (device) {
      var label = String(device.name || device.device_code || ("#" + device.id));
      var ids = Array.isArray(device.factory_ids) ? device.factory_ids : [];
      if (!ids.length) return;
      ids.forEach(function (rawId) {
        var id = Number(rawId);
        if (!(id > 0)) return;
        if (!deviceNames[id]) deviceNames[id] = [];
        deviceNames[id].push(label);
      });
    });

    // 岗位：按 factory_id 归组；没归属任何已知工厂的单独放 unassigned。
    var positionRows = {};
    var unassigned = [];
    (data.positions || []).forEach(function (position) {
      var id = Number(position.factory_id);
      if (id > 0) {
        if (!positionRows[id]) positionRows[id] = [];
        positionRows[id].push(position);
      } else {
        unassigned.push(position);
      }
    });

    // FAQ：同上，失败置 null 让卡片显示「—」。
    var faqGlobal = data.faqs === null ? null : [];
    var faqByEmployer = {};
    var faqByPosition = {};
    (data.faqs || []).forEach(function (faq) {
      if (String(faq.status || "enabled") === "deleted") return;
      var level = String(faq.scope_level || "global");
      if (level === "global") faqGlobal.push(faq);
      else if (level === "employer" && faq.scope_employer_id) {
        var employerId = Number(faq.scope_employer_id);
        if (!faqByEmployer[employerId]) faqByEmployer[employerId] = [];
        faqByEmployer[employerId].push(faq);
      } else if (level === "position" && faq.scope_position_id) {
        var positionId = Number(faq.scope_position_id);
        if (!faqByPosition[positionId]) faqByPosition[positionId] = [];
        faqByPosition[positionId].push(faq);
      }
    });

    var employerOf = {};
    (data.factories || []).forEach(function (factory) {
      employerOf[Number(factory.id)] = matchEmployer(factory.factory_name || factory.name, data.employers);
    });

    return {
      cityName: cityName,
      deviceNames: deviceNames,
      deviceFailed: deviceFailed,
      scriptStages: scriptStages,
      positionRows: positionRows,
      unassigned: unassigned,
      faqGlobal: faqGlobal,
      faqByEmployer: faqByEmployer,
      faqByPosition: faqByPosition,
      employerOf: employerOf,
      lastPublish: data.publish && Array.isArray(data.publish.items) && data.publish.items.length
        ? String(data.publish.items[0].created_at || "")
        : "",
    };
  }

  // ------------------------------------------------------------ 渲染 --
  var panel = null;
  var loading = false;

  function statsCell(label, value, cls) {
    var cell = el("span", "rk-fo-stat" + (cls ? " " + cls : ""));
    cell.appendChild(el("b", null, value));
    cell.appendChild(el("span", null, label));
    return cell;
  }
  // 某区块数据缺失时显示「—」，不阻塞其它区块。
  function dash(label) {
    var cell = el("span", "rk-fo-stat is-missing");
    cell.appendChild(el("b", null, "—"));
    cell.appendChild(el("span", null, label));
    cell.title = "该数据加载失败";
    return cell;
  }

  function faqBlock(title, rows) {
    var box = el("div", "rk-fo-detail-row");
    box.appendChild(el("p", "rk-fo-detail-label", title));
    if (rows === null) {
      box.appendChild(el("p", "rk-fo-detail-empty", "—（加载失败）"));
      return box;
    }
    if (!rows.length) {
      box.appendChild(el("p", "rk-fo-detail-empty", "无"));
      return box;
    }
    var list = el("ul", "rk-fo-faq-list");
    rows.slice(0, 30).forEach(function (faq) {
      var line = el("li");
      line.appendChild(el("span", null, String(faq.question || ("#" + faq.id))));
      // kb_faq 没有「已发布」标记，这里只标本地启用/停用（见文件头口径说明）。
      if (String(faq.status || "enabled") === "disabled") {
        line.appendChild(el("em", "rk-fo-chip is-off", "已停用"));
      }
      list.appendChild(line);
    });
    box.appendChild(list);
    if (rows.length > 30) box.appendChild(el("p", "rk-fo-detail-empty", "还有 " + (rows.length - 30) + " 条，未一一列出"));
    return box;
  }

  function nameListBlock(label, names) {
    var box = el("div", "rk-fo-detail-row");
    box.appendChild(el("p", "rk-fo-detail-label", label));
    if (!names || !names.length) {
      box.appendChild(el("p", "rk-fo-detail-empty", "无"));
    } else {
      box.appendChild(el("p", "rk-fo-detail-names", names.join("、")));
    }
    return box;
  }

  function buildCard(factory, model) {
    var id = Number(factory.id);
    var name = String(factory.factory_name || factory.name || ("工厂#" + id));
    var city = model.cityName[Number(factory.city_id)] || "";
    var positions = model.positionRows[id] || [];
    var devices = model.deviceNames[id] || [];

    // KB 统计：global 全站共用一条计数；employer / 岗位级按归属归到本厂。
    var employer = model.employerOf[id];
    var faqEmployer = employer ? (model.faqByEmployer[Number(employer.id)] || []) : null;
    var faqPositionCount = 0;
    positions.forEach(function (position) {
      var rows = model.faqByPosition[Number(position.id)];
      if (rows) faqPositionCount += rows.length;
    });

    var card = el("article", "rk-fo-card");

    var head = el("div", "rk-fo-card-head");
    var titleBox = el("div", "rk-fo-card-title");
    titleBox.appendChild(el("h3", null, name));
    var meta = [city || "未知城市"];
    if (employer) meta.push("招工方：" + String(employer.short_name || employer.display_name));
    if (factory.is_active === false) meta.push("已停用");
    titleBox.appendChild(el("p", "rk-fo-card-meta", meta.join(" · ")));
    head.appendChild(titleBox);
    head.appendChild(el("span", "rk-fo-toggle", "展开 ▾"));
    card.appendChild(head);

    var stats = el("div", "rk-fo-stats");
    if (model.deviceFailed) stats.appendChild(dash("设备"));
    else stats.appendChild(statsCell("设备", devices.length, devices.length ? "" : "is-zero"));
    stats.appendChild(statsCell("岗位", positions.length, positions.length ? "" : "is-zero"));
    if (model.faqGlobal === null) stats.appendChild(dash("KB"));
    else {
      var kbText = "全局 " + model.faqGlobal.length;
      if (faqEmployer) kbText += " / 本厂 " + faqEmployer.length;
      else if (model.employersFailed) kbText += " / 本厂 —";
      else kbText += " / 本厂 0";
      if (faqPositionCount) kbText += " + 岗位级 " + faqPositionCount;
      stats.appendChild(statsCell("KB", kbText, (faqEmployer && faqEmployer.length) || faqPositionCount ? "" : "is-zero"));
    }
    card.appendChild(stats);

    // 展开明细：原生 <details>，点头部即展开，无需额外事件状态。
    var details = el("details", "rk-fo-details");
    var summary = el("summary", null, "明细");
    details.appendChild(summary);
    details.appendChild(nameListBlock("设备（" + devices.length + "）", devices));
    var positionNames = positions.map(function (position) {
      var bits = [String(position.position_name || ("#" + position.id))];
      if (position.city_name && position.city_name !== city) bits.push(String(position.city_name));
      if (position.is_active === false) bits.push("已停用");
      return bits.join("（") + (bits.length > 1 ? "）" : "");
    });
    details.appendChild(nameListBlock("岗位（" + positions.length + "）", positionNames));
    details.appendChild(faqBlock("知识库 · 全局共用（" + (model.faqGlobal === null ? "—" : model.faqGlobal.length) + "）", model.faqGlobal));
    if (employer && faqEmployer) {
      details.appendChild(faqBlock("知识库 · 本厂（招工方 " + String(employer.short_name || employer.display_name) + "，" + faqEmployer.length + " 条）", faqEmployer));
    } else if (model.employersFailed) {
      details.appendChild(faqBlock("知识库 · 本厂（招工方档案加载失败）", null));
    } else {
      details.appendChild(faqBlock("知识库 · 本厂（未匹配到招工方档案，仅引用全局）", null));
    }
    if (faqPositionCount) {
      var positionFaqs = [];
      positions.forEach(function (position) {
        var rows = model.faqByPosition[Number(position.id)];
        if (rows) positionFaqs = positionFaqs.concat(rows);
      });
      details.appendChild(faqBlock("知识库 · 岗位级（" + positionFaqs.length + " 条）", positionFaqs));
    }
    card.appendChild(details);

    // 展开状态联动标题文案。
    details.addEventListener("toggle", function () {
      var toggle = head.querySelector(".rk-fo-toggle");
      if (toggle) toggle.textContent = details.open ? "收起 ▴" : "展开 ▾";
    });
    head.addEventListener("click", function (event) {
      if (event.target.closest("a")) return;
      details.open = !details.open;
    });
    return card;
  }

  function render(model, failures) {
    var node = panel;
    var body = node.querySelector(".rk-fo-body");
    body.textContent = "";

    var top = el("div", "rk-fo-top");
    var total = model.factories ? model.factories.length : 0;
    var summary = el("span", "rk-fo-summary", "共 " + total + " 家工厂 · 未归属岗位 " + model.unassigned.length + " 个"
      + (model.lastPublish ? " · 最近发布 " + model.lastPublish : " · 最近发布 —"));
    top.appendChild(summary);
    if (failures.length) {
      top.appendChild(el("span", "rk-fo-warn", "部分接口失败（" + failures.join("、") + "），对应区块显示 —"));
    }
    body.appendChild(top);

    if (model.unassigned.length) {
      var unassigned = el("details", "rk-fo-card rk-fo-unassigned");
      unassigned.appendChild(el("summary", null, "未归属工厂的岗位（" + model.unassigned.length + "）——绑定设备后查不到它们"));
      var names = el("p", "rk-fo-detail-names");
      names.textContent = model.unassigned.map(function (position) {
        return String(position.position_name || ("#" + position.id)) + (position.city_name ? "（" + position.city_name + "）" : "");
      }).join("、");
      unassigned.appendChild(names);
      body.appendChild(unassigned);
    }

    if (model.factories === null) {
      body.appendChild(el("p", "rk-fo-empty", "工厂列表加载失败，无法渲染总览。请点「刷新」重试。"));
      return;
    }
    if (!model.factories.length) {
      body.appendChild(el("p", "rk-fo-empty", "还没有工厂。先到「城市管理」里建厂区。"));
      return;
    }
    model.factories.forEach(function (factory) { body.appendChild(buildCard(factory, model)); });
  }

  function refresh() {
    if (!panel || loading) return;
    loading = true;
    var body = panel.querySelector(".rk-fo-body");
    var button = panel.querySelector(".rk-fo-refresh");
    body.textContent = "";
    body.appendChild(el("p", "rk-fo-empty", "加载中…"));
    if (button) button.disabled = true;

    fetchData().then(function (data) {
      var model = buildModel(data);
      var failures = [];
      if (data.factories === null) failures.push("工厂");
      if (data.cities === null) failures.push("城市");
      if (data.devices === null) failures.push("设备");
      if (data.positions === null) failures.push("岗位");
      if (data.scripts === null) { failures.push("话术"); model.scriptStages = null; }
      if (data.employers === null) { failures.push("招工方"); model.employersFailed = true; }
      if (data.faqs === null) failures.push("知识库");
      if (data.publish === null) failures.push("发布记录");
      render(model, failures);
    }).catch(function (error) {
      log("refresh failed", error && error.message);
      body.textContent = "";
      body.appendChild(el("p", "rk-fo-empty", "加载失败：" + (error && error.message)));
    }).finally(function () {
      loading = false;
      if (button) button.disabled = false;
    });
  }

  function buildPanel() {
    var root = el("div", "rk-fo-overlay");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "工厂配置总览");
    root.hidden = true;

    var sheet = el("div", "rk-fo-sheet");
    var head = el("header", "rk-fo-head");
    var titleBox = el("div");
    titleBox.appendChild(el("h2", null, "工厂配置总览"));
    titleBox.appendChild(el("p", "rk-fo-sub", "每个工厂绑了哪些设备 / 岗位、话术配了几条、知识库有哪些。点卡片展开名单。"));
    head.appendChild(titleBox);
    var refreshButton = el("button", "rk-fo-ghost rk-fo-refresh", "刷新");
    refreshButton.type = "button";
    refreshButton.addEventListener("click", refresh);
    head.appendChild(refreshButton);
    var close = el("button", "rk-fo-ghost", "关闭");
    close.type = "button";
    close.addEventListener("click", function () { togglePanel(false); });
    head.appendChild(close);
    sheet.appendChild(head);

    sheet.appendChild(el("div", "rk-fo-body"));
    root.appendChild(sheet);
    root.addEventListener("click", function (event) { if (event.target === root) togglePanel(false); });
    document.body.appendChild(root);
    return root;
  }

  function togglePanel(open) {
    if (!panel) panel = buildPanel();
    panel.hidden = !open;
    document.documentElement.classList.toggle("rk-fo-locked", open);
    if (open) refresh();
  }

  // ------------------------------------------------------------ 样式 --
  // 浅色主题，变量全部复用 theme.css 的 --rk-*（页面已全局定义），不引入新视觉语言。
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "html.rk-fo-locked,html.rk-fo-locked body{overflow:hidden}",
      ".rk-fo-entry{display:flex;align-items:center;gap:10px;width:100%;margin-bottom:8px;padding:10px 14px;border:1px solid var(--rk-border);border-radius:12px;background:var(--rk-bg);color:var(--rk-ink-2);font:inherit;font-size:13px;cursor:pointer;text-align:left}",
      ".rk-fo-entry:hover{border-color:var(--rk-accent-soft);color:var(--rk-accent);box-shadow:var(--rk-shadow)}",
      ".rk-nav-collapsed .rk-fo-entry{justify-content:center;padding:10px 0}",
      ".rk-nav-collapsed .rk-fo-entry-label{display:none}",
      ".rk-fo-overlay{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(4,30,73,.32);backdrop-filter:blur(6px)}",
      ".rk-fo-overlay[hidden]{display:none}",
      ".rk-fo-sheet{display:flex;flex-direction:column;width:min(960px,100%);max-height:100%;border-radius:22px;background:var(--rk-bg);box-shadow:var(--rk-shadow-lg);overflow:hidden;font-family:var(--rk-font);color:var(--rk-ink-1)}",
      ".rk-fo-head{display:flex;align-items:flex-start;gap:12px;padding:20px 26px 16px;border-bottom:1px solid var(--rk-border)}",
      ".rk-fo-head h2{margin:0;font-size:19px;letter-spacing:-.01em}",
      ".rk-fo-sub{margin:4px 0 0;font-size:13px;color:var(--rk-ink-3)}",
      ".rk-fo-head div:first-child{flex:1 1 auto;min-width:0}",
      ".rk-fo-ghost{flex:0 0 auto;border:1px solid var(--rk-border-strong);background:transparent;color:var(--rk-ink-2);border-radius:10px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer}",
      ".rk-fo-ghost:hover{background:var(--rk-panel-2)}",
      ".rk-fo-ghost:disabled{opacity:.6;cursor:default}",
      ".rk-fo-body{flex:1;min-height:0;overflow:auto;padding:16px 26px 24px}",
      ".rk-fo-top{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:12px}",
      ".rk-fo-summary{font-size:12.5px;color:var(--rk-ink-3)}",
      ".rk-fo-warn{font-size:12.5px;color:var(--rk-warn);background:var(--rk-warn-soft);border-radius:8px;padding:3px 10px}",
      ".rk-fo-card{border:1px solid var(--rk-border);border-radius:14px;background:var(--rk-bg);margin-bottom:10px;box-shadow:var(--rk-shadow)}",
      ".rk-fo-card-head{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer}",
      ".rk-fo-card-title{flex:1 1 auto;min-width:0}",
      ".rk-fo-card-title h3{margin:0;font-size:14.5px;font-weight:600}",
      ".rk-fo-card-meta{margin:2px 0 0;font-size:12px;color:var(--rk-ink-3)}",
      ".rk-fo-toggle{flex:0 0 auto;font-size:12px;color:var(--rk-ink-3)}",
      ".rk-fo-stats{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 12px}",
      ".rk-fo-stat{display:inline-flex;align-items:baseline;gap:5px;padding:4px 10px;border-radius:8px;background:var(--rk-panel-2);font-size:12px;color:var(--rk-ink-3)}",
      ".rk-fo-stat b{font-size:13px;color:var(--rk-ink-1);font-weight:600}",
      ".rk-fo-stat.is-zero b{color:var(--rk-warn)}",
      ".rk-fo-stat.is-missing b{color:var(--rk-ink-3)}",
      ".rk-fo-details{border-top:1px solid var(--rk-border);padding:0 16px}",
      ".rk-fo-details summary{cursor:pointer;padding:8px 0;font-size:12.5px;color:var(--rk-accent);list-style:none}",
      ".rk-fo-details summary::-webkit-details-marker{display:none}",
      ".rk-fo-detail-row{margin:2px 0 10px}",
      ".rk-fo-detail-label{margin:0 0 4px;font-size:12px;color:var(--rk-ink-3)}",
      ".rk-fo-detail-names{margin:0;font-size:12.5px;line-height:1.7;word-break:break-word}",
      ".rk-fo-detail-empty{margin:0;font-size:12.5px;color:var(--rk-ink-3)}",
      ".rk-fo-faq-list{margin:0;padding:0;list-style:none}",
      ".rk-fo-faq-list li{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px dashed var(--rk-border);font-size:12.5px}",
      ".rk-fo-faq-list li:last-child{border-bottom:0}",
      ".rk-fo-chip{flex:0 0 auto;padding:0 7px;border-radius:999px;font-size:11px;font-style:normal}",
      ".rk-fo-chip.is-off{background:var(--rk-warn-soft);color:var(--rk-warn)}",
      ".rk-fo-unassigned summary{color:var(--rk-warn);font-weight:600}",
      ".rk-fo-unassigned{padding:12px 16px}",
      ".rk-fo-unassigned .rk-fo-detail-names{margin-top:8px}",
      ".rk-fo-empty{padding:36px 0;text-align:center;font-size:13px;color:var(--rk-ink-3)}",
      "@media (max-width:640px){.rk-fo-overlay{padding:0}.rk-fo-sheet{width:100%;max-height:100%;border-radius:0}}",
    ].join("\n");
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------ 入口 --
  // 与 kb-console.js mountEntry() 同一套：找 .sidebar（Vue 渲染的侧栏容器），
  // 把按钮追加进 .sidebar-menu。Vue 重渲染会冲掉注入节点，靠 MutationObserver 续挂；
  // getElementById 防重复（data-rk-xxx 思路同一件事：以稳定标记判「已挂过」）。
  function mountEntry() {
    var sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    if (document.getElementById(ENTRY_ID)) return;
    var menu = sidebar.querySelector(".sidebar-menu") || sidebar;
    var entry = el("button", "rk-fo-entry");
    entry.id = ENTRY_ID;
    entry.type = "button";
    entry.appendChild(el("span", "rk-fo-entry-label", "工厂配置总览"));
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

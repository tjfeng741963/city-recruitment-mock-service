/**
 * 接口调试台（Postman 风格，内置在后台里）。
 *
 * 为什么不手写接口清单：一定会过期。左侧列表来自
 * `GET /api/v1/debug/routes`——server.ts 的 onRoute 钩子把真实注册的路由
 * 原样吐出来，后端加了接口，这里刷新就有，前端一行不用改。
 *
 * 能做的事：
 *   - 按分组浏览全部接口，搜索过滤；
 *   - 路径里的 :id / :name 自动变成输入框，填完拼回 URL；
 *   - 自动带 Authorization（localStorage 里的 token），不用手动粘；
 *   - 常见接口预填 body 模板，直接点发送；
 *   - 看状态码、耗时、响应体（JSON 自动格式化）。
 *
 * 危险动作（DELETE）会二次确认：这是真打接口，不是 mock。
 */
{
  const ENTRY_ID = "rk-apiconsole-entry";
  const STYLE_ID = "rk-apiconsole-style";
  const MASK_CLASS = "rk-api-mask";
  const TOKEN_KEY = "token";

  const METHOD_COLOR = {
    GET: "#185FA5",
    POST: "#0F6E56",
    PUT: "#854F0B",
    PATCH: "#854F0B",
    DELETE: "#A32D2D",
  };

  // 常见接口的请求体示例。没有模板的接口也能调，只是 body 要自己写。
  const BODY_TEMPLATES = {
    "POST /api/v1/auth/login": '{\n  "username": "local-admin",\n  "password": "local-demo-only"\n}',
    "PUT /api/v1/agent-persona": '{\n  "position_id": 1,\n  "content": "你是陈姐，在广东做工厂招工十几年……"\n}',
    "POST /api/v1/agent-opening": '{\n  "position_id": 1,\n  "kind": "text",\n  "content": "你好，我们这边在招普工",\n  "delay_ms": 2000\n}',
    "PUT /api/v1/agent-opening/:id": '{\n  "content": "改过的正文",\n  "delay_ms": 2000\n}',
    "POST /api/v1/agent-opening/reorder": '{\n  "position_id": 1,\n  "ids": [2, 1]\n}',
    "POST /api/v1/agent/opening/log": '{\n  "session_key": "S:10001",\n  "device_code": "pc-win-01",\n  "position_id": 1,\n  "seq": 1,\n  "kind": "text",\n  "status": "sent"\n}',
    "POST /api/v1/agent/chat": '{\n  "position_id": 1,\n  "text": "多少钱一小时",\n  "history": [],\n  "dry": true\n}',
    "POST /api/v1/kb-faqs": '{\n  "vertical_id": 1,\n  "scope_level": "global",\n  "question": "包吃住吗",\n  "keywords": ["吃住", "宿舍"],\n  "answer": "这边包吃包住。",\n  "priority": 0\n}',
  };

  const token = () => {
    try {
      const raw = localStorage.getItem(TOKEN_KEY) || "";
      const value = String(raw).trim();
      if (value.length > 1 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
        try { return JSON.parse(value); } catch { return value.slice(1, -1); }
      }
      return value;
    } catch {
      return "";
    }
  };

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }

  function toast(text, tone) {
    let host = document.querySelector(".rk-api-toasts");
    if (!host) {
      host = el("div", "rk-api-toasts");
      document.body.append(host);
    }
    const box = el("div", `rk-api-toast${tone === "error" ? " is-error" : ""}`, text);
    host.append(box);
    setTimeout(() => {
      box.style.opacity = "0";
      setTimeout(() => box.remove(), 220);
    }, 2600);
  }

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = el("style");
    style.id = STYLE_ID;
    style.textContent = `
      .rk-api-entry{display:flex;align-items:center;gap:10px;width:100%;height:40px;margin-bottom:8px;padding:0 14px;border:0;border-radius:var(--gl-r-control);background:transparent;color:var(--rk-ink-2);font:inherit;font-size:13px;cursor:pointer;text-align:left}
      .rk-api-entry:hover{background:rgba(31,41,64,.05);color:var(--rk-ink-1)}
      .rk-api-entry-dot{width:7px;height:7px;border-radius:50%;background:#185FA5;box-shadow:0 0 0 3px rgba(24,95,165,.16);flex-shrink:0}
      .rk-nav-collapsed .rk-api-entry{justify-content:center;padding:0}
      .rk-nav-collapsed .rk-api-entry-label{display:none}
      .rk-api-mask{position:fixed;inset:0;z-index:2700;display:flex;justify-content:flex-end;background:rgba(18,28,52,.28);backdrop-filter:blur(4px)}
      .rk-api-panel{display:flex;flex-direction:column;width:min(1180px,100%);height:100%;background:var(--rk-bg);border-left:1px solid var(--rk-border);box-shadow:-16px 0 48px -24px rgba(20,40,90,.35)}
      .rk-api-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--rk-border)}
      .rk-api-head h2{margin:0;font-size:16px;font-weight:600;color:var(--rk-ink-1)}
      .rk-api-head p{margin:3px 0 0;font-size:12px;color:var(--rk-ink-3)}
      .rk-api-close{width:30px;height:30px;border:0;border-radius:999px;background:transparent;color:var(--rk-ink-2);font-size:20px;cursor:pointer}
      .rk-api-close:hover{background:rgba(31,41,64,.06)}
      .rk-api-body{flex:1;min-height:0;display:flex}
      .rk-api-aside{flex:0 0 300px;display:flex;flex-direction:column;border-right:1px solid var(--rk-border);background:var(--rk-panel-2)}
      .rk-api-search{padding:12px;border-bottom:1px solid var(--rk-border)}
      .rk-api-search input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border:1px solid var(--rk-border-strong);border-radius:var(--gl-r-control);background:var(--rk-bg);color:var(--rk-ink-1);font:inherit;font-size:12.5px}
      .rk-api-list{flex:1;overflow:auto;padding:8px 10px 16px}
      .rk-api-group{margin:10px 0 4px;padding:0 6px;font-size:11px;font-weight:600;letter-spacing:.03em;color:var(--rk-ink-3)}
      .rk-api-item{display:flex;gap:8px;align-items:center;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;cursor:pointer;text-align:left;font:inherit}
      .rk-api-item:hover{background:rgba(31,41,64,.06)}
      .rk-api-item.is-active{background:rgba(24,95,165,.1)}
      .rk-api-method{flex:0 0 auto;min-width:44px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;font-weight:600}
      .rk-api-path{flex:1;min-width:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--rk-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .rk-api-main{flex:1;min-width:0;display:flex;flex-direction:column}
      .rk-api-req{padding:14px 18px;border-bottom:1px solid var(--rk-border)}
      .rk-api-row{display:flex;gap:8px;align-items:center}
      .rk-api-row select{height:34px;padding:0 8px;border:1px solid var(--rk-border-strong);border-radius:var(--gl-r-control);background:var(--rk-bg);color:var(--rk-ink-1);font:inherit;font-size:12.5px;font-family:ui-monospace,Menlo,Consolas,monospace}
      .rk-api-url{flex:1;height:34px;padding:0 10px;border:1px solid var(--rk-border-strong);border-radius:var(--gl-r-control);background:var(--rk-bg);color:var(--rk-ink-1);font:inherit;font-size:12.5px;font-family:ui-monospace,Menlo,Consolas,monospace}
      .rk-api-row button{height:34px;padding:0 18px;border:0;border-radius:999px;background:var(--rk-grad-primary);color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
      .rk-api-row button:hover{filter:brightness(1.05)}
      .rk-api-row button[disabled]{opacity:.6;cursor:not-allowed}
      .rk-api-params{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
      .rk-api-field{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--rk-ink-3)}
      .rk-api-field input{width:120px;height:28px;padding:0 8px;border:1px solid var(--rk-border-strong);border-radius:6px;background:var(--rk-bg);color:var(--rk-ink-1);font:inherit;font-size:12px}
      .rk-api-note{margin-top:8px;font-size:11.5px;color:var(--rk-ink-3);line-height:1.5}
      .rk-api-bodybox{margin-top:10px}
      .rk-api-bodybox textarea{width:100%;box-sizing:border-box;min-height:120px;max-height:260px;resize:vertical;padding:9px 11px;border:1px solid var(--rk-border-strong);border-radius:var(--gl-r-control);background:var(--rk-bg);color:var(--rk-ink-1);font:inherit;font-size:12px;line-height:1.6;font-family:ui-monospace,Menlo,Consolas,monospace}
      .rk-api-bodybox textarea:focus,.rk-api-url:focus,.rk-api-search input:focus{outline:0;border-color:var(--rk-accent);box-shadow:0 0 0 3px var(--rk-accent-soft)}
      .rk-api-resp{flex:1;min-height:0;display:flex;flex-direction:column}
      .rk-api-status{display:flex;align-items:center;gap:12px;padding:9px 18px;border-bottom:1px solid var(--rk-border);font-size:12px;color:var(--rk-ink-3)}
      .rk-api-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600;font-size:12.5px}
      .rk-api-code.ok{color:#0F6E56}
      .rk-api-code.warn{color:#854F0B}
      .rk-api-code.err{color:#A32D2D}
      .rk-api-out{flex:1;margin:0;padding:14px 18px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--rk-ink-2);background:var(--rk-bg)}
      .rk-api-empty{padding:28px;text-align:center;font-size:12.5px;color:var(--rk-ink-3)}
      .rk-api-toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;gap:8px;pointer-events:none}
      .rk-api-toast{max-width:380px;padding:9px 14px;border-radius:var(--gl-r-control);background:rgba(23,28,38,.92);color:#fff;font-size:13px;line-height:1.45}
      .rk-api-toast.is-error{background:rgba(190,38,38,.95)}
      @media (max-width:900px){.rk-api-aside{display:none}}
    `;
    document.head.append(style);
  }

  // ── 侧栏入口 ──
  function mountEntry() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar || document.getElementById(ENTRY_ID)) return;
    const menu = sidebar.querySelector(".sidebar-menu") || sidebar;
    const entry = el("button", "rk-api-entry");
    entry.id = ENTRY_ID;
    entry.type = "button";
    entry.append(el("span", "rk-api-entry-dot"));
    entry.append(el("span", "rk-api-entry-label", "接口调试"));
    entry.addEventListener("click", openPanel);
    menu.append(entry);
  }

  const groupOf = (url) => {
    const parts = url.split("/").filter(Boolean); // api, v1, xxx
    return parts[2] || "其他";
  };

  async function openPanel() {
    styles();
    if (document.querySelector(`.${MASK_CLASS}`)) return;

    const mask = el("div", MASK_CLASS);
    const panel = el("section", "rk-api-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "接口调试");
    mask.append(panel);
    document.body.append(mask);

    const close = () => {
      document.removeEventListener("keydown", onKey);
      mask.remove();
    };
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    mask.addEventListener("click", (event) => {
      if (event.target === mask) close();
    });
    document.addEventListener("keydown", onKey);

    const head = el("header", "rk-api-head");
    const titles = el("div");
    titles.append(el("h2", null, "接口调试"));
    titles.append(el("p", null, "左侧是服务真实注册的路由，后端加了接口刷新就有；token 自动带"));
    const closeBtn = el("button", "rk-api-close", "×");
    closeBtn.type = "button";
    closeBtn.addEventListener("click", close);
    head.append(titles, closeBtn);

    const body = el("div", "rk-api-body");
    const aside = el("aside", "rk-api-aside");
    const searchBox = el("div", "rk-api-search");
    const search = el("input");
    search.placeholder = "搜路径，例如 agent、kb-faqs";
    searchBox.append(search);
    const list = el("div", "rk-api-list");
    aside.append(searchBox, list);

    const main = el("section", "rk-api-main");
    const req = el("div", "rk-api-req");
    const row = el("div", "rk-api-row");
    const method = el("select");
    for (const item of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const option = el("option", null, item);
      option.value = item;
      method.append(option);
    }
    const url = el("input", "rk-api-url");
    url.placeholder = "/api/v1/...";
    const send = el("button", null, "发送");
    send.type = "button";
    row.append(method, url, send);

    const params = el("div", "rk-api-params");
    const note = el("p", "rk-api-note");
    note.textContent = "路径里的 :id 之类会变成输入框；没填就直接发原样路径。";
    const bodyBox = el("div", "rk-api-bodybox");
    const bodyArea = el("textarea");
    bodyArea.placeholder = "请求体（JSON）。GET 一般留空。";
    bodyBox.append(bodyArea);

    req.append(row, params, note, bodyBox);

    const resp = el("div", "rk-api-resp");
    const statusBar = el("div", "rk-api-status");
    const out = el("pre", "rk-api-out", "选一个接口，点发送。");
    resp.append(statusBar, out);
    main.append(req, resp);
    body.append(aside, main);
    panel.append(head, body);

    const state = { routes: [], current: null, paramValues: {} };

    function renderList(filter) {
      list.innerHTML = "";
      const keyword = String(filter || "").trim().toLowerCase();
      const groups = new Map();
      for (const route of state.routes) {
        if (keyword && !route.url.toLowerCase().includes(keyword)) continue;
        const key = groupOf(route.url);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(route);
      }
      if (!groups.size) {
        list.append(el("div", "rk-api-empty", "没有匹配的接口"));
        return;
      }
      for (const [key, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        list.append(el("div", "rk-api-group", key));
        for (const route of items) {
          const item = el("button", "rk-api-item");
          item.type = "button";
          const methodTag = el("span", "rk-api-method", route.method);
          methodTag.style.color = METHOD_COLOR[route.method] || "var(--rk-ink-2)";
          item.append(methodTag, el("span", "rk-api-path", route.url));
          if (state.current && state.current.method === route.method && state.current.url === route.url) {
            item.classList.add("is-active");
          }
          item.addEventListener("click", () => select(route));
          list.append(item);
        }
      }
    }

    function renderParams() {
      params.innerHTML = "";
      state.paramValues = {};
      const names = [...String(url.value).matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
      for (const name of [...new Set(names)]) {
        const field = el("label", "rk-api-field");
        field.append(document.createTextNode(`:${name}`));
        const input = el("input");
        input.placeholder = name === "id" ? "数字 id" : name;
        input.addEventListener("input", () => {
          state.paramValues[name] = input.value.trim();
        });
        field.append(input);
        params.append(field);
      }
      if (!names.length) {
        params.append(el("span", "rk-api-field", "这个接口没有路径参数"));
      }
    }

    function select(route) {
      state.current = route;
      method.value = route.method;
      url.value = route.url;
      const template = BODY_TEMPLATES[`${route.method} ${route.url}`] || "";
      bodyArea.value = template;
      bodyArea.disabled = route.method === "GET";
      renderParams();
      renderList(search.value);
      statusBar.innerHTML = "";
      out.textContent = "点「发送」执行这次请求。";
    }

    function finalUrl() {
      let value = url.value.trim();
      for (const [name, filled] of Object.entries(state.paramValues)) {
        if (!filled) continue;
        value = value.replaceAll(`:${name}`, encodeURIComponent(filled));
      }
      return value;
    }

    async function doSend() {
      const target = finalUrl();
      if (!target) {
        toast("先填 URL", "error");
        return;
      }
      if (/:([A-Za-z_][A-Za-z0-9_]*)/.test(target)) {
        toast("还有 :参数 没填，先补上路径参数", "error");
        return;
      }
      if (method.value === "DELETE" && !window.confirm(`确定要发 DELETE ${target} ？这会真的删数据。`)) {
        return;
      }

      const headers = { accept: "application/json" };
      const value = token();
      if (value) headers.authorization = `Bearer ${value}`;
      let payload;
      if (method.value !== "GET" && bodyArea.value.trim()) {
        headers["content-type"] = "application/json";
        payload = bodyArea.value.trim();
      }

      send.disabled = true;
      send.textContent = "发送中…";
      const started = performance.now();
      try {
        const response = await fetch(target, { method: method.value, headers, body: payload });
        const elapsed = Math.round(performance.now() - started);
        const text = await response.text();

        statusBar.innerHTML = "";
        const code = el("span", `rk-api-code ${response.ok ? "ok" : response.status >= 500 ? "err" : "warn"}`, `${response.status} ${response.statusText}`);
        statusBar.append(code, el("span", null, `${elapsed} ms`), el("span", null, `${text.length} 字节`));

        let pretty = text;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // 非 JSON（例如下载文件）就原样显示
        }
        out.textContent = pretty || "(空响应)";
      } catch (error) {
        statusBar.innerHTML = "";
        statusBar.append(el("span", "rk-api-code err", "请求失败"));
        out.textContent = String(error && error.message ? error.message : error);
        toast("请求失败，看下面的错误信息", "error");
      } finally {
        send.disabled = false;
        send.textContent = "发送";
      }
    }

    search.addEventListener("input", () => renderList(search.value));
    url.addEventListener("input", renderParams);
    method.addEventListener("change", () => {
      bodyArea.disabled = method.value === "GET";
    });
    send.addEventListener("click", doSend);
    bodyArea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") doSend();
    });

    try {
      const result = await fetch("/api/v1/debug/routes", {
        headers: token() ? { authorization: `Bearer ${token()}` } : {},
      });
      const data = await result.json().catch(() => ({}));
      if (!result.ok) throw new Error(data.detail || `HTTP ${result.status}`);
      state.routes = Array.isArray(data.items) ? data.items : [];
    } catch (error) {
      list.append(el("div", "rk-api-empty", `读取路由失败：${error.message}`));
      return;
    }

    renderList("");
    const preferred = state.routes.find((route) => route.method === "GET" && route.url.includes("agent/context"))
      || state.routes.find((route) => route.method === "GET" && route.url.includes("agent"))
      || state.routes[0];
    if (preferred) select(preferred);
  }

  function start() {
    styles();
    mountEntry();
    let frame = 0;
    new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!document.getElementById(ENTRY_ID)) mountEntry();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

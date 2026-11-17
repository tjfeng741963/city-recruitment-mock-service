/**
 * 设备页「绑定工厂」（2026-11-14 客户要求）。
 *
 * 线上后台是编译好的 Vue 包（public/assets/），仓库里没有 .vue 源码，改不了路由和表格列。
 * 这里沿用项目已有的做法（theme/city-factories.js、device-code.js 同一套路）在运行时补：
 *
 *   1. /agent-devices（侧栏「坐席设备」）每一行的设备名下面加一行：已绑工厂 + 「绑定工厂」按钮
 *   2. 点按钮开右侧抽屉：按城市分组列出全部工厂，checkbox 多选
 *   3. 保存走 PUT /api/v1/agent/devices/:id，只提交 factory_ids
 *
 * 接口（Node 端同仓库）：
 *   GET /api/v1/agent/devices            → 每行含 factory_ids、factories:[{id,name,city_name}]
 *   GET /api/v1/factories?page_size=1000 → 全量工厂（只有 city_id，没有 city_name）
 *   GET /api/v1/cities?page_size=1000    → 把 city_id 翻成城市名，供抽屉分组
 *   PUT /api/v1/agent/devices/:id        → 浅合并进 data_json，见 save() 的注释
 *
 * 为什么不改表格列：Vue 的虚拟 DOM 每次重渲染都会把注入的列/节点冲掉，
 * 只能把节点挂到「进行中的 DOM」上靠 MutationObserver 续挂 —— 这是这套编译产物里唯一稳的做法。
 */
{
  const PATH_PREFIX = "/agent-devices";
  // 行内状态块的标记：Vue 重渲染后旧节点会消失，新节点靠这个属性判断「这一行已经挂过了」。
  const BLOCK = "data-rk-devf";
  const STYLE_ID = "rk-devf-style";

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

  // ── 样式：沿用后台现有的浅描边 / Element 蓝，不引入新的视觉语言 ──
  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .rk-devf{display:flex;align-items:center;gap:8px;margin-top:6px;min-width:0;font-size:12px;line-height:1.4;color:var(--rk-ink-3);font-weight:400;flex-wrap:wrap}
      .rk-devf-chips{flex:0 1 auto;display:flex;flex-wrap:wrap;gap:5px;min-width:0;max-width:100%}
      .rk-devf-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:23px;padding:0 10px;border-radius:999px;background:var(--rk-accent-soft);color:var(--rk-accent);font-size:11.5px;font-weight:500;line-height:23px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:inset 0 0 0 1px rgba(11,87,208,.14)}
      .rk-devf-chip i{flex:0 0 auto;width:5px;height:5px;border-radius:50%;background:var(--rk-accent)}
      .rk-devf-chip.is-empty{background:var(--rk-bg);color:var(--rk-ink-3);border:1px dashed var(--rk-border-strong)}
      .rk-devf-btn{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 11px;border:0;border-radius:999px;background:var(--rk-accent-soft);color:var(--rk-accent);cursor:pointer;font:inherit;font-size:11.5px;font-weight:500;line-height:23px;transition:background .15s ease,color .15s ease,box-shadow .15s ease,transform .15s ease}
      .rk-devf-btn::before{content:"+";font-size:12px;font-weight:700;line-height:1}
      .rk-devf-btn:hover{background:var(--rk-accent);color:#fff;box-shadow:0 4px 12px -4px rgba(11,87,208,.55);transform:translateY(-1px)}
      .rk-devf-btn:active{transform:translateY(0);box-shadow:none}
      .rk-devf-mask{position:fixed;inset:0;z-index:4000;display:flex;justify-content:flex-end;background:rgba(18,28,52,.26);backdrop-filter:blur(6px) saturate(1.2);-webkit-backdrop-filter:blur(6px) saturate(1.2)}
      .rk-devf-panel{display:flex;flex-direction:column;width:min(520px,100%);height:100%;border:1px solid var(--gl-edge);border-radius:var(--gl-r-shell) 0 0 var(--gl-r-shell);background:linear-gradient(180deg,rgba(255,255,255,.94),rgba(250,252,255,.86));backdrop-filter:var(--gl-blur);-webkit-backdrop-filter:var(--gl-blur);box-shadow:var(--gl-shadow-float)}
      .rk-devf-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--rk-border)}
      .rk-devf-head h2{margin:0;font-size:17px;font-weight:600;color:var(--rk-ink-1)}
      .rk-devf-head p{margin:4px 0 0;font-size:12px;color:var(--rk-ink-3)}
      .rk-devf-close{width:30px;height:30px;border:0;background:transparent;color:var(--rk-ink-2);font-size:20px;cursor:pointer;border-radius:999px}
      .rk-devf-close:hover{background:rgba(31,41,64,.06)}
      .rk-devf-count{margin:0;padding:10px 20px;background:var(--rk-panel-2);border-bottom:1px solid var(--rk-border);font-size:13px;color:var(--rk-ink-1)}
      .rk-devf-body{flex:1;overflow:auto;padding:12px 20px 20px}
      .rk-devf-group{margin-top:14px}
      .rk-devf-city{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--rk-ink-1)}
      .rk-devf-city small{margin-left:6px;font-weight:400;color:var(--rk-ink-3)}
      .rk-devf-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:var(--gl-r-control);cursor:pointer;font-size:13px;color:var(--rk-ink-1)}
      .rk-devf-item:hover{background:rgba(31,41,64,.05)}
      .rk-devf-item input{margin:0;cursor:pointer}
      .rk-devf-item span{flex:1 1 auto;min-width:0;word-break:break-all}
      .rk-devf-item em{flex:0 0 auto;font-style:normal;font-size:12px;color:var(--rk-ink-3)}
      .rk-devf-empty{padding:28px 0;text-align:center;color:var(--rk-ink-3);font-size:13px}
      .rk-devf-error{margin:10px 0 0;color:var(--rk-down);font-size:13px}
      .rk-devf-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--rk-border)}
      .rk-devf-foot button{min-height:32px;padding:0 16px;border:1px solid var(--rk-border-strong);border-radius:999px;background:var(--rk-bg);color:var(--rk-ink-1);cursor:pointer;font:inherit;font-size:13px}
      .rk-devf-foot button:hover{border-color:var(--rk-accent);color:var(--rk-accent)}
      .rk-devf-foot button.primary{border:0;background:var(--rk-grad-primary);color:#fff;font-weight:600}
      .rk-devf-foot button.primary:hover{filter:brightness(1.05);color:#fff}
      .rk-devf-foot button.primary[disabled]{opacity:.6;cursor:not-allowed}
      .rk-devf-toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
      .rk-devf-toast{max-width:360px;padding:9px 14px;border-radius:var(--gl-r-control);background:rgba(23,28,38,.92);color:#fff;font-size:13px;line-height:1.45;box-shadow:var(--gl-shadow-float);transition:opacity .2s ease;word-break:break-word}
      .rk-devf-toast.is-error{background:rgba(190,38,38,.95)}
    `;
    document.head.append(style);
  }

  // realtime.js 里也有 toast，但没挂到 window 上，跨脚本拿不到，随便改它风险更大 —— 自带一份。
  function toast(text, tone) {
    if (!document.body) return;
    let host = document.querySelector(".rk-devf-toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "rk-devf-toasts";
      document.body.append(host);
    }
    const box = document.createElement("div");
    box.className = `rk-devf-toast${tone === "error" ? " is-error" : ""}`;
    box.setAttribute("role", "status");
    box.textContent = text;
    host.append(box);
    setTimeout(() => {
      box.style.opacity = "0";
      setTimeout(() => box.remove(), 220);
    }, 2600);
  }

  // ── 数据缓存 ──
  // 设备列表短缓存：同一屏幕几十行都要查同一份数据，不缓存会打出几十个请求。
  let deviceCache = { at: 0, items: [] };
  async function devices(force = false) {
    if (!force && deviceCache.items.length && Date.now() - deviceCache.at < 20_000) return deviceCache.items;
    const result = await api("/api/v1/agent/devices");
    deviceCache = { at: Date.now(), items: Array.isArray(result.items) ? result.items : [] };
    return deviceCache.items;
  }

  // 全量工厂 + 城市名。GET /factories 的序列化结果只有 city_id（response-serializers.ts 的
  // FACTORY_FIELDS 里没有 city_name），所以必须再取一次 /cities 自己拼城市名。
  let factoryCache = { at: 0, items: [] };
  async function factories(force = false) {
    if (!force && factoryCache.items.length && Date.now() - factoryCache.at < 60_000) return factoryCache.items;
    const result = await api("/api/v1/factories?page=1&page_size=1000");
    const rows = Array.isArray(result.items) ? result.items : [];
    let cityNames = new Map();
    try {
      const cityResult = await api("/api/v1/cities?page=1&page_size=1000");
      cityNames = new Map((cityResult.items || []).map((city) => [Number(city.id), String(city.city_name || "")]));
    } catch {
      // 城市表没权限也不该让抽屉打不开：工厂照列，分组降级成「未分配城市」。
    }
    factoryCache = {
      at: Date.now(),
      items: rows.map((row) => ({
        id: Number(row.id),
        name: String(row.factory_name ?? row.name ?? ""),
        cityName: cityNames.get(Number(row.city_id)) || "",
        active: row.is_active !== false,
      })),
    };
    return factoryCache.items;
  }

  const idsOf = (device) => (Array.isArray(device?.factory_ids) ? device.factory_ids : []).map(Number).filter((id) => id > 0);

  // 地铁安检不该出现在「绑定工厂」里。
  //
  // 根因：v3 里地铁安检是 subway 品类的招工方（employer.vertical_id），
  // 但旧的 factories 表没有品类列，029_kb_real_subway.sql 为了给「安检员」岗位
  // 挂父节点，把 6 家地铁面试点直接插进了 factories，于是绑定抽屉按 /factories
  // 全量列出时，它们和松下万宝、广州酒家混在一起，没有任何依据能区分。
  //
  // 这里不靠猜关键字（「地铁」「安检」这种名字匹配迟早误伤真实工厂），
  // 而是拿招工方表的 subway 品类名单做权威比对，按 display_name ↔ factory_name 对上。
  // 取不到名单时降级为「不过滤」——宁可多显示几个，也不能让抽屉打不开。
  let subwayCache = { at: 0, names: new Set() };
  async function subwayNames(force = false) {
    if (!force && subwayCache.names.size && Date.now() - subwayCache.at < 300_000) return subwayCache.names;
    try {
      const verticals = await api("/api/v1/verticals");
      const subway = (verticals.items || []).find((row) => String(row.code) === "subway");
      if (!subway) return subwayCache.names;
      const employers = await api(`/api/v1/employers?vertical_id=${Number(subway.id)}`);
      subwayCache = {
        at: Date.now(),
        names: new Set((employers.items || []).map((row) => String(row.display_name || "")).filter(Boolean)),
      };
    } catch {
      // 品类接口没有权限或尚未配置时保持原样：不隐藏任何工厂。
    }
    return subwayCache.names;
  }

  // 行内文案优先用接口回传的 factories（带厂名/城市名）；老接口没有这个字段时按 id 反查工厂缓存。
  function boundNames(device) {
    const list = Array.isArray(device?.factories) ? device.factories : [];
    const names = list.map((factory) => String(factory.name ?? factory.factory_name ?? "")).filter(Boolean);
    if (names.length) return names;
    return idsOf(device).map((id) => factoryCache.items.find((factory) => factory.id === id)?.name || `#${id}`);
  }

  // ── 行内状态块 ──
  // 为什么挂在「设备名称」单元格里、而不是「操作」列：
  // 操作列 width:200 且 fixed:"right"，里面已经有 编辑/复制/删除 三个按钮，
  // 再塞第四个会被 .cell 的 overflow 裁掉；名称列是 min-width，窗口宽时有富余空间。
  function ensureBlock(cell, device) {
    let block = cell.querySelector(`[${BLOCK}]`);
    if (block) return block;

    block = document.createElement("div");
    block.className = "rk-devf";
    block.setAttribute(BLOCK, String(device.id ?? ""));

    const chips = document.createElement("div");
    chips.className = "rk-devf-chips";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "rk-devf-btn";
    button.textContent = "绑定工厂";
    button.addEventListener("click", (event) => {
      // 行被重渲染后闭包里的 device 可能过期，点击时按 id 重新取一次缓存。
      event.preventDefault();
      event.stopPropagation();
      const id = Number(block.getAttribute(BLOCK) || 0);
      const current = deviceCache.items.find((item) => Number(item.id) === id) || device;
      openDrawer(current);
    });

    block.append(chips, button);
    cell.append(block);
    return block;
  }

  function paint(block, device) {
    if (block.getAttribute(BLOCK) !== String(device.id ?? "")) block.setAttribute(BLOCK, String(device.id ?? ""));
    const chips = block.querySelector(".rk-devf-chips");
    const names = boundNames(device);
    // 值没变就不碰 DOM：这个脚本自己也在 MutationObserver 的监听范围里，
    // 无条件重写会让「改文本 → 触发观察 → 再改文本」变成每帧一次的空转。
    const next = names.join("\u0001");
    if (chips.dataset.names === next) return;
    chips.dataset.names = next;
    chips.innerHTML = "";
    if (names.length) {
      names.forEach((name) => {
        const chip = document.createElement("span");
        chip.className = "rk-devf-chip";
        chip.title = name;
        const dot = document.createElement("i");
        chip.append(dot, name);
        chips.append(chip);
      });
    } else {
      const chip = document.createElement("span");
      chip.className = "rk-devf-chip is-empty";
      chip.textContent = "未绑定工厂";
      chips.append(chip);
    }
  }

  // 从 DOM 反查这一行是哪台设备：编译产物里拿不到 Vue 组件实例，
  // 只能读单元格文本。设备码唯一，优先按设备码精确匹配；列顺序变了也不会匹配错。
  function deviceOfRow(row, list) {
    const cells = [...row.querySelectorAll("td .cell")];
    for (const cell of cells) {
      if (cell.querySelector(`[${BLOCK}]`)) continue; // 跳过自己注入的块，别把「已绑…」当成设备码
      const text = cell.textContent.trim();
      if (!text) continue;
      const hit = list.find((device) => String(device.device_code || "") === text);
      if (hit) return hit;
    }
    // 兜底：按设备名匹配。第一个文本节点才是设备名（注入块是元素节点，不在文本节点里）。
    const first = cells[0];
    if (!first) return null;
    for (const node of first.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const name = node.textContent.trim();
      if (!name) continue;
      return list.find((device) => String(device.name || "") === name) || null;
    }
    return null;
  }

  // ── 抽屉 ──
  async function openDrawer(device) {
    styles();
    if (document.querySelector(".rk-devf-mask")) return; // 只允许开一个

    const mask = document.createElement("div");
    mask.className = "rk-devf-mask";
    mask.setAttribute("role", "presentation");

    const panel = document.createElement("section");
    panel.className = "rk-devf-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "绑定工厂");
    mask.append(panel);
    document.body.append(mask);

    const close = () => {
      document.removeEventListener("keydown", onKey);
      mask.remove();
    };
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    mask.addEventListener("click", (event) => { if (event.target === mask) close(); });
    document.addEventListener("keydown", onKey);

    const head = document.createElement("div");
    head.className = "rk-devf-head";
    const titles = document.createElement("div");
    const h2 = document.createElement("h2");
    h2.textContent = "绑定工厂";
    const sub = document.createElement("p");
    sub.textContent = `${device.name || device.device_code || "设备"}（${device.device_code || "无设备码"}）· 可多选`;
    titles.append(h2, sub);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "rk-devf-close";
    x.setAttribute("aria-label", "关闭");
    x.textContent = "×";
    x.addEventListener("click", close);
    head.append(titles, x);

    const count = document.createElement("p");
    count.className = "rk-devf-count";
    const selected = new Set(idsOf(device));
    const syncCount = () => {
      count.textContent = selected.size
        ? `已选 ${selected.size} 个工厂`
        : "已选 0 个：不绑工厂时按设备所属城市全量推荐";
    };
    syncCount();

    const body = document.createElement("div");
    body.className = "rk-devf-body";
    const error = document.createElement("p");
    error.className = "rk-devf-error";
    const loading = document.createElement("p");
    loading.className = "rk-devf-empty";
    loading.textContent = "工厂加载中…";
    body.append(error, loading);

    const foot = document.createElement("div");
    foot.className = "rk-devf-foot";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", close);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "保存";
    foot.append(cancel, save);

    panel.append(head, count, body, foot);

    // 按城市分组：城市名字母序（中文按拼音），未归属城市的工厂放最后。
    const group = (items) => {
      const map = new Map();
      for (const factory of items) {
        const key = factory.cityName || "未分配城市";
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(factory);
      }
      const names = [...map.keys()].filter((name) => name !== "未分配城市").sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
      if (map.has("未分配城市")) names.push("未分配城市");
      return names.map((name) => ({ name, items: map.get(name).sort((a, b) => a.id - b.id) }));
    };

    const render = (items) => {
      loading.remove();
      body.replaceChildren(error, ...group(items).map(({ name, items: rows }) => {
        const wrap = document.createElement("div");
        wrap.className = "rk-devf-group";
        const title = document.createElement("h3");
        title.className = "rk-devf-city";
        title.textContent = name;
        const size = document.createElement("small");
        size.textContent = `${rows.length} 个`;
        title.append(size);
        wrap.append(title);
        for (const factory of rows) {
          const label = document.createElement("label");
          label.className = "rk-devf-item";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = selected.has(factory.id);
          input.addEventListener("change", () => {
            if (input.checked) selected.add(factory.id);
            else selected.delete(factory.id);
            syncCount();
          });
          const text = document.createElement("span");
          text.textContent = factory.name;
          label.append(input, text);
          if (!factory.active) {
            const off = document.createElement("em");
            off.textContent = "已停用";
            label.append(off);
          }
          wrap.append(label);
        }
        return wrap;
      }));
      if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "rk-devf-empty";
        empty.textContent = "还没有工厂。先到「城市管理」里给城市建厂区。";
        body.append(empty);
      }
    };

    save.addEventListener("click", async () => {
      error.textContent = "";
      save.disabled = true;
      save.textContent = "保存中…";
      const ids = [...selected];
      try {
        // PUT 的语义（src/modules/agent/agent.routes.ts:100-110,121-122）：
        // 服务端先读出旧 data_json，再 {...旧数据, ...请求体} 浅合并后整体写回。
        // 所以只传 factory_ids 就够 —— device_code / factory_name / employer_id 由服务端保留，
        // 不需要前端先 GET 再合并；反过来若传 { data_json: {...} }，会多写一层嵌套的 data_json 键。
        await api(`/api/v1/agent/devices/${device.id}`, {
          method: "PUT",
          body: JSON.stringify({ factory_ids: ids }),
        });
        // 先用本地已知的厂名把这一行刷成新状态（不必等下一次 GET），再后台对齐服务端。
        const cached = deviceCache.items.find((item) => Number(item.id) === Number(device.id));
        if (cached) {
          cached.factory_ids = ids;
          cached.factories = ids
            .map((id) => factoryCache.items.find((factory) => factory.id === id))
            .filter(Boolean)
            .map((factory) => ({ id: factory.id, name: factory.name, city_name: factory.cityName }));
        }
        close();
        repaint();
        toast(ids.length ? `已保存：绑定 ${ids.length} 个工厂` : "已保存：取消全部工厂绑定");
        refresh();
      } catch (caught) {
        error.textContent = `保存失败：${caught.message}`;
        toast(`保存失败：${caught.message}`, "error");
        save.disabled = false;
        save.textContent = "保存";
      }
    });

    // 过滤地铁安检：按招工方表 subway 品类的 display_name 比对。
    // 已勾选的保留——老设备如果历史上绑过安检，还得能在抽屉里取消，否则就永久绑死了。
    const pickable = (items, hidden) =>
      items.filter((factory) => selected.has(factory.id) || !hidden.has(factory.name));

    try {
      const [all, hidden] = await Promise.all([factories(), subwayNames()]);
      render(pickable(all, hidden));
    } catch (caught) {
      loading.remove();
      error.textContent = `工厂加载失败：${caught.message}`;
    }
  }

  // ── 装饰当前页 ──
  let decorating = false;
  let factoryPending = false;
  async function decorate() {
    if (!location.pathname.startsWith(PATH_PREFIX)) return;
    if (decorating) return;
    decorating = true;
    try {
      // 只看主表格的行；弹窗里若也有表格不碰。
      // 首选 `.page`（AgentDeviceView 的根 div），万一以后包一层导致找不到，退回全页表格行 ——
      // 路由已经限定在 /agent-devices，这页只有一张表。
      const scoped = [...document.querySelectorAll(".page .el-table__row")];
      const rows = (scoped.length ? scoped : [...document.querySelectorAll(".el-table__row")])
        .filter((row) => !row.closest(".el-dialog"));
      if (!rows.length) return;
      const list = await devices();
      for (const row of rows) {
        const device = deviceOfRow(row, list);
        if (!device) continue;
        const cell = row.querySelector("td .cell");
        if (!cell) continue;
        paint(ensureBlock(cell, device), device);
      }
      // 接口只给了 factory_ids、没有 factories 时，先显示 #id，等工厂缓存到位再补成厂名。
      // factoryPending 防止接口一直失败时每次重渲染都重新打一遍请求。
      if (!factoryPending && !factoryCache.items.length
        && list.some((device) => idsOf(device).length && !(Array.isArray(device.factories) && device.factories.length))) {
        factoryPending = true;
        factories().then(() => repaint()).catch(() => {}).finally(() => { factoryPending = false; });
      }
    } catch {
      // 未登录 / 接口 403 / 老后端没有 factory_ids：一个节点都不加，页面照常可用
    } finally {
      decorating = false;
    }
  }

  // 只重画已经挂好的行内块，不动 DOM 结构（保存成功后立即生效，不整页刷新）。
  function repaint() {
    for (const block of document.querySelectorAll(`[${BLOCK}]`)) {
      const id = Number(block.getAttribute(BLOCK) || 0);
      const device = deviceCache.items.find((item) => Number(item.id) === id);
      if (device) paint(block, device);
    }
  }

  // 后台静默对齐服务端（localStorage 里刚写的是推测值，以服务端规范化结果为准）。
  async function refresh() {
    try {
      await devices(true);
      repaint();
    } catch { /* 失败就保持本地状态，下一次渲染还会再来一遍 */ }
  }

  let frame = 0;
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      decorate();
    });
  }

  // 监听 documentElement 而不是 body：脚本在 <head> 里执行时 body 可能还是 null。
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else {
    schedule();
  }
}

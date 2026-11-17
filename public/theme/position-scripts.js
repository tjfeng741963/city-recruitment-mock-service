/**
 * 岗位页「话术配置」（2026-11-14 四端契约）。
 *
 * 线上后台是编译好的 Vue 包（public/assets/），仓库里没有 .vue 源码，改不了表格列、也加不了路由。
 * 所以沿用项目已有的做法（theme/device-factories.js、city-factories.js 同一套路）在运行时补：
 *
 *   1. /service-positions（侧栏「岗位 / 工作」）每一行的岗位名下面加一行「话术 · 已配 N/9」按钮
 *   2. 点按钮开右侧抽屉：九个时点各一份 标题 + 正文，可插占位符、可挂图片/视频；
 *      每一步都显示「什么时候发 / 不填时客户收到什么」，运营照着填即可
 *   3. 打开时 GET 回填，保存走 POST（服务端 UNIQUE(position_id,stage) 是 upsert，重复点不会堆行）
 *
 * 接口（Node 端 src/modules/agent/position-scripts.routes.ts，已实现）：
 *   GET    /api/v1/service-positions?page=1&page_size=1000 → 岗位 id / position_name / store_name / city_name
 *   GET    /api/v1/position-scripts[?position_id=]         → {items:[{id,position_id,stage,title,content,media,status}]}
 *   POST   /api/v1/position-scripts                       → {position_id, stage, title, content, media:[{name,kind}]}
 *   GET    /api/v1/media                                  → {items:[{id,name,kind,sha256,bytes}]}
 *   POST   /api/v1/media                                  → {name,kind,data_base64} → {id,name,kind,sha256,bytes}
 *
 * 为什么只能「续挂节点」而不是改表格列：Vue 的虚拟 DOM 每次重渲染都会把注入的节点冲掉，
 * 只有把节点挂到当前这份 DOM 上、靠 MutationObserver 重挂，才是这套编译产物里唯一稳的做法。
 */
{
  // 列表页正则：/service-positions 与 /service-positions/ 都算；/service-positions/12/edit 不算。
  // 为什么不用 startsWith：编辑页复用了同一个路由前缀，在编辑页塞表格按钮会匹配不到行、白跑。
  const LIST_PATH = /^\/service-positions\/?$/;
  // 行内块标记：Vue 重渲染后节点消失，新节点靠这个属性判断「这一行已经挂过了」。
  // 值同时存 position_id，点击时按 id 回查缓存，避免闭包里的对象过期。
  const MARK = "data-rk-pscripts";
  const STYLE_ID = "rk-pscripts-style";

  // 话术时点：顺序即客户实际经历的流程顺序，key 是后端 SCRIPT_STAGES 白名单，不能改。
  //
  // 每一项都写清三件事，页面上原样展示给运营：
  //   when      —— 什么时候会发（客户走到哪一步）
  //   fallback  —— 不填时客户实际会收到什么（代码里现在硬编码的那句）
  //   tokens    —— 这一步最常用的占位符，排在占位符条最前面
  // 2026-11-17 扩充：原来只有 5 个时点，问城市/要姓名电话/收尾这几句写死在代码里，
  // 运营在页面上既看不见也改不了，等于流程有一半不可配。
  const STAGES = [
    {
      key: "greet",
      label: "加好友首句",
      when: "客户刚加上好友、还没开口时发出；通常用来问城市，也可先发一段招聘介绍。",
      fallback: "没配首句时：先发该企微号配置的「招聘介绍」；再没有就直接发岗位卡。",
      tokens: ["{{factory}}", "{{job_title}}", "{{cities}}"],
    },
    {
      key: "ask_city",
      label: "问城市",
      when: "还不知道客户在哪个城市、需要先问清楚时。",
      fallback: "你投递的是哪个城市的简历？我们这边{cities}都有厂在招。",
      tokens: ["{{cities}}"],
    },
    {
      key: "send_info",
      label: "发岗位信息",
      when: "客户报了城市、确定要发这个岗位的详情时；可带图片和视频。",
      fallback: "没填时：代码按岗位数据自动拼「工价 / 班次 / 年龄 / 吃住 / 面试地点」和多段信息。",
      tokens: ["{{factory}}", "{{job_title}}", "{{wage}}", "{{hours_text}}", "{{age_text}}", "{{welfare}}", "{{place}}", "{{window}}"],
    },
    {
      key: "ask_interview",
      label: "问面试意向",
      when: "岗位信息发完之后，问一句「这两天能不能来面试」。整场只用一次。",
      fallback: "没填时：用内置的三句轮换说法追问，避免同一句连发三遍。",
      tokens: ["{{factory}}", "{{place}}", "{{window}}"],
    },
    {
      key: "collect",
      label: "要姓名电话",
      when: "客户答应来面试、需要登记姓名和手机号时。",
      fallback: "那我登记一下：麻烦把姓名和手机号一起发我。",
      tokens: ["{{missing}}", "{{factory}}", "{{place}}"],
    },
    {
      key: "booked",
      label: "面试确认",
      when: "资料齐了、面试时间定下来之后发的确认（面试地点和时段在这里）。",
      fallback: "没填时：代码按「姓名 + 电话 + 面试地点 + 面试时段」自动拼确认语。",
      tokens: ["{{factory}}", "{{place}}", "{{window}}", "{{wage}}"],
    },
    {
      key: "gave_up",
      label: "不去了的收尾",
      when: "客户明确说不来面试时，回一句收尾，之后不再追问。",
      fallback: "好的，那就不打扰你了。后面想过来的话随时找我，名额一直有。",
      tokens: ["{{factory}}"],
    },
    {
      key: "reopen",
      label: "流失客户回来了",
      when: "标记过流失的客户又主动发消息时，用这句重新接待。整场只用一次。",
      fallback: "在的，{工厂名}那边随时可以了解。你是想再看看岗位，还是安排面试？",
      tokens: ["{{factory}}", "{{city}}"],
    },
    {
      key: "closing",
      label: "流失后再来（收尾）",
      when: "回流机会用完、客户再发消息时，只回这一句，不再邀约。",
      fallback: "好的，那就不打扰你了。后面想了解哪个城市的岗位，随时跟我说哈。",
      tokens: ["{{factory}}", "{{city}}"],
    },
  ];

  // 占位符：发送前由客户端按岗位/流程数据替换。键名与后端 render_script 的 mapping 一致，
  // 不在表里的 {{x}} 会被清空（绝不把花括号发给客户）。
  const PLACEHOLDERS = [
    { token: "{{factory}}", label: "工厂名" },
    { token: "{{job_title}}", label: "岗位名" },
    { token: "{{wage}}", label: "工资" },
    { token: "{{hours_text}}", label: "工时" },
    { token: "{{age_text}}", label: "年龄要求" },
    { token: "{{welfare}}", label: "福利" },
    { token: "{{place}}", label: "面试地点" },
    { token: "{{window}}", label: "面试时段" },
    { token: "{{cities}}", label: "在招城市" },
    { token: "{{missing}}", label: "还缺的资料" },
  ];

  /** 这一步最常用的占位符排在前面，其余照常可用（后端全部认识）。 */
  function placeholdersFor(stage) {
    const preferred = (stage && stage.tokens) || [];
    const first = PLACEHOLDERS.filter((item) => preferred.includes(item.token));
    const rest = PLACEHOLDERS.filter((item) => !preferred.includes(item.token));
    return [...first, ...rest];
  }

  // 与后端 MEDIA_MAX_BYTES 对齐：base64 走 JSON 会放大 1/3，前端先拦掉明显超限的文件，
  // 免得上传几分钟最后被 413 打回。
  const MAX_BYTES = 20 * 1024 * 1024;

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
    if (!response.ok) {
      const error = new Error(body.detail || `HTTP ${response.status}`);
      error.status = response.status; // 调用方靠它区分「没权限」和「网络挂了」
      throw error;
    }
    return body;
  }

  // ── 样式：沿用后台现有的浅描边 / Element 蓝与 4000 层抽屉，不引入新的视觉语言 ──
  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .rk-ps-line{display:flex;align-items:center;gap:8px;margin-top:4px;min-width:0}
      .rk-ps-btn{flex:0 0 auto;height:22px;padding:0 10px;border:1px solid var(--rk-border-strong);border-radius:999px;background:var(--rk-bg);color:var(--rk-accent);cursor:pointer;font:inherit;font-size:12px;line-height:20px}
      .rk-ps-btn:hover{border-color:var(--rk-accent);background:var(--rk-accent-soft)}
      .rk-ps-mask{position:fixed;inset:0;z-index:4000;display:flex;justify-content:flex-end;background:rgba(18,28,52,.26);backdrop-filter:blur(6px) saturate(1.2);-webkit-backdrop-filter:blur(6px) saturate(1.2)}
      .rk-ps-panel{display:flex;flex-direction:column;width:min(760px,100%);height:100%;border:1px solid var(--gl-edge);border-radius:var(--gl-r-shell) 0 0 var(--gl-r-shell);background:linear-gradient(180deg,rgba(255,255,255,.94),rgba(250,252,255,.86));backdrop-filter:var(--gl-blur);-webkit-backdrop-filter:var(--gl-blur);box-shadow:var(--gl-shadow-float)}
      .rk-ps-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--rk-border)}
      .rk-ps-head h2{margin:0;font-size:17px;font-weight:600;color:var(--rk-ink-1)}
      .rk-ps-head p{margin:4px 0 0;font-size:12px;color:var(--rk-ink-3)}
      .rk-ps-close{width:30px;height:30px;border:0;background:transparent;color:var(--rk-ink-2);font-size:20px;cursor:pointer;border-radius:999px}
      .rk-ps-close:hover{background:rgba(31,41,64,.06)}
      .rk-ps-tabs{display:flex;gap:2px;padding:0 20px;border-bottom:1px solid var(--rk-border);overflow-x:auto}
      .rk-ps-tab{position:relative;flex:0 0 auto;padding:10px 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--rk-ink-2);cursor:pointer;font:inherit;font-size:13px;white-space:nowrap}
      .rk-ps-tab:hover{color:var(--rk-accent)}
      .rk-ps-tab.is-active{border-bottom-color:var(--rk-accent);color:var(--rk-accent);font-weight:600}
      .rk-ps-dot{display:inline-block;width:5px;height:5px;margin-left:5px;border-radius:50%;background:var(--rk-up);vertical-align:middle}
      .rk-ps-body{flex:1;overflow:auto;padding:14px 20px 20px}
      .rk-ps-stage{margin:0 0 10px;font-size:12px;color:var(--rk-ink-3)}
      .rk-ps-ph{border:1px solid var(--rk-border);border-radius:var(--gl-r-control);background:var(--rk-panel-2);padding:9px 10px}
      .rk-ps-ph-title{margin:0 0 6px;font-size:12px;color:var(--rk-ink-3)}
      .rk-ps-ph-list{display:flex;flex-wrap:wrap;gap:6px}
      .rk-ps-ph-list button{height:24px;padding:0 10px;border:1px dashed var(--rk-border-strong);border-radius:999px;background:var(--rk-bg);color:var(--rk-ink-2);cursor:pointer;font:inherit;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace}
      .rk-ps-ph-list button:hover{border-color:var(--rk-accent);color:var(--rk-accent)}
      .rk-ps-ph-list button em{margin-left:4px;font-style:normal;color:var(--rk-ink-3);font-family:inherit}
      .rk-ps-field{margin-top:12px}
      .rk-ps-field > label{display:block;margin-bottom:5px;font-size:13px;color:var(--rk-ink-1)}
      .rk-ps-field > label small{margin-left:6px;color:var(--rk-ink-3);font-size:12px}
      .rk-ps-input,.rk-ps-area{width:100%;box-sizing:border-box;padding:7px 11px;border:1px solid var(--rk-border-strong);border-radius:var(--gl-r-control);color:var(--rk-ink-1);font:inherit;font-size:13px;line-height:1.6;background:var(--rk-bg)}
      .rk-ps-input:focus,.rk-ps-area:focus{outline:0;border-color:var(--rk-accent);box-shadow:0 0 0 3px var(--rk-accent-soft)}
      .rk-ps-area{min-height:200px;resize:vertical;white-space:pre-wrap}
      .rk-ps-input[disabled],.rk-ps-area[disabled]{background:var(--rk-panel-2);color:var(--rk-ink-3)}
      .rk-ps-media{margin-top:12px}
      .rk-ps-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      .rk-ps-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 6px 3px 10px;border:1px solid var(--rk-border);border-radius:999px;background:var(--rk-panel-2);font-size:12px;color:var(--rk-ink-2)}
      .rk-ps-chip b{font-weight:600;color:var(--rk-ink-3)}
      .rk-ps-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
      .rk-ps-chip button{width:16px;height:16px;border:0;border-radius:50%;background:transparent;color:var(--rk-ink-3);cursor:pointer;font-size:13px;line-height:1}
      .rk-ps-chip button:hover{background:var(--rk-down);color:#fff}
      .rk-ps-empty{font-size:12px;color:var(--rk-ink-3)}
      .rk-ps-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .rk-ps-tools button,.rk-ps-tools select{min-height:30px;padding:0 12px;border:1px solid var(--rk-border-strong);border-radius:999px;background:var(--rk-bg);color:var(--rk-ink-1);cursor:pointer;font:inherit;font-size:12px}
      .rk-ps-tools button:hover{border-color:var(--rk-accent);color:var(--rk-accent)}
      .rk-ps-tools button[disabled]{opacity:.6;cursor:not-allowed}
      .rk-ps-tools select{max-width:260px}
      .rk-ps-progress{font-size:12px;color:var(--rk-accent)}
      .rk-ps-error{margin:10px 0 0;color:var(--rk-down);font-size:13px}
      .rk-ps-note{margin:12px 0 0;padding:8px 10px;border-left:2px solid var(--rk-border-strong);background:var(--rk-panel-2);color:var(--rk-ink-3);font-size:12px;line-height:1.65}
      .rk-ps-welcome-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0;font-size:12px;color:var(--rk-ink-3)}
      .rk-ps-preview{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;border:1px solid var(--rk-border);border-radius:8px;margin:8px 0;color:var(--rk-ink-1)}
      .rk-ps-loading{padding:40px 0;text-align:center;color:var(--rk-ink-3);font-size:13px}
      .rk-ps-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--rk-border)}
      .rk-ps-foot button{min-height:32px;padding:0 16px;border:1px solid var(--rk-border-strong);border-radius:999px;background:var(--rk-bg);color:var(--rk-ink-1);cursor:pointer;font:inherit;font-size:13px}
      .rk-ps-foot button:hover{border-color:var(--rk-accent);color:var(--rk-accent)}
      .rk-ps-foot button.primary{border:0;background:var(--rk-grad-primary);color:#fff;font-weight:600}
      .rk-ps-foot button.primary:hover{filter:brightness(1.05);color:#fff}
      .rk-ps-foot button.primary[disabled]{opacity:.6;cursor:not-allowed}
      .rk-ps-toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
      .rk-ps-toast{max-width:360px;padding:9px 14px;border-radius:var(--gl-r-control);background:rgba(23,28,38,.92);color:#fff;font-size:13px;line-height:1.45;box-shadow:var(--gl-shadow-float);transition:opacity .2s ease;word-break:break-word}
      .rk-ps-toast.is-error{background:rgba(190,38,38,.95)}
    `;
    document.head.append(style);
  }

  // realtime.js 里的 toast 没挂到 window 上，跨脚本拿不到，自带一份（与 device-factories.js 一致）。
  function toast(text, tone) {
    if (!document.body) return;
    let host = document.querySelector(".rk-ps-toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "rk-ps-toasts";
      document.body.append(host);
    }
    const box = document.createElement("div");
    box.className = `rk-ps-toast${tone === "error" ? " is-error" : ""}`;
    box.setAttribute("role", "status");
    box.textContent = text;
    host.append(box);
    setTimeout(() => {
      box.style.opacity = "0";
      setTimeout(() => box.remove(), 220);
    }, 2600);
  }

  // ── 缓存 ──
  // 列表页一次要查几十行，不缓存会打出几十个 GET；缓存窗口内共用一份。
  let positionCache = { at: 0, items: [] };
  async function positions(force = false) {
    if (!force && positionCache.items.length && Date.now() - positionCache.at < 60_000) return positionCache.items;
    const result = await api("/api/v1/service-positions?page=1&page_size=1000");
    positionCache = { at: Date.now(), items: Array.isArray(result.items) ? result.items : [] };
    return positionCache.items;
  }

  // 不带 position_id 的 GET 返回全部话术，正好用来在按钮上显示「已配 N/9」，一条请求覆盖整页。
  let scriptCache = { at: 0, items: [], ok: false };
  async function allScripts(force = false) {
    if (!force && scriptCache.ok && Date.now() - scriptCache.at < 30_000) return scriptCache.items;
    const result = await api("/api/v1/position-scripts");
    scriptCache = { at: Date.now(), items: Array.isArray(result.items) ? result.items : [], ok: true };
    return scriptCache.items;
  }

  // 媒体库：抽屉打开时才拉，上传成功后本地补一条，不必再打一次全量。
  let mediaCache = { at: 0, items: [], ok: false };
  async function mediaLibrary(force = false) {
    if (!force && mediaCache.ok && Date.now() - mediaCache.at < 60_000) return mediaCache.items;
    const result = await api("/api/v1/media");
    mediaCache = {
      at: Date.now(),
      ok: true,
      items: (Array.isArray(result.items) ? result.items : []).map((row) => ({
        id: Number(row.id),
        name: String(row.name || ""),
        kind: String(row.kind || "image"),
        bytes: Number(row.bytes || 0),
      })),
    };
    return mediaCache.items;
  }

  const configuredStages = (positionId) => new Set(
    scriptCache.items.filter((row) => Number(row.position_id) === Number(positionId) && row.status !== "disabled").map((row) => String(row.stage)),
  );

  // ── 行 → 岗位 ──
  // 编译产物里拿不到 Vue 组件实例（生产包没有 __vueParentComponent，已 grep 确认），
  // 只能读 DOM。岗位名列里是 <span class="city-name">岗位名</span>（ServicePositionView 的 Le），
  // 用它做匹配键；同名岗位按「本页出现顺序」依次配对：同一次渲染里行顺序是稳定的，
  // 所以每次重挂结果一致，不会出现两行抢同一个 id。
  function positionOfRow(row, list, used) {
    const name = row.querySelector(".city-name")?.textContent.trim() || "";
    if (!name) return null;
    const candidates = list.filter((item) => String(item.position_name ?? "") === name);
    if (!candidates.length) return null;
    const free = candidates.find((item) => !used.has(Number(item.id)));
    return free || candidates[0];
  }

  // ── 行内入口 ──
  // 为什么挂在「岗位名称」单元格里、而不是「操作」列：
  // 操作列 min-width:200 且 fixed:"right"，里面已经排了 编辑/复制/删除 三个默认尺寸按钮，
  // 再加第四个会被 .cell 的 overflow:hidden 裁掉；名称列是 min-width 且自适应，放得下。
  function ensureLine(cell, position) {
    let line = cell.querySelector(`.rk-ps-line`);
    if (line) return line;

    line = document.createElement("div");
    line.className = "rk-ps-line";
    line.setAttribute(MARK, String(position.id));

    const button = document.createElement("button");
    button.type = "button";
    button.className = "rk-ps-btn";
    button.textContent = "话术";
    button.addEventListener("click", (event) => {
      // 名称列没有点击行为，但 el-table 的外层可能有行点击，阻止冒泡更稳。
      event.preventDefault();
      event.stopPropagation();
      const id = Number(line.getAttribute(MARK) || 0);
      const current = positionCache.items.find((item) => Number(item.id) === id) || position;
      openDrawer(current);
    });

    line.append(button);
    cell.append(line);
    return line;
  }

  function paint(line, position, configured) {
    if (line.getAttribute(MARK) !== String(position.id ?? "")) line.setAttribute(MARK, String(position.id ?? ""));
    const button = line.querySelector(".rk-ps-btn");
    if (!button) return;
    // 值没变就不碰 DOM：这个脚本自己也在 MutationObserver 的监听范围内，
    // 无条件写 textContent 会让「改文本 → 触发观察 → 再改文本」空转。
    const total = STAGES.length;
    const next = scriptCache.ok ? `话术 ${configured.size}/${total}` : "话术";
    if (button.textContent !== next) button.textContent = next;
    const title = configured.size
      ? `已配 ${configured.size} 个时点：${STAGES.filter((stage) => configured.has(stage.key)).map((stage) => stage.label).join("、")}`
      : "还没配话术：客户加好友后只会走通用话术";
    if (button.title !== title) button.title = title;
  }

  // ── 抽屉 ──
  async function openDrawer(position) {
    styles();
    if (document.querySelector(".rk-ps-mask")) return; // 只允许开一个
    const device = String(position.device_code || "");
    const general = !device && Number(position.id) === 0;
    // 企微号维度只配置「招聘介绍」这一条（device_scripts 只读 greet）；
    // 通用条目（position_id=0）现在是所有岗位的兜底文案，九个时点都能填——
    // 问城市、要资料、收尾语这些本来就没有对应岗位，只能配在通用条目上。
    const stages = device ? STAGES.filter((stage) => stage.key === "greet") : STAGES;

    const mask = document.createElement("div");
    mask.className = "rk-ps-mask";
    mask.setAttribute("role", "presentation");

    const panel = document.createElement("section");
    panel.className = "rk-ps-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "话术配置");
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
    head.className = "rk-ps-head";
    const titles = document.createElement("div");
    const h2 = document.createElement("h2");
    h2.textContent = device ? "加好友招聘介绍" : general ? "通用话术（所有岗位兜底）" : "话术与流程";
    const sub = document.createElement("p");
    sub.textContent = `${position.position_name || "岗位"}${position.store_name ? ` · ${position.store_name}` : ""}${position.city_name ? ` · ${position.city_name}` : ""}`;
    titles.append(h2, sub);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "rk-ps-close";
    x.setAttribute("aria-label", "关闭");
    x.textContent = "×";
    x.addEventListener("click", close);
    head.append(titles, x);

    const tabs = document.createElement("div");
    tabs.className = "rk-ps-tabs";
    tabs.setAttribute("role", "tablist");

    const body = document.createElement("div");
    body.className = "rk-ps-body";
    const loading = document.createElement("p");
    loading.className = "rk-ps-loading";
    loading.textContent = "正在读取话术…";
    body.append(loading);

    const foot = document.createElement("div");
    foot.className = "rk-ps-foot";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", close);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "保存";
    save.disabled = true;
    foot.append(cancel, save);

    panel.append(head, tabs, body, foot);

    // 草稿：每个时点一份。key 固定五个，服务端缺的时点就是空草稿。
    const drafts = new Map(stages.map((stage) => [stage.key, { id: 0, title: "", content: "", media: [], status: "enabled", saved: false }]));
    const dirty = new Set();
    let active = STAGES[0].key;
    let form = null; // 当前 tab 的 DOM 片段，切 tab 时整体换掉
    let progress = null;
    let error = null;

    const markDirty = (stageKey) => { dirty.add(stageKey); };

    function chipsArea() { return form?.querySelector(".rk-ps-chips"); }

    // 媒体清单渲染：名字 + 类型 + 删除。
    function renderChips() {
      const host = chipsArea();
      if (!host) return;
      const draft = drafts.get(active);
      host.replaceChildren();
      if (!draft.media.length) {
        const empty = document.createElement("span");
        empty.className = "rk-ps-empty";
        empty.textContent = "还没有挂媒体（公众号发文件要靠手机端，这里只做登记与占位符插入）";
        host.append(empty);
        return;
      }
      for (const ref of draft.media) {
        const chip = document.createElement("span");
        chip.className = "rk-ps-chip";
        const kind = document.createElement("b");
        kind.textContent = ref.kind === "video" ? "视频" : "图片";
        const name = document.createElement("span");
        name.textContent = ref.name;
        name.title = ref.name;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.setAttribute("aria-label", `移除 ${ref.name}`);
        remove.textContent = "×";
        remove.addEventListener("click", () => {
          draft.media = draft.media.filter((item) => item.name !== ref.name);
          markDirty(active);
          renderChips();
        });
        chip.append(kind, name, remove);
        host.append(chip);
      }
    }

    // 光标插入：占位符与媒体标记都走这里。setRangeText 不支持时退回字符串拼接。
    function insertAtCursor(area, snippet) {
      if (!area) return;
      const start = typeof area.selectionStart === "number" ? area.selectionStart : area.value.length;
      const end = typeof area.selectionEnd === "number" ? area.selectionEnd : area.value.length;
      if (typeof area.setRangeText === "function") {
        area.setRangeText(snippet, start, end, "end");
      } else {
        area.value = area.value.slice(0, start) + snippet + area.value.slice(end);
        area.setSelectionRange(start + snippet.length, start + snippet.length);
      }
      area.focus();
      // 让挂在上面的 input 监听把 area.value 同步回草稿，不必重复写一遍逻辑。
      area.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 挂一个媒体引用到指定时点，并把【图片:名】插到那个时点的光标处。
    // 显式传 stageKey / area：上传是异步的，用户可能在传的过程中切了 tab，
    // 这时不能把文件挂到「当前」tab 上（那是另一个时点），只能挂回发起上传的那个。
    function addMedia(ref, stageKey, area) {
      const draft = drafts.get(stageKey);
      if (!draft) return;
      if (draft.media.some((item) => item.name === ref.name)) {
        toast(`「${ref.name}」已经在清单里了`);
      } else {
        draft.media = draft.media.concat([{ name: ref.name, kind: ref.kind }]);
        markDirty(stageKey);
        if (stageKey === active) renderChips();
      }
      const marker = `【${ref.kind === "video" ? "视频" : "图片"}:${ref.name}】`;
      // 还在原来的 tab 上且输入框还挂在文档里就按光标插；否则只能追加到草稿末尾，
      // 免得把「已经切走后又改过的正文」用旧值覆盖回去。
      if (stageKey === active && area && area.isConnected) insertAtCursor(area, marker);
      else draft.content = draft.content ? `${draft.content}\n${marker}` : marker;
    }

    // FileReader 读本地文件 → POST /api/v1/media。进度分两段：读取（有百分比）+ 上传（不确定进度）。
    function pickFile(file) {
      if (!file) return;
      const isVideo = String(file.type || "").startsWith("video");
      const kind = isVideo ? "video" : "image";
      if (file.size > MAX_BYTES) {
        toast(`「${file.name}」${(file.size / 1024 / 1024).toFixed(1)}MB，超过 20MB 上限，先压缩再传`, "error");
        return;
      }
      // 媒体名必须**不带扩展名**：标记协议是【图片:名称】/【视频:名称】，
      // 客户端 find_media(name) 会自己往上拼 .jpg/.png/.mp4。以前直接传 file.name，
      // 存成「安检工作.mp4」、标记写成【视频:安检工作.mp4】，客户端拼成
      // 安检工作.mp4.jpg 找不到，于是图片视频全部静默发不出去（2026-11-17 实测）。
      // 落盘后缀由服务端按原文件的扩展名单独决定，不依赖这里的 name。
      const bare = file.name.replace(/\.[^./\\]+$/, "").trim() || file.name;
      const button = form.querySelector('[data-action="upload"]');
      const area = form.querySelector(".rk-ps-area");
      const stageKey = active; // 上传期间可能切 tab，把发起时点固定下来
      if (button) button.disabled = true;
      if (progress) progress.textContent = "读取中… 0%";

      const reader = new FileReader();
      reader.onprogress = (event) => {
        if (!progress || !event.lengthComputable) return;
        progress.textContent = `读取中… ${Math.round((event.loaded / event.total) * 100)}%`;
      };
      reader.onerror = () => {
        if (button) button.disabled = false;
        if (progress) progress.textContent = "";
        toast("读取文件失败，换一个文件试试", "error");
      };
      reader.onload = async () => {
        // data URL 前缀（data:image/png;base64,）服务端也能吃，但去掉更省流量。
        const raw = String(reader.result || "");
        const comma = raw.indexOf(",");
        const base64 = comma >= 0 ? raw.slice(comma + 1) : raw;
        if (progress) progress.textContent = "上传中…";
        try {
          const asset = await api("/api/v1/media", {
            method: "POST",
            body: JSON.stringify({ name: bare, kind, data_base64: base64 }),
          });
          mediaCache.items = mediaCache.items.filter((item) => item.name !== asset.name).concat([{
            id: Number(asset.id), name: String(asset.name), kind: String(asset.kind), bytes: Number(asset.bytes || 0),
          }]);
          mediaCache.at = Date.now();
          addMedia({ name: String(asset.name), kind: String(asset.kind) }, stageKey, area);
          toast(`已上传 ${asset.name}`);
        } catch (caught) {
          toast(`上传失败：${caught.message}`, "error");
        } finally {
          if (progress) progress.textContent = "";
          if (button) button.disabled = false;
          if (area) area.focus();
        }
      };
      reader.readAsDataURL(file);
    }

    // 单个时点的表单。切 tab 时整体重建，草稿仍在 drafts 里，所以不会丢输入。
    function buildForm() {
      const stage = stages.find((item) => item.key === active) || stages[0];
      const draft = drafts.get(stage.key);
      const fragment = document.createElement("div");

      const hint = document.createElement("p");
      hint.className = "rk-ps-stage";
      hint.textContent = device
        ? "只发给添加这个企微号的新客户。可填写工作内容、时间、福利和面试要求；请与此号绑定工厂及岗位资料保持一致。多个基地先写共通信息，客户选择后再确认具体安排。"
        : general
        ? "通用兜底：岗位自己配了同一个时点就用岗位的，没配才用这里。适合写问城市、要姓名电话、收尾这类跟具体工厂无关的话。"
        : `第 ${stages.indexOf(stage) + 1} 步 / 共 ${stages.length} 步 · ${stage.when || ""}`;
      fragment.append(hint);

      // 「不填会怎样」必须写在编辑框上面：运营要知道自己不填时客户收到的是什么，
      // 才判断得出该不该覆盖。以前这段只说「第几个时点」，等于没说。
      if (!device && stage.fallback) {
        const fallback = document.createElement("p");
        fallback.className = "rk-ps-note";
        fallback.textContent = `不填时客户收到：${stage.fallback}`;
        fragment.append(fallback);
      }

      const enabledLabel = document.createElement("label");
      enabledLabel.className = "rk-ps-stage";
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = draft.status !== "disabled";
      enabled.addEventListener("change", () => {
        draft.status = enabled.checked ? "enabled" : "disabled";
        markDirty(stage.key);
      });
      enabledLabel.append(enabled, document.createTextNode(" 启用这条话术（停用后使用其他可用话术或默认开场）"));
      fragment.append(enabledLabel);

      // 占位符条：点击插入到光标处。
      const ph = document.createElement("div");
      ph.className = "rk-ps-ph";
      const phTitle = document.createElement("p");
      phTitle.className = "rk-ps-ph-title";
      phTitle.textContent = "可用占位符（点击插入到光标处；发送前由客户端按岗位数据替换）";
      const phList = document.createElement("div");
      phList.className = "rk-ps-ph-list";
      for (const item of placeholdersFor(stage)) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = item.token;
        const label = document.createElement("em");
        label.textContent = item.label;
        button.append(label);
        button.addEventListener("click", () => insertAtCursor(fragment.querySelector(".rk-ps-area"), item.token));
        phList.append(button);
      }
      ph.append(phTitle, phList);
      if (!device) fragment.append(ph);

      const titleField = document.createElement("div");
      titleField.className = "rk-ps-field";
      const titleLabel = document.createElement("label");
      titleLabel.textContent = "标题";
      const titleSmall = document.createElement("small");
      titleSmall.textContent = "只在后台看得见，用来区分同岗位的多个版本";
      titleLabel.append(titleSmall);
      const titleInput = document.createElement("input");
      titleInput.className = "rk-ps-input";
      titleInput.type = "text";
      titleInput.placeholder = `例如：${stage.label}（默认版）`;
      titleInput.value = draft.title;
      titleInput.addEventListener("input", () => {
        draft.title = titleInput.value;
        markDirty(stage.key);
      });
      titleField.append(titleLabel, titleInput);
      fragment.append(titleField);

      const contentField = document.createElement("div");
      contentField.className = "rk-ps-field";
      const contentLabel = document.createElement("label");
      contentLabel.textContent = "正文";
      const contentSmall = document.createElement("small");
      contentSmall.textContent = stage.key === "greet" ? "普通换行仍是一条消息；单独一行 --- 分成下一条" : "原样发给客户，支持换行";
      contentLabel.append(contentSmall);
      const area = document.createElement("textarea");
      area.className = "rk-ps-area";
      area.spellcheck = false;
      area.placeholder = stage.key === "greet"
        ? "你好，欢迎咨询招聘岗位。\n---\n我先帮你了解一下。\n---\n请问你现在在哪个城市？"
        : stage.key === "ask_city"
        ? "你投递的是哪个城市的简历？我们这边{{cities}}都有厂在招。"
        : stage.key === "collect"
        ? "那我登记一下：麻烦把姓名和手机号一起发我。"
        : stage.key === "gave_up"
        ? "好的，那就不打扰你了。后面想过来的话随时找我，名额一直有。"
        : stage.key === "reopen"
        ? "在的，{{factory}}那边随时可以了解。你是想再看看岗位，还是安排面试？"
        : stage.key === "closing"
        ? "好的，那就不打扰你了。后面想了解哪个城市的岗位，随时跟我说哈。"
        : stage.fallback
        ? stage.fallback
        : "在这里写这个时点要发的话…";
      area.value = draft.content;
      area.addEventListener("input", () => {
        draft.content = area.value;
        markDirty(stage.key);
        renderPreview();
      });
      contentField.append(contentLabel, area);
      const preview = document.createElement("div");
      function renderPreview() {
        preview.replaceChildren();
        if (stage.key !== "greet") return;
        const parts = draft.content.split(/^[ \t]*---[ \t]*\r?$/m).map((part) => part.trim()).filter(Boolean);
        parts.forEach((part, index) => {
          const bubble = document.createElement("div");
          bubble.className = "rk-ps-preview";
          bubble.textContent = `第 ${index + 1} 条\n${part}`;
          preview.append(bubble);
        });
      }
      if (stage.key === "greet") {
        const tools = document.createElement("div");
        tools.className = "rk-ps-tools";
        const split = document.createElement("button");
        split.type = "button";
        split.textContent = "插入分条";
        split.addEventListener("click", () => insertAtCursor(area, "\n---\n"));
        tools.append(split);
        if (general || device) {
          const example = document.createElement("button");
          example.type = "button";
          example.textContent = "填入测试文案";
          example.addEventListener("click", () => {
            area.value = device
              ? "你好，先发你一份招聘介绍。\n---\n工作内容：以岗位安排为准（测试文案）。\n工作时间：以岗位排班为准（测试文案）。\n---\n岗位福利：以岗位说明为准（测试文案）。\n面试要求：请先了解岗位要求（测试文案）。\n---\n你在哪个城市？哪个面试基地比较方便？"
              : "你好，欢迎咨询招聘岗位。\n---\n我先帮你了解一下。\n---\n请问你现在在哪个城市？";
            area.dispatchEvent(new Event("input", { bubbles: true }));
          });
          tools.append(example);
        }
        contentField.append(tools, preview);
        renderPreview();
      }
      fragment.append(contentField);

      const mediaField = document.createElement("div");
      mediaField.className = "rk-ps-field rk-ps-media";
      const mediaLabel = document.createElement("label");
      mediaLabel.textContent = "图片 / 视频";
      const mediaSmall = document.createElement("small");
      mediaSmall.textContent = "选中的文件会写进正文的媒体标记里";
      mediaLabel.append(mediaSmall);
      const chips = document.createElement("div");
      chips.className = "rk-ps-chips";

      const tools = document.createElement("div");
      tools.className = "rk-ps-tools";

      const upload = document.createElement("button");
      upload.type = "button";
      upload.dataset.action = "upload";
      upload.textContent = "上传文件";
      const file = document.createElement("input");
      file.type = "file";
      file.accept = "image/*,video/*";
      file.style.display = "none";
      file.addEventListener("change", () => {
        const chosen = file.files && file.files[0];
        file.value = ""; // 允许连续选同一个文件再传一次
        pickFile(chosen);
      });
      upload.addEventListener("click", () => file.click());

      const select = document.createElement("select");
      select.setAttribute("aria-label", "从媒体库选择");
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "从媒体库选择…";
      select.append(placeholder);
      select.addEventListener("change", () => {
        const name = select.value;
        select.value = "";
        if (!name) return;
        const asset = mediaCache.items.find((item) => item.name === name);
        addMedia({ name, kind: asset ? asset.kind : "image" }, stage.key, area);
      });

      progress = document.createElement("span");
      progress.className = "rk-ps-progress";

      tools.append(upload, select, file, progress);
      mediaField.append(mediaLabel, chips, tools);
      mediaField.hidden = Boolean(device);
      fragment.append(mediaField);

      const note = document.createElement("p");
      note.className = "rk-ps-note";
      note.textContent = "媒体标记会以【图片:名称】【视频:名称】的形式写进正文，客户端解析后连带文件一起发；"
        + "名称不带扩展名（上传时会自动去掉，从别处复制的带 .jpg/.mp4 的标记保存时也会纠正）。"
        + "文件本体放在服务端媒体库（/api/v1/media），单文件上限 20MB。";
      note.hidden = Boolean(device);
      fragment.append(note);

      error = document.createElement("p");
      error.className = "rk-ps-error";
      fragment.append(error);

      form = fragment;
      body.replaceChildren(fragment);
      renderChips();
      // 媒体库是异步的，晚到时再补选项，不影响先编辑文字。
      if (!device) mediaLibrary().then((items) => {
        for (const item of items) {
          const option = document.createElement("option");
          option.value = item.name;
          option.textContent = `${item.kind === "video" ? "视频" : "图片"} · ${item.name}`;
          select.append(option);
        }
      }).catch(() => {
        placeholder.textContent = "媒体库读取失败";
      });
    }

    function renderTabs() {
      tabs.replaceChildren();
      for (const stage of stages) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `rk-ps-tab${stage.key === active ? " is-active" : ""}`;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(stage.key === active));
        // 序号 + 时点名：抽屉里一眼看出客户是按什么顺序收到这些话的。
        // 通用条目/企微号只有一条时点，不加序号（不是流程）。
        const index = stages.indexOf(stage);
        button.textContent = stages.length > 1 ? `${index + 1}. ${stage.label}` : stage.label;
        // 绿点 = 这个时点已经存过（不是「有改动」，是服务端有记录），方便运营一眼看出还差哪几个。
        if (drafts.get(stage.key).saved) {
          const dot = document.createElement("span");
          dot.className = "rk-ps-dot";
          dot.title = "已配置";
          button.append(dot);
        }
        button.addEventListener("click", () => {
          if (stage.key === active) return;
          active = stage.key;
          renderTabs();
          buildForm();
        });
        tabs.append(button);
      }
    }

    save.addEventListener("click", async () => {
      if (error) error.textContent = "";
      save.disabled = true;
      save.textContent = "保存中…";
      // 只提交「有改动」或「填了但还没存过」的时点：服务端是 upsert，全量 POST 也能跑，
      // 但每次保存都重写五个 updated_at 会让下发端的 version 判定一直变，没必要。
      const targets = stages.map((stage) => stage.key).filter((key) => {
        const draft = drafts.get(key);
        return dirty.has(key) || (!draft.saved && Boolean(draft.title.trim() || draft.content.trim() || draft.media.length));
      });
      if (!targets.length) {
        save.disabled = false;
        save.textContent = "保存";
        toast("还没有填写任何内容");
        return;
      }
      // 新建时正文必须非空：空正文的时点会被客户端当成「发一条空消息」。
      // 已经存过的时点允许清空（dirty 会把它带上），那是运营有意删内容。
      const blank = targets.find((key) => !drafts.get(key).saved && !drafts.get(key).content.trim());
      if (blank) {
        const stage = STAGES.find((item) => item.key === blank);
        save.disabled = false;
        save.textContent = "保存";
        toast(`「${stage ? stage.label : blank}」还没写正文`, "error");
        return;
      }
      try {
        for (const key of targets) {
          const draft = drafts.get(key);
          // 正文里手写的【图片:x】也要能挂上文件：把标记里的名字并进 media，
          // 否则客户端只会收到文字、拿不到文件。类型优先按媒体库的 kind，查不到再按扩展名猜。
          // 名字一律去扩展名（发送端按不带后缀的名字找文件）。
          const content = normalizeMarkers(draft.content);
          draft.content = content;
          const markerNames = mediaMarkers(content).map(bareMediaName);
          const media = draft.media.map((item) => ({ name: bareMediaName(item.name), kind: item.kind }));
          for (const name of markerNames) {
            if (!name || media.some((item) => item.name === name)) continue;
            const asset = mediaCache.items.find((item) => item.name === name);
            media.push({ name, kind: asset ? asset.kind : "image" });
          }
          const saved = await api(device ? "/api/v1/agent/device-scripts" : "/api/v1/position-scripts", {
            method: "POST",
            body: JSON.stringify({
              position_id: Number(position.id),
              ...(device ? { device_code: device, city: "" } : {}),
              stage: key,
              title: draft.title,
              content,
              media,
              status: draft.status,
            }),
          });
          draft.id = Number(saved.id || 0);
          draft.saved = true;
          draft.media = Array.isArray(saved.media) ? saved.media.map((item) => ({ name: String(item.name), kind: String(item.kind) })) : media;
          // 同步「全部话术」缓存，按钮上的 N/9 立刻变，不用等下一次重渲染。
          if (!device) {
            scriptCache.ok = true;
            scriptCache.at = Date.now();
            scriptCache.items = scriptCache.items
              .filter((row) => !(Number(row.position_id) === Number(position.id) && String(row.stage) === key))
              .concat([{ ...saved, position_id: Number(position.id), stage: key }]);
          }
        }
        dirty.clear();
        close();
        repaint();
        toast(`已保存：${position.position_name || "岗位"} 的话术`);
      } catch (caught) {
        if (error) error.textContent = `保存失败：${caught.message}`;
        toast(`保存失败：${caught.message}`, "error");
        save.disabled = false;
        save.textContent = "保存";
      }
    });

    try {
      const result = await api(device
        ? `/api/v1/agent/device-scripts?device_code=${encodeURIComponent(device)}&stage=greet`
        : `/api/v1/position-scripts?position_id=${encodeURIComponent(position.id)}`);
      for (const row of Array.isArray(result.items) ? result.items : []) {
        const draft = drafts.get(String(row.stage));
        if (!draft) continue; // 后端以后加了新时点：不认识就忽略，别把它写回丢掉
        draft.id = Number(row.id || 0);
        draft.title = String(row.title || "");
        draft.content = String(row.content || "");
        draft.status = row.status === "disabled" ? "disabled" : "enabled";
        draft.media = Array.isArray(row.media)
          ? row.media.map((item) => ({ name: String(item.name || ""), kind: String(item.kind === "video" ? "video" : "image") })).filter((item) => item.name)
          : [];
        draft.saved = true;
      }
      renderTabs();
      buildForm();
      save.disabled = false;
    } catch (caught) {
      loading.remove();
      const failed = document.createElement("p");
      failed.className = "rk-ps-error";
      failed.textContent = `话术读取失败：${caught.message}`;
      body.append(failed);
      toast(`话术读取失败：${caught.message}`, "error");
    }
  }

  // 正文里的【图片:a.jpg】【视频:b.mp4】→ 文件名数组。半角冒号也接受，运营手打容易用错。
  function mediaMarkers(content) {
    const names = [];
    const pattern = /【(?:图片|视频)[:：]\s*([^】]+)】/g;
    let match = pattern.exec(content);
    while (match) {
      const name = match[1].trim();
      if (name && !names.includes(name)) names.push(name);
      match = pattern.exec(content);
    }
    return names;
  }

  // 媒体名统一去掉扩展名：客户端按【图片:名称】去本地目录拼 .jpg/.png/.mp4，
  // 名字里带扩展名就永远找不到（2026-11-17 实测：【视频:安检工作.mp4】发不出去，
  // 【视频:安检工作】正常）。运营从别处复制过来的标记可能带后缀，保存时纠正，
  // 免得「页面看着都配好了、客户一条没收到」。
  const MEDIA_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|mp4|mov|m4v|webm|avi)$/i;
  const bareMediaName = (name) => String(name || "").trim().replace(MEDIA_EXT, "");
  function normalizeMarkers(content) {
    return String(content || "").replace(
      /【(图片|视频)[:：]\s*([^】]+)】/g,
      (whole, kind, name) => {
        const bare = bareMediaName(name);
        return bare ? `【${kind}:${bare}】` : whole;
      },
    );
  }

  // ── 装饰当前页 ──
  let decorating = false;
  let deviceCache = { at: 0, items: [] };

  async function decorate() {
    const devicePage = /^\/agent-devices\/?$/.test(location.pathname);
    if (!LIST_PATH.test(location.pathname) && !devicePage) {
      document.querySelector(".rk-ps-welcome-bar")?.remove();
      document.querySelector(".rk-ps-device-bar")?.remove();
      return;
    }
    if (decorating) return;
    decorating = true;
    try {
      // `.bd-table` 是岗位列表那张表（ServicePositionView 的 Te 包装 + el-table 的 class），
      // 限定在 `.dashboard` 里避免把页面上其它表格（如果有）也算进来。
      const scoped = [...document.querySelectorAll(".dashboard .bd-table .el-table__row")];
      const rows = (scoped.length ? scoped : [...document.querySelectorAll(".bd-table .el-table__row")])
        .filter((row) => !row.closest(".el-dialog"));
      if (!scriptCache.ok) {
        // 先同步拿一次全量话术：既能显示「已配 N/9」，也能判断这个账号有没有权限。
        try {
          await allScripts();
        } catch (caught) {
          // 403 = 不是管理员。话语术接口整条都是 admin-only，按钮挂上去也只会点出一片红，
          // 所以这种情况直接不注入；其它错误（断网/老后端）照常挂，点开时再报错。
          if (caught.status === 403) return;
        }
      }
      if (devicePage) {
        document.querySelector(".rk-ps-welcome-bar:not(.rk-ps-device-bar)")?.remove();
        const table = document.querySelector(".el-table");
        if (!table || document.querySelector(".rk-ps-device-bar")) return;
        if (Date.now() - deviceCache.at > 60_000) {
          const result = await api("/api/v1/agent/devices");
          deviceCache = { at: Date.now(), items: result.items || [] };
        }
        styles();
        const bar = document.createElement("div");
        bar.className = "rk-ps-welcome-bar rk-ps-device-bar";
        const select = document.createElement("select");
        select.setAttribute("aria-label", "选择企微对应的坐席设备");
        const empty = document.createElement("option");
        empty.textContent = "选择企微对应的坐席设备…";
        empty.value = "";
        select.append(empty);
        for (const item of deviceCache.items) {
          if (!item.device_code) continue;
          const option = document.createElement("option");
          option.value = String(item.device_code);
          const factories = (item.factories || []).map((factory) => factory.name || factory.factory_name).filter(Boolean).join("、");
          option.textContent = `${item.name || item.device_name || item.device_code}（${item.device_code}）${factories ? " · " + factories : ""}`;
          select.append(option);
        }
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rk-ps-btn";
        button.textContent = "加好友招聘介绍";
        button.disabled = true;
        select.addEventListener("change", () => { button.disabled = !select.value; });
        button.addEventListener("click", () => {
          const current = deviceCache.items.find((item) => String(item.device_code) === select.value);
          if (current) openDrawer({ id: 0, device_code: current.device_code,
            position_name: `${current.name || current.device_name || current.device_code}（${current.device_code}）` });
        });
        bar.append(select, button, document.createTextNode("每个企微号分别配置，首次加好友后分条发送。"));
        table.before(bar);
        return;
      }
      document.querySelector(".rk-ps-device-bar")?.remove();
      const table = document.querySelector(".dashboard .bd-table, .bd-table");
      if (table && !document.querySelector(".rk-ps-welcome-bar")) {
        styles();
        const bar = document.createElement("div");
        bar.className = "rk-ps-welcome-bar";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rk-ps-btn";
        button.textContent = "通用话术";
        button.addEventListener("click", () => openDrawer({ id: 0, position_name: "所有岗位共用的兜底话术" }));
        bar.append(button, document.createTextNode("问城市、要姓名电话、收尾语等所有岗位共用的句子都配在这里；岗位自己配了同名时点则优先用岗位的。"));
        table.before(bar);
      }
      if (!rows.length) return;
      const list = await positions();
      const used = new Set();
      for (const row of rows) {
        const position = positionOfRow(row, list, used);
        if (!position) continue;
        used.add(Number(position.id));
        // 注意不是「第一个单元格」：第一列是「主推」星标（width 55，居中），
        // 岗位名在第三列。从 .city-name 往上找它所在的 .cell，列顺序变了也能跟着走。
        const nameEl = row.querySelector(".city-name");
        const cell = nameEl ? (nameEl.closest(".cell") || nameEl.parentElement) : null;
        if (!cell) continue;
        paint(ensureLine(cell, position), position, configuredStages(position.id));
      }
    } catch {
      // 未登录 / 接口 403 / 老后端没有这个接口：一个节点都不加，页面照常可用
    } finally {
      decorating = false;
    }
  }

  // 只重画已经挂好的行内按钮，不动 DOM 结构（保存成功后立即生效，不整页刷新）。
  function repaint() {
    for (const line of document.querySelectorAll(`[${MARK}]`)) {
      const id = Number(line.getAttribute(MARK) || 0);
      const position = positionCache.items.find((item) => Number(item.id) === id);
      if (position) paint(line, position, configuredStages(id));
    }
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

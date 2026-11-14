/**
 * 岗位页「话术配置」（2026-11-14 四端契约）。
 *
 * 线上后台是编译好的 Vue 包（public/assets/），仓库里没有 .vue 源码，改不了表格列、也加不了路由。
 * 所以沿用项目已有的做法（theme/device-factories.js、city-factories.js 同一套路）在运行时补：
 *
 *   1. /service-positions（侧栏「岗位 / 工作」）每一行的岗位名下面加一行「话术 · 已配 N/5」按钮
 *   2. 点按钮开右侧抽屉：五个时点各一份 标题 + 正文，可插占位符、可挂图片/视频
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

  // 五个时点：顺序即业务顺序，key 是后端 SCRIPT_STAGES 白名单，不能改。
  const STAGES = [
    { key: "greet", label: "加好友首句", hint: "刚加好友时发，目的是引导客户说出地点" },
    { key: "send_info", label: "发岗位信息", hint: "拿到地点后发这个岗位的硬编码卡，可带图片/视频" },
    { key: "ask_interview", label: "问面试意向", hint: "岗位发完追问一句「这两天能来吗」" },
    { key: "booked", label: "面试地点", hint: "客户答应后发的固定地址与时间" },
    { key: "unanswered", label: "未回复跟进", hint: "客户没回时补一句，别一上来就催" },
  ];

  // 占位符：发送前由客户端按岗位/工厂数据替换。键名与后端迁移 030 的注释一致。
  const PLACEHOLDERS = [
    { token: "{{factory}}", label: "工厂名" },
    { token: "{{job_title}}", label: "岗位名" },
    { token: "{{wage}}", label: "工资" },
    { token: "{{hours_text}}", label: "工时" },
    { token: "{{age_text}}", label: "年龄要求" },
    { token: "{{welfare}}", label: "福利" },
  ];

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
      .rk-ps-btn{flex:0 0 auto;height:22px;padding:0 8px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#409eff;cursor:pointer;font:inherit;font-size:12px;line-height:20px}
      .rk-ps-btn:hover{border-color:#409eff;background:#ecf5ff}
      .rk-ps-mask{position:fixed;inset:0;z-index:4000;display:flex;justify-content:flex-end;background:rgba(22,26,42,.42)}
      .rk-ps-panel{display:flex;flex-direction:column;width:min(760px,100%);height:100%;background:#fff;box-shadow:-8px 0 32px rgba(0,0,0,.16)}
      .rk-ps-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid #ebeef5}
      .rk-ps-head h2{margin:0;font-size:17px;font-weight:600;color:#303133}
      .rk-ps-head p{margin:4px 0 0;font-size:12px;color:#909399}
      .rk-ps-close{width:30px;height:30px;border:0;background:transparent;color:#606266;font-size:20px;cursor:pointer}
      .rk-ps-tabs{display:flex;gap:2px;padding:0 20px;border-bottom:1px solid #ebeef5;overflow-x:auto}
      .rk-ps-tab{position:relative;flex:0 0 auto;padding:10px 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:#606266;cursor:pointer;font:inherit;font-size:13px;white-space:nowrap}
      .rk-ps-tab:hover{color:#409eff}
      .rk-ps-tab.is-active{border-bottom-color:#409eff;color:#409eff;font-weight:600}
      .rk-ps-dot{display:inline-block;width:5px;height:5px;margin-left:5px;border-radius:50%;background:#67c23a;vertical-align:middle}
      .rk-ps-body{flex:1;overflow:auto;padding:14px 20px 20px}
      .rk-ps-stage{margin:0 0 10px;font-size:12px;color:#909399}
      .rk-ps-ph{border:1px solid #e4e7ed;border-radius:6px;background:#fafbfc;padding:9px 10px}
      .rk-ps-ph-title{margin:0 0 6px;font-size:12px;color:#909399}
      .rk-ps-ph-list{display:flex;flex-wrap:wrap;gap:6px}
      .rk-ps-ph-list button{height:24px;padding:0 8px;border:1px dashed #c0c4cc;border-radius:4px;background:#fff;color:#606266;cursor:pointer;font:inherit;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace}
      .rk-ps-ph-list button:hover{border-color:#409eff;color:#409eff}
      .rk-ps-ph-list button em{margin-left:4px;font-style:normal;color:#a8abb2;font-family:inherit}
      .rk-ps-field{margin-top:12px}
      .rk-ps-field > label{display:block;margin-bottom:5px;font-size:13px;color:#303133}
      .rk-ps-field > label small{margin-left:6px;color:#a8abb2;font-size:12px}
      .rk-ps-input,.rk-ps-area{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #dcdfe6;border-radius:4px;color:#303133;font:inherit;font-size:13px;line-height:1.6;background:#fff}
      .rk-ps-input:focus,.rk-ps-area:focus{outline:0;border-color:#409eff}
      .rk-ps-area{min-height:200px;resize:vertical;white-space:pre-wrap}
      .rk-ps-input[disabled],.rk-ps-area[disabled]{background:#f5f7fa;color:#a8abb2}
      .rk-ps-media{margin-top:12px}
      .rk-ps-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      .rk-ps-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 6px 3px 8px;border:1px solid #e4e7ed;border-radius:4px;background:#f5f7fa;font-size:12px;color:#606266}
      .rk-ps-chip b{font-weight:600;color:#909399}
      .rk-ps-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
      .rk-ps-chip button{width:16px;height:16px;border:0;border-radius:2px;background:transparent;color:#909399;cursor:pointer;font-size:13px;line-height:1}
      .rk-ps-chip button:hover{background:#f56c6c;color:#fff}
      .rk-ps-empty{font-size:12px;color:#a8abb2}
      .rk-ps-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .rk-ps-tools button,.rk-ps-tools select{min-height:30px;padding:0 10px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#303133;cursor:pointer;font:inherit;font-size:12px}
      .rk-ps-tools button:hover{border-color:#409eff;color:#409eff}
      .rk-ps-tools button[disabled]{opacity:.6;cursor:not-allowed}
      .rk-ps-tools select{max-width:260px}
      .rk-ps-progress{font-size:12px;color:#409eff}
      .rk-ps-error{margin:10px 0 0;color:#c45656;font-size:13px}
      .rk-ps-note{margin:12px 0 0;padding:8px 10px;border-left:2px solid #e4e7ed;background:#fafbfc;color:#909399;font-size:12px;line-height:1.65}
      .rk-ps-loading{padding:40px 0;text-align:center;color:#909399;font-size:13px}
      .rk-ps-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid #ebeef5}
      .rk-ps-foot button{min-height:32px;padding:0 16px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#303133;cursor:pointer;font:inherit;font-size:13px}
      .rk-ps-foot button.primary{border-color:#409eff;background:#409eff;color:#fff}
      .rk-ps-foot button.primary[disabled]{opacity:.6;cursor:not-allowed}
      .rk-ps-toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
      .rk-ps-toast{max-width:360px;padding:9px 14px;border-radius:8px;background:rgba(23,28,38,.92);color:#fff;font-size:13px;line-height:1.45;box-shadow:0 8px 24px rgba(0,0,0,.18);transition:opacity .2s ease;word-break:break-word}
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

  // 不带 position_id 的 GET 返回全部话术，正好用来在按钮上显示「已配 N/5」，一条请求覆盖整页。
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
    scriptCache.items.filter((row) => Number(row.position_id) === Number(positionId)).map((row) => String(row.stage)),
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
    h2.textContent = "话术配置";
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
    const drafts = new Map(STAGES.map((stage) => [stage.key, { id: 0, title: "", content: "", media: [], saved: false }]));
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
            body: JSON.stringify({ name: file.name, kind, data_base64: base64 }),
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
      const stage = STAGES.find((item) => item.key === active) || STAGES[0];
      const draft = drafts.get(stage.key);
      const fragment = document.createElement("div");

      const hint = document.createElement("p");
      hint.className = "rk-ps-stage";
      hint.textContent = `第 ${STAGES.indexOf(stage) + 1} 个时点 / 共 5 个 · ${stage.hint}`;
      fragment.append(hint);

      // 占位符条：点击插入到光标处。
      const ph = document.createElement("div");
      ph.className = "rk-ps-ph";
      const phTitle = document.createElement("p");
      phTitle.className = "rk-ps-ph-title";
      phTitle.textContent = "可用占位符（点击插入到光标处；发送前由客户端按岗位数据替换）";
      const phList = document.createElement("div");
      phList.className = "rk-ps-ph-list";
      for (const item of PLACEHOLDERS) {
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
      fragment.append(ph);

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
      contentSmall.textContent = "原样发给客户，支持换行";
      contentLabel.append(contentSmall);
      const area = document.createElement("textarea");
      area.className = "rk-ps-area";
      area.spellcheck = false;
      area.placeholder = stage.key === "greet"
        ? "例如：你好，我是{{factory}}的招聘负责人，请问你现在在哪个区？我看看哪个厂离你近。"
        : "在这里写这个时点要发的话…";
      area.value = draft.content;
      area.addEventListener("input", () => {
        draft.content = area.value;
        markDirty(stage.key);
      });
      contentField.append(contentLabel, area);
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
      fragment.append(mediaField);

      const note = document.createElement("p");
      note.className = "rk-ps-note";
      note.textContent = "媒体标记会以【图片:文件名】【视频:文件名】的形式写进正文，客户端解析后连带文件一起发；"
        + "文件本体放在服务端媒体库（/api/v1/media），单文件上限 20MB。";
      fragment.append(note);

      error = document.createElement("p");
      error.className = "rk-ps-error";
      fragment.append(error);

      form = fragment;
      body.replaceChildren(fragment);
      renderChips();
      // 媒体库是异步的，晚到时再补选项，不影响先编辑文字。
      mediaLibrary().then((items) => {
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
      for (const stage of STAGES) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `rk-ps-tab${stage.key === active ? " is-active" : ""}`;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(stage.key === active));
        button.textContent = stage.label;
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
      const targets = STAGES.map((stage) => stage.key).filter((key) => {
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
          const markerNames = mediaMarkers(draft.content);
          const media = draft.media.slice();
          for (const name of markerNames) {
            if (media.some((item) => item.name === name)) continue;
            const asset = mediaCache.items.find((item) => item.name === name);
            media.push({ name, kind: asset ? asset.kind : (/\.(mp4|mov|m4v|webm|avi)$/i.test(name) ? "video" : "image") });
          }
          const saved = await api("/api/v1/position-scripts", {
            method: "POST",
            body: JSON.stringify({
              position_id: Number(position.id),
              stage: key,
              title: draft.title,
              content: draft.content,
              media,
              status: "enabled",
            }),
          });
          draft.id = Number(saved.id || 0);
          draft.saved = true;
          draft.media = Array.isArray(saved.media) ? saved.media.map((item) => ({ name: String(item.name), kind: String(item.kind) })) : media;
          // 同步「全部话术」缓存，按钮上的 N/5 立刻变，不用等下一次重渲染。
          scriptCache.ok = true;
          scriptCache.at = Date.now();
          scriptCache.items = scriptCache.items
            .filter((row) => !(Number(row.position_id) === Number(position.id) && String(row.stage) === key))
            .concat([{ ...saved, position_id: Number(position.id), stage: key }]);
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
      const result = await api(`/api/v1/position-scripts?position_id=${encodeURIComponent(position.id)}`);
      for (const row of Array.isArray(result.items) ? result.items : []) {
        const draft = drafts.get(String(row.stage));
        if (!draft) continue; // 后端以后加了新时点：不认识就忽略，别把它写回丢掉
        draft.id = Number(row.id || 0);
        draft.title = String(row.title || "");
        draft.content = String(row.content || "");
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

  // ── 装饰当前页 ──
  let decorating = false;

  async function decorate() {
    if (!LIST_PATH.test(location.pathname)) return;
    if (decorating) return;
    decorating = true;
    try {
      // `.bd-table` 是岗位列表那张表（ServicePositionView 的 Te 包装 + el-table 的 class），
      // 限定在 `.dashboard` 里避免把页面上其它表格（如果有）也算进来。
      const scoped = [...document.querySelectorAll(".dashboard .bd-table .el-table__row")];
      const rows = (scoped.length ? scoped : [...document.querySelectorAll(".bd-table .el-table__row")])
        .filter((row) => !row.closest(".el-dialog"));
      if (!rows.length) return;
      const list = await positions();
      if (!scriptCache.ok) {
        // 先同步拿一次全量话术：既能显示「已配 N/5」，也能判断这个账号有没有权限。
        try {
          await allScripts();
        } catch (caught) {
          // 403 = 不是管理员。话语术接口整条都是 admin-only，按钮挂上去也只会点出一片红，
          // 所以这种情况直接不注入；其它错误（断网/老后端）照常挂，点开时再报错。
          if (caught.status === 403) return;
        }
      }
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

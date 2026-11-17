/**
 * 岗位页「Agent 配置」：人设 + 开场（迁移 038）。
 *
 * 替代 position-scripts.js 的「话术」入口：那套 5 个时点的话术已经废弃。
 * 现在每个岗位只有两样东西：
 *   1. 人设 —— Agent 接手后按这份人设说话，一个岗位一份；
 *   2. 开场 —— 客户加好友后按 seq 顺序播一遍，条目可以是文本 / 图片 / 视频。
 *
 * 和旧脚本同一套路（运行时往编译好的 Vue 包里挂节点），因为仓库里没有 .vue 源码：
 *   - /service-positions 列表每行的岗位名下面挂一个「Agent」按钮；
 *   - 点开右侧抽屉，两个 Tab：人设、开场；
 *   - 开场支持增删改、上移下移、选素材、传素材。
 *
 * 接口（src/modules/agent/agent-persona.routes.ts）：
 *   GET    /api/v1/agent-persona?position_id=  → { persona, openings }
 *   GET    /api/v1/agent-persona               → { items:[{position_id,has_persona,opening_count}] }
 *   PUT    /api/v1/agent-persona               → 保存人设
 *   POST   /api/v1/agent-opening               → 追加一条
 *   PUT    /api/v1/agent-opening/:id           → 改一条
 *   DELETE /api/v1/agent-opening/:id           → 删一条
 *   POST   /api/v1/agent-opening/reorder       → 重排
 *   GET    /api/v1/media                       → 素材库
 *   POST   /api/v1/media                       → 上传素材（base64）
 */
{
  const LIST_PATH = /^\/service-positions\/?$/;
  const MARK = "data-rk-pagent";
  const STYLE_ID = "rk-pagent-style";
  const KIND_LABEL = { text: "文本", image: "图片", video: "视频" };
  // 与后端 MIN_DELAY_MS 对齐：每条至少隔 2 秒，前端先拦住，不走一次网络再报错。
  const MIN_DELAY = 2000;
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
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function el(tag, className, textContent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function toast(text, tone) {
    if (!document.body) return;
    let host = document.querySelector(".rk-pa-toasts");
    if (!host) {
      host = el("div", "rk-pa-toasts");
      document.body.append(host);
    }
    const box = el("div", `rk-pa-toast${tone === "error" ? " is-error" : ""}`, text);
    box.setAttribute("role", "status");
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
      .rk-pa-line{display:flex;align-items:center;gap:8px;margin-top:5px;min-width:0}
      .rk-pa-btn{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 11px 0 3px;border:1px solid transparent;border-radius:999px;background:var(--rk-accent-soft);cursor:pointer;font:inherit;font-size:12px;line-height:1;transition:box-shadow .18s ease,transform .18s ease,background .18s ease}
      .rk-pa-btn .rk-pa-avatar{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:20px;height:20px;border-radius:7px;background:linear-gradient(135deg,var(--rk-accent),#3b8dd8);color:#fff;font-size:11px;font-weight:700;font-style:normal}
      .rk-pa-btn .rk-pa-label{color:var(--rk-ink-1);font-weight:600;letter-spacing:.2px}
      .rk-pa-btn .rk-pa-count{display:inline-flex;align-items:center;height:17px;padding:0 7px;border-radius:999px;background:var(--rk-accent);color:#fff;font-size:11px;font-weight:600;line-height:17px}
      .rk-pa-btn .rk-pa-count i{font-style:normal;font-weight:400;margin-right:2px;font-size:10.5px;opacity:.85}
      .rk-pa-btn:hover{transform:translateY(-1px);box-shadow:0 5px 14px -5px rgba(24,95,165,.55);background:color-mix(in srgb,var(--rk-accent-soft) 78%,#fff)}
      .rk-pa-btn.is-none{background:var(--rk-panel-2);border-style:dashed;border-color:var(--rk-border-strong)}
      .rk-pa-btn.is-none .rk-pa-avatar{background:linear-gradient(135deg,#d9a441,#c98a2e)}
      .rk-pa-btn.is-none .rk-pa-label{color:var(--rk-ink-2);font-weight:500}
      .rk-pa-btn.is-none .rk-pa-count{background:var(--rk-border-strong);color:var(--rk-ink-3)}
      .rk-pa-btn.is-loading{opacity:.6;pointer-events:none}
      .rk-pa-mask{position:fixed;inset:0;z-index:4000;display:flex;justify-content:flex-end;background:rgba(18,28,52,.26);backdrop-filter:blur(6px) saturate(1.2);-webkit-backdrop-filter:blur(6px) saturate(1.2)}
      .rk-pa-panel{display:flex;flex-direction:column;width:min(760px,100%);height:100%;border:1px solid var(--gl-edge);border-radius:var(--gl-r-shell) 0 0 var(--gl-r-shell);background:linear-gradient(180deg,rgba(255,255,255,.94),rgba(250,252,255,.86));backdrop-filter:var(--gl-blur);-webkit-backdrop-filter:var(--gl-blur);box-shadow:var(--gl-shadow-float)}
      .rk-pa-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--rk-border)}
      .rk-pa-head h2{margin:0;font-size:17px;font-weight:600;color:var(--rk-ink-1)}
      .rk-pa-head p{margin:4px 0 0;font-size:12px;color:var(--rk-ink-3)}
      .rk-pa-close{width:30px;height:30px;border:0;background:transparent;color:var(--rk-ink-2);font-size:20px;cursor:pointer;border-radius:999px}
      .rk-pa-close:hover{background:rgba(31,41,64,.06)}
      .rk-pa-tabs{display:flex;gap:2px;padding:0 20px;border-bottom:1px solid var(--rk-border)}
      .rk-pa-tab{position:relative;flex:0 0 auto;padding:10px 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--rk-ink-2);cursor:pointer;font:inherit;font-size:13px}
      .rk-pa-tab:hover{color:var(--rk-accent)}
      .rk-pa-tab.is-active{border-bottom-color:var(--rk-accent);color:var(--rk-accent);font-weight:600}
      .rk-pa-body{flex:1;overflow:auto;padding:14px 20px 20px}
      .rk-pa-note{margin:0 0 12px;padding:8px 10px;border-left:2px solid var(--rk-border-strong);background:var(--rk-panel-2);color:var(--rk-ink-3);font-size:12px;line-height:1.65}
      .rk-pa-field{margin-top:12px}
      .rk-pa-field > label{display:block;margin-bottom:5px;font-size:13px;color:var(--rk-ink-1)}
      .rk-pa-field > label small{margin-left:6px;color:var(--rk-ink-3);font-size:12px}
      .rk-pa-input,.rk-pa-area{width:100%;box-sizing:border-box;padding:7px 11px;border:1px solid var(--rk-border-strong);border-radius:var(--gl-r-control);color:var(--rk-ink-1);font:inherit;font-size:13px;line-height:1.6;background:var(--rk-bg)}
      .rk-pa-input:focus,.rk-pa-area:focus{outline:0;border-color:var(--rk-accent);box-shadow:0 0 0 3px var(--rk-accent-soft)}
      .rk-pa-area{min-height:260px;resize:vertical;white-space:pre-wrap}
      .rk-pa-card{margin-bottom:8px;padding:10px 12px;border:1px solid var(--rk-border);border-radius:var(--gl-r-control);background:var(--rk-panel-2)}
      .rk-pa-card.is-editing{border-color:var(--rk-accent);background:var(--rk-bg)}
      .rk-pa-card-head{display:flex;align-items:flex-start;gap:8px}
      .rk-pa-seq{flex:0 0 auto;min-width:22px;height:22px;border-radius:999px;background:var(--rk-accent-soft);color:var(--rk-accent);font-size:12px;font-weight:600;line-height:22px;text-align:center}
      .rk-pa-kind{flex:0 0 auto;height:22px;padding:0 8px;border-radius:999px;background:rgba(31,41,64,.06);color:var(--rk-ink-2);font-size:12px;line-height:22px}
      .rk-pa-preview{flex:1;min-width:0;font-size:13px;line-height:1.6;color:var(--rk-ink-1);word-break:break-word;white-space:pre-wrap;max-height:60px;overflow:hidden}
      .rk-pa-preview.is-media{color:var(--rk-accent);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
      .rk-pa-ops{flex:0 0 auto;display:flex;gap:4px}
      .rk-pa-ops button{width:26px;height:24px;padding:0;border:1px solid var(--rk-border);border-radius:6px;background:var(--rk-bg);color:var(--rk-ink-2);cursor:pointer;font:inherit;font-size:12px}
      .rk-pa-ops button:hover{border-color:var(--rk-accent);color:var(--rk-accent)}
      .rk-pa-ops button[disabled]{opacity:.35;cursor:not-allowed}
      .rk-pa-ops button.danger:hover{border-color:var(--rk-down);color:var(--rk-down)}
      .rk-pa-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
      .rk-pa-tools button,.rk-pa-tools select{min-height:30px;padding:0 12px;border:1px solid var(--rk-border-strong);border-radius:999px;background:var(--rk-bg);color:var(--rk-ink-1);cursor:pointer;font:inherit;font-size:12px}
      .rk-pa-tools button:hover{border-color:var(--rk-accent);color:var(--rk-accent)}
      .rk-pa-tools button[disabled]{opacity:.6;cursor:not-allowed}
      .rk-pa-tools select{max-width:260px;border-radius:var(--gl-r-control)}
      .rk-pa-empty{padding:28px 0;text-align:center;color:var(--rk-ink-3);font-size:13px}
      .rk-pa-empty b{display:block;margin-bottom:6px;color:var(--rk-ink-2);font-weight:500}
      .rk-pa-error{margin:10px 0 0;color:var(--rk-down);font-size:13px}
      .rk-pa-loading{padding:40px 0;text-align:center;color:var(--rk-ink-3);font-size:13px}
      .rk-pa-hint{font-size:12px;color:var(--rk-ink-3);line-height:1.6}
      .rk-pa-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 20px;border-top:1px solid var(--rk-border)}
      .rk-pa-foot .left{font-size:12px;color:var(--rk-ink-3)}
      .rk-pa-foot button{min-height:32px;padding:0 16px;border:1px solid var(--rk-border-strong);border-radius:999px;background:var(--rk-bg);color:var(--rk-ink-1);cursor:pointer;font:inherit;font-size:13px}
      .rk-pa-foot button:hover{border-color:var(--rk-accent);color:var(--rk-accent)}
      .rk-pa-foot button.primary{border:0;background:var(--rk-grad-primary);color:#fff;font-weight:600}
      .rk-pa-foot button.primary:hover{filter:brightness(1.05);color:#fff}
      .rk-pa-foot button.primary[disabled]{opacity:.6;cursor:not-allowed}
      .rk-pa-toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
      .rk-pa-toast{max-width:360px;padding:9px 14px;border-radius:var(--gl-r-control);background:rgba(23,28,38,.92);color:#fff;font-size:13px;line-height:1.45;box-shadow:var(--gl-shadow-float);transition:opacity .2s ease;word-break:break-word}
      .rk-pa-toast.is-error{background:rgba(190,38,38,.95)}
      .rk-pa-file{display:none}
    `;
    document.head.append(style);
  }

  // ── 缓存 ──
  let positionCache = { at: 0, items: [] };
  async function positions(force = false) {
    if (!force && positionCache.items.length && Date.now() - positionCache.at < 60_000) {
      return positionCache.items;
    }
    const result = await api("/api/v1/service-positions?page=1&page_size=1000");
    positionCache = { at: Date.now(), items: Array.isArray(result.items) ? result.items : [] };
    return positionCache.items;
  }

  let summaryCache = { at: 0, items: [], ok: false };
  async function summaries(force = false) {
    if (!force && summaryCache.ok && Date.now() - summaryCache.at < 30_000) return summaryCache.items;
    const result = await api("/api/v1/agent-persona");
    summaryCache = {
      at: Date.now(),
      ok: true,
      items: Array.isArray(result.items) ? result.items : [],
    };
    return summaryCache.items;
  }

  function summaryOf(positionId) {
    return summaryCache.items.find((row) => Number(row.position_id) === Number(positionId)) || null;
  }

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

  // ── 行 → 岗位 ──
  function positionOfRow(row, list, used) {
    const name = row.querySelector(".city-name")?.textContent.trim() || "";
    if (!name) return null;
    const candidates = list.filter((item) => String(item.position_name ?? "") === name);
    if (!candidates.length) return null;
    const free = candidates.find((item) => !used.has(Number(item.id)));
    return free || candidates[0];
  }

  function ensureLine(cell, position) {
    let line = cell.querySelector(".rk-pa-line");
    if (line) return line;
    line = el("div", "rk-pa-line");
    line.setAttribute(MARK, String(position.id));

    const button = el("button", "rk-pa-btn is-loading");
    button.type = "button";
    // 结构：渐变头像 + 「Agent」标签 + 计数胶囊（条目数），一次建好，paint 只改状态
    const avatar = el("i", "rk-pa-avatar", "A");
    const label = el("span", "rk-pa-label", "Agent");
    const count = el("span", "rk-pa-count", "");
    count.innerHTML = "<i>条</i>-";
    button.append(avatar, label, count);
    button.addEventListener("click", (event) => {
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

  function paint(line, position) {
    if (line.getAttribute(MARK) !== String(position.id ?? "")) {
      line.setAttribute(MARK, String(position.id ?? ""));
    }
    const button = line.querySelector(".rk-pa-btn");
    if (!button) return;
    const summary = summaryCache.ok ? summaryOf(position.id) : null;
    const count = summary ? Number(summary.opening_count || 0) : 0;
    const hasPersona = Boolean(summary && summary.has_persona);
    // 值没变就不碰 DOM：本脚本也在 MutationObserver 监听范围内，无条件写会空转。
    const ready = summaryCache.ok;
    const state = !ready ? "is-loading" : hasPersona ? "is-ok" : "is-none";
    if (!button.classList.contains(state) || button.dataset.count !== String(count)) {
      button.classList.remove("is-loading", "is-ok", "is-none");
      button.classList.add(state);
      button.dataset.count = String(count);
      const countEl = button.querySelector(".rk-pa-count");
      if (countEl) countEl.innerHTML = `<i>条</i>${ready ? count : "-"}`;
    }
    const title = !ready
      ? "正在读取配置…"
      : hasPersona
        ? `人设已配 · 开场 ${count} 条`
        : `还没有人设 · 开场 ${count} 条`;
    if (button.title !== title) button.title = title;
  }

  // ── 抽屉 ──
  async function openDrawer(position) {
    styles();
    if (document.querySelector(".rk-pa-mask")) return;

    const mask = el("div", "rk-pa-mask");
    const panel = el("section", "rk-pa-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Agent 配置");
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

    const head = el("div", "rk-pa-head");
    const titles = el("div");
    titles.append(el("h2", null, "Agent 配置"));
    titles.append(
      el(
        "p",
        null,
        `${position.position_name || "岗位"}${position.store_name ? ` · ${position.store_name}` : ""}${position.city_name ? ` · ${position.city_name}` : ""}`,
      ),
    );
    const x = el("button", "rk-pa-close", "×");
    x.type = "button";
    x.setAttribute("aria-label", "关闭");
    x.addEventListener("click", close);
    head.append(titles, x);

    const tabs = el("div", "rk-pa-tabs");
    const body = el("div", "rk-pa-body");
    const foot = el("div", "rk-pa-foot");
    panel.append(head, tabs, body, foot);

    const state = {
      tab: "persona",
      persona: "",
      savedPersona: "",
      personaStatus: "enabled",
      openings: [],
      editing: 0, // 正在编辑的条目 id，0 = 不在编辑
      draft: null, // 新条目草稿 {kind, content, media_name, delay_ms}
      error: "",
      loading: true,
    };

    function setTab(tab) {
      state.tab = tab;
      state.editing = 0;
      state.draft = null;
      state.error = "";
      render();
    }

    const tabButtons = [
      { key: "persona", label: "人设" },
      { key: "opening", label: "开场" },
    ].map((item) => {
      const button = el("button", "rk-pa-tab", item.label);
      button.type = "button";
      button.addEventListener("click", () => setTab(item.key));
      tabs.append(button);
      return { ...item, button };
    });

    function renderTabs() {
      for (const item of tabButtons) {
        const active = state.tab === item.key;
        item.button.classList.toggle("is-active", active);
      }
    }

    function renderFoot() {
      foot.innerHTML = "";
      const left = el("div", "left");
      if (state.tab === "opening") {
        left.textContent = `共 ${state.openings.length} 条 · 每条至少间隔 2 秒，上一条发送成功才发下一条`;
      } else {
        left.textContent = state.savedPersona ? "人设已保存" : "还没有人设";
      }
      foot.append(left);

      if (state.tab === "persona") {
        const save = el("button", "primary", "保存人设");
        save.type = "button";
        save.disabled = state.persona === state.savedPersona;
        save.addEventListener("click", async () => {
          save.disabled = true;
          try {
            const saved = await api("/api/v1/agent-persona", {
              method: "PUT",
              body: JSON.stringify({ position_id: position.id, content: state.persona }),
            });
            state.savedPersona = String(saved?.content || "");
            state.persona = state.savedPersona;
            summaryCache.ok = false;
            toast("人设已保存");
            render();
            decorate();
          } catch (error) {
            save.disabled = false;
            toast(`保存失败：${error.message}`, "error");
          }
        });
        foot.append(save);
      }
    }

    function renderPersona() {
      body.innerHTML = "";
      body.append(
        el(
          "p",
          "rk-pa-note",
          "人设决定 Agent 的身份、语气和话术边界。厂名、工价、地点、面试时间由系统自动注入，不要写在这段文字里——岗位数据一改，人设里写死的数字就会和事实对不上。",
        ),
      );

      const field = el("div", "rk-pa-field");
      const label = el("label", null, "人设正文");
      const counter = el("small", null, `${state.persona.length} 字`);
      label.append(counter);
      const area = el("textarea", "rk-pa-area");
      area.value = state.persona;
      area.placeholder = "例如：你是陈姐，在广东做工厂招工十几年……\n\n写清楚：你是谁、怎么称呼客户、能用什么语气、哪些话绝对不能说。";
      area.addEventListener("input", () => {
        state.persona = area.value;
        counter.textContent = `${state.persona.length} 字`;
        renderFoot();
      });
      field.append(label, area);
      body.append(field);
    }

    function mediaSelect(kind, selected, onChange) {
      const select = el("select", "rk-pa-input");
      const placeholder = el("option", null, `选择${KIND_LABEL[kind]}素材`);
      placeholder.value = "";
      select.append(placeholder);
      select.disabled = true;
      mediaLibrary()
        .then((items) => {
          const filtered = items.filter((item) => item.kind === kind);
          for (const item of filtered) {
            const option = el("option", null, item.name);
            option.value = item.name;
            select.append(option);
          }
          select.disabled = false;
          select.value = selected || "";
        })
        .catch(() => {
          select.disabled = false;
        });
      select.addEventListener("change", () => onChange(select.value));
      return select;
    }

    async function uploadMedia(file, kind) {
      if (file.size > MAX_BYTES) throw new Error("文件超过 20MB，请先压缩");
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      });
      const asset = await api("/api/v1/media", {
        method: "POST",
        body: JSON.stringify({ name: file.name, kind, data_base64: base64 }),
      });
      mediaCache.ok = false;
      return String(asset?.name || file.name);
    }

    function entryForm(initial, onSave, onCancel, saveLabel) {
      const wrap = el("div", "rk-pa-card is-editing");
      const kind = initial.kind;
      wrap.append(el("div", "rk-pa-hint", `${KIND_LABEL[kind]} · 第 ${initial.seq || "新"} 条`));

      const draft = {
        content: initial.content || "",
        media_name: initial.media_name || "",
        delay_ms: Number(initial.delay_ms || MIN_DELAY),
      };

      if (kind === "text") {
        const field = el("div", "rk-pa-field");
        field.append(el("label", null, "正文"));
        const area = el("textarea", "rk-pa-area");
        area.style.minHeight = "120px";
        area.value = draft.content;
        area.placeholder = "可以引用岗位字段，例如：{{factory}} 在招 {{job_title}}，工价 {{wage}}。";
        area.addEventListener("input", () => {
          draft.content = area.value;
        });
        field.append(area);
        wrap.append(field);
      } else {
        const field = el("div", "rk-pa-field");
        field.append(el("label", null, "素材"));
        const row = el("div", "rk-pa-tools");
        const select = mediaSelect(kind, draft.media_name, (value) => {
          draft.media_name = value;
        });
        select.style.flex = "1";
        const upload = el("button", null, "上传新文件");
        upload.type = "button";
        const picker = el("input", "rk-pa-file");
        picker.type = "file";
        picker.accept = kind === "image" ? "image/*" : "video/*";
        upload.addEventListener("click", () => picker.click());
        picker.addEventListener("change", async () => {
          const file = picker.files && picker.files[0];
          if (!file) return;
          upload.disabled = true;
          upload.textContent = "上传中…";
          try {
            const name = await uploadMedia(file, kind);
            draft.media_name = name;
            mediaCache.ok = false;
            await mediaLibrary(true);
            const refreshed = mediaSelect(kind, name, (value) => {
              draft.media_name = value;
            });
            refreshed.style.flex = "1";
            row.replaceChild(refreshed, select);
            toast(`已上传 ${name}`);
          } catch (error) {
            upload.disabled = false;
            upload.textContent = "上传新文件";
            toast(`上传失败：${error.message}`, "error");
          }
        });
        row.append(select, upload, picker);
        field.append(row);
        wrap.append(field);
      }

      const delayField = el("div", "rk-pa-field");
      const delayLabel = el("label", null, "发完这条等多久");
      delayLabel.append(el("small", null, "至少 2000 毫秒"));
      const delay = el("input", "rk-pa-input");
      delay.type = "number";
      delay.min = String(MIN_DELAY);
      delay.step = "500";
      delay.value = String(draft.delay_ms);
      delay.addEventListener("input", () => {
        draft.delay_ms = Math.max(MIN_DELAY, Number(delay.value) || MIN_DELAY);
      });
      delayField.append(delayLabel, delay);
      wrap.append(delayField);

      const tools = el("div", "rk-pa-tools");
      const save = el("button", null, saveLabel);
      save.type = "button";
      save.className = "primary";
      const cancel = el("button", null, "取消");
      cancel.type = "button";
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await onSave(draft);
        } catch (error) {
          save.disabled = false;
          toast(error.message, "error");
        }
      });
      cancel.addEventListener("click", onCancel);
      tools.append(save, cancel);
      wrap.append(tools);
      return wrap;
    }

    async function reloadOpenings() {
      const result = await api(`/api/v1/agent-persona?position_id=${position.id}`);
      state.openings = Array.isArray(result.openings) ? result.openings : [];
      state.persona = String(result.persona?.content || "");
      state.savedPersona = state.persona;
      state.personaStatus = String(result.persona?.status || "enabled");
    }

    async function addOpening(kind) {
      state.draft = { kind, content: "", media_name: "", delay_ms: MIN_DELAY };
      state.editing = 0;
      state.error = "";
      renderOpening();
    }

    async function saveDraft(draft) {
      if (draft.kind === "text" && !draft.content.trim()) throw new Error("正文不能为空");
      if (draft.kind !== "text" && !draft.media_name) throw new Error("请选择素材");
      await api("/api/v1/agent-opening", {
        method: "POST",
        body: JSON.stringify({
          position_id: position.id,
          kind: draft.kind,
          content: draft.content,
          media_name: draft.media_name,
          delay_ms: draft.delay_ms,
        }),
      });
      state.draft = null;
      await reloadOpenings();
      summaryCache.ok = false;
      toast("已添加");
      renderOpening();
      decorate();
    }

    async function patchOpening(id, patch) {
      await api(`/api/v1/agent-opening/${id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      state.editing = 0;
      await reloadOpenings();
      summaryCache.ok = false;
      toast("已保存");
      renderOpening();
      decorate();
    }

    async function removeOpening(id) {
      if (!window.confirm("删除这一条开场？")) return;
      await api(`/api/v1/agent-opening/${id}`, { method: "DELETE" });
      await reloadOpenings();
      summaryCache.ok = false;
      toast("已删除");
      renderOpening();
      decorate();
    }

    async function move(index, delta) {
      const ids = state.openings.map((row) => Number(row.id));
      const target = index + delta;
      if (target < 0 || target >= ids.length) return;
      const swapped = ids.slice();
      [swapped[index], swapped[target]] = [swapped[target], swapped[index]];
      await api("/api/v1/agent-opening/reorder", {
        method: "POST",
        body: JSON.stringify({ position_id: position.id, ids: swapped }),
      });
      await reloadOpenings();
      renderOpening();
    }

    function renderOpening() {
      body.innerHTML = "";
      body.append(
        el(
          "p",
          "rk-pa-note",
          "客户加好友后，按这个顺序逐条发送。每一条都必须确认发送成功，再等设定的间隔，才发下一条——不是定时器到点就发。发送失败的条目会记进日志并跳过，不会卡住整段开场。",
        ),
      );

      if (!state.openings.length && !state.draft) {
        const empty = el("div", "rk-pa-empty");
        empty.append(el("b", null, "还没有开场话术"));
        empty.append(document.createTextNode("新客户加好友后，目前只会直接进入 Agent 会话。"));
        body.append(empty);
      }

      state.openings.forEach((row, index) => {
        if (state.editing === Number(row.id)) {
          body.append(
            entryForm(
              row,
              (draft) =>
                patchOpening(Number(row.id), {
                  kind: row.kind,
                  content: draft.content,
                  media_name: draft.media_name,
                  delay_ms: draft.delay_ms,
                }),
              () => {
                state.editing = 0;
                renderOpening();
              },
              "保存这条",
            ),
          );
          return;
        }

        const card = el("div", "rk-pa-card");
        const head = el("div", "rk-pa-card-head");
        const kind = String(row.kind || "text");
        head.append(el("div", "rk-pa-seq", String(index + 1)));
        head.append(el("div", "rk-pa-kind", KIND_LABEL[kind] || kind));

        const preview = el("div", `rk-pa-preview${kind === "text" ? "" : " is-media"}`);
        if (kind === "text") {
          preview.textContent = String(row.content || "");
        } else {
          const exists = row.media_exists !== false;
          preview.textContent = `${row.media_name || "(未选素材)"}${exists ? "" : " · 文件不存在"}`;
          if (!exists) preview.style.color = "var(--rk-down)";
        }
        head.append(preview);

        const ops = el("div", "rk-pa-ops");
        const up = el("button", null, "↑");
        up.type = "button";
        up.title = "上移";
        up.disabled = index === 0;
        up.addEventListener("click", () => move(index, -1).catch((error) => toast(error.message, "error")));

        const down = el("button", null, "↓");
        down.type = "button";
        down.title = "下移";
        down.disabled = index === state.openings.length - 1;
        down.addEventListener("click", () => move(index, 1).catch((error) => toast(error.message, "error")));

        const edit = el("button", null, "✎");
        edit.type = "button";
        edit.title = "编辑";
        edit.addEventListener("click", () => {
          state.editing = Number(row.id);
          state.draft = null;
          renderOpening();
        });

        const del = el("button", "danger", "×");
        del.type = "button";
        del.title = "删除";
        del.addEventListener("click", () => removeOpening(Number(row.id)).catch((error) => toast(error.message, "error")));

        ops.append(up, down, edit, del);
        head.append(ops);
        card.append(head);
        card.append(el("div", "rk-pa-hint", `发完等 ${Math.round(Number(row.delay_ms || MIN_DELAY) / 1000)} 秒`));
        body.append(card);
      });

      if (state.draft) {
        body.append(
          entryForm(
            { ...state.draft, seq: state.openings.length + 1 },
            (draft) => saveDraft({ ...state.draft, ...draft }),
            () => {
              state.draft = null;
              renderOpening();
            },
            "添加这条",
          ),
        );
      }

      const tools = el("div", "rk-pa-tools");
      const addText = el("button", null, "＋ 添加文本");
      addText.type = "button";
      addText.addEventListener("click", () => addOpening("text"));
      const addImage = el("button", null, "＋ 添加图片");
      addImage.type = "button";
      addImage.addEventListener("click", () => addOpening("image"));
      const addVideo = el("button", null, "＋ 添加视频");
      addVideo.type = "button";
      addVideo.addEventListener("click", () => addOpening("video"));
      tools.append(addText, addImage, addVideo);
      body.append(tools);

      if (state.error) body.append(el("p", "rk-pa-error", state.error));
    }

    function render() {
      renderTabs();
      renderFoot();
      if (state.tab === "persona") renderPersona();
      else renderOpening();
    }

    // 首次加载：人设 + 开场一次取回
    body.append(el("div", "rk-pa-loading", "加载中…"));
    try {
      await reloadOpenings();
    } catch (error) {
      body.innerHTML = "";
      body.append(el("p", "rk-pa-error", `读取失败：${error.message}`));
      toast(`读取失败：${error.message}`, "error");
      return;
    }
    render();
  }

  // ── 装饰当前页 ──
  let decorating = false;

  async function decorate() {
    if (!LIST_PATH.test(location.pathname)) return;
    if (decorating) return;
    decorating = true;
    try {
      const scoped = [...document.querySelectorAll(".dashboard .bd-table .el-table__row")];
      const rows = (scoped.length ? scoped : [...document.querySelectorAll(".bd-table .el-table__row")])
        .filter((row) => !row.closest(".el-dialog"));
      if (!rows.length) return;
      const list = await positions();
      if (!summaryCache.ok) {
        try {
          await summaries();
        } catch (caught) {
          // 403 = 不是管理员：接口整条 admin-only，按钮挂上去只会点出一片红。
          if (caught.status === 403) return;
        }
      }
      const used = new Set();
      for (const row of rows) {
        const position = positionOfRow(row, list, used);
        if (!position) continue;
        used.add(Number(position.id));
        const nameEl = row.querySelector(".city-name");
        const cell = nameEl ? (nameEl.closest(".cell") || nameEl.parentElement) : null;
        if (!cell) continue;
        paint(ensureLine(cell, position), position);
      }
    } catch {
      // 未登录 / 老后端没有这个接口：一个节点都不加，页面照常可用
    } finally {
      decorating = false;
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

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else {
    schedule();
  }
}

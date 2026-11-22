/**
 * Agent 调试台（侧栏底部入口 + 全屏面板）。
 *
 * 为什么要有：人设和开场现在能在岗位页配，但「配完到底会喂给模型什么、
 * 模型又回了什么」在页面上看不见。这个面板把三件事摊开：
 *   1. 上下文：这个岗位的事实卡、人设全文、开场条目（配了什么就看到什么）；
 *   2. 对话：输入一句客户话，真实调一次 /api/v1/agent/chat，看它回什么；
 *   3. 原始 JSON：模型原文、拼好的 messages、耗时、金额校验结果。
 *
 * 「只看 prompt」开关走 dry 模式：不调模型，只回拼装好的 messages，
 * 用来确认人设和事实有没有喂对，不烧 token。
 *
 * 接口（src/modules/agent/agent-chat.routes.ts）：
 *   GET  /api/v1/agent/context?position_id=   → 人设 / 事实 / 开场 / 模型配置
 *   POST /api/v1/agent/chat                   → {position_id,text,history,dry}
 */
{
  const ENTRY_ID = "rk-agentlab-entry";
  const STYLE_ID = "rk-agentlab-style";
  const MASK_CLASS = "rk-lab-mask";
  const TOKEN_KEY = "token";

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

  async function api(method, path, body) {
    const headers = { accept: "application/json" };
    const value = token();
    if (value) headers.authorization = `Bearer ${value}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let data = null;
    if (raw) {
      try { data = JSON.parse(raw); } catch { data = { detail: raw }; }
    }
    if (!response.ok) {
      const error = new Error((data && data.detail) || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }

  function toast(text, tone) {
    let host = document.querySelector(".rk-lab-toasts");
    if (!host) {
      host = el("div", "rk-lab-toasts");
      document.body.append(host);
    }
    const box = el("div", `rk-lab-toast${tone === "error" ? " is-error" : ""}`, text);
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
      .rk-lab-entry{display:flex;align-items:center;gap:10px;width:100%;height:40px;margin-bottom:8px;padding:0 14px;border:0;border-radius:var(--gl-r-control);background:transparent;color:var(--rk-ink-2);font:inherit;font-size:13px;cursor:pointer;text-align:left}
      .rk-lab-entry:hover{background:rgba(31,41,64,.05);color:var(--rk-ink-1)}
      .rk-lab-entry-dot{width:7px;height:7px;border-radius:50%;background:var(--rk-warn, #B7791F);box-shadow:0 0 0 3px rgba(183,121,31,.16);flex-shrink:0}
      .rk-nav-collapsed .rk-lab-entry{justify-content:center;padding:0}
      .rk-nav-collapsed .rk-lab-entry-label{display:none}
      .rk-lab-mask{position:fixed;inset:0;z-index:2600;display:flex;justify-content:flex-end;background:rgba(18,28,52,.28);backdrop-filter:blur(4px)}
      .rk-lab-panel{display:flex;flex-direction:column;width:min(1080px,100%);height:100%;background:var(--rk-bg);border-left:1px solid var(--rk-border);box-shadow:-16px 0 48px -24px rgba(20,40,90,.35)}
      .rk-lab-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--rk-border)}
      .rk-lab-head h2{margin:0;font-size:16px;font-weight:600;color:var(--rk-ink-1)}
      .rk-lab-head p{margin:3px 0 0;font-size:12px;color:var(--rk-ink-3)}
      .rk-lab-head select{min-height:32px;max-width:320px;padding:0 10px;border:1px solid var(--rk-border-strong);border-radius:var(--gl-r-control);background:var(--rk-bg);color:var(--rk-ink-1);font:inherit;font-size:13px}
      .rk-lab-close{width:30px;height:30px;border:0;border-radius:999px;background:transparent;color:var(--rk-ink-2);font-size:20px;cursor:pointer}
      .rk-lab-close:hover{background:rgba(31,41,64,.06)}
      .rk-lab-body{flex:1;min-height:0;display:flex}
      .rk-lab-aside{flex:0 0 320px;overflow:auto;padding:16px 18px;border-right:1px solid var(--rk-border);background:var(--rk-panel-2)}
      .rk-lab-main{flex:1;min-width:0;display:flex;flex-direction:column}
      .rk-lab-sec{margin-bottom:18px}
      .rk-lab-sec h3{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--rk-ink-3)}
      .rk-lab-kv{display:grid;grid-template-columns:64px 1fr;gap:4px 8px;font-size:12.5px;line-height:1.55}
      .rk-lab-kv dt{color:var(--rk-ink-3)}
      .rk-lab-kv dd{margin:0;color:var(--rk-ink-1);word-break:break-word}
      .rk-lab-pre{margin:0;padding:10px;border:1px solid var(--rk-border);border-radius:var(--gl-r-control);background:var(--rk-bg);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;color:var(--rk-ink-2)}
      .rk-lab-empty{font-size:12px;color:var(--rk-ink-3)}
      .rk-lab-seq{display:flex;flex-direction:column;gap:6px}
      .rk-lab-seq-item{display:flex;gap:8px;padding:7px 9px;border:1px solid var(--rk-border);border-radius:var(--gl-r-control);background:var(--rk-bg);font-size:12px;line-height:1.5}
      .rk-lab-seq-no{flex:0 0 auto;width:20px;height:20px;border-radius:999px;background:var(--rk-accent-soft);color:var(--rk-accent);font-weight:600;text-align:center;line-height:20px}
      .rk-lab-seq-body{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap;color:var(--rk-ink-1)}
      .rk-lab-seq-body.is-media{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--rk-accent)}
      .rk-lab-thread{flex:1;min-height:0;overflow:auto;padding:18px 20px}
      .rk-lab-msg{display:flex;margin-bottom:10px}
      .rk-lab-msg.is-agent{justify-content:flex-end}
      .rk-lab-bubble{max-width:76%;padding:9px 12px;border-radius:10px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
      .rk-lab-msg.is-customer .rk-lab-bubble{background:var(--rk-bg);border:1px solid var(--rk-border)}
      .rk-lab-msg.is-agent .rk-lab-bubble{background:var(--rk-accent-soft);color:var(--rk-ink-1)}
      .rk-lab-meta{margin-top:4px;font-size:11px;color:var(--rk-ink-3);text-align:right}
      .rk-lab-raw{margin:0;padding:10px 20px;border-top:1px solid var(--rk-border);background:var(--rk-panel-2);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;color:var(--rk-ink-2)}
      .rk-lab-composer{border-top:1px solid var(--rk-border);padding:12px 16px;display:flex;gap:10px;align-items:flex-end}
      .rk-lab-input{flex:1;min-height:64px;max-height:160px;resize:vertical;padding:9px 12px;border:1px solid var(--rk-border-strong);border-radius:var(--gl-r-control);background:var(--rk-bg);color:var(--rk-ink-1);font:inherit;font-size:13px;line-height:1.6}
      .rk-lab-input:focus{outline:0;border-color:var(--rk-accent);box-shadow:0 0 0 3px var(--rk-accent-soft)}
      .rk-lab-actions{display:flex;flex-direction:column;gap:8px}
      .rk-lab-actions button{min-height:32px;padding:0 14px;border:1px solid var(--rk-border-strong);border-radius:999px;background:var(--rk-bg);color:var(--rk-ink-1);cursor:pointer;font:inherit;font-size:13px;white-space:nowrap}
      .rk-lab-actions button:hover{border-color:var(--rk-accent);color:var(--rk-accent)}
      .rk-lab-actions button.primary{border:0;background:var(--rk-grad-primary);color:#fff;font-weight:600}
      .rk-lab-actions button[disabled]{opacity:.55;cursor:not-allowed}
      .rk-lab-flag{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--rk-ink-3);padding:0 4px}
      .rk-lab-toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;gap:8px;pointer-events:none}
      .rk-lab-toast{max-width:380px;padding:9px 14px;border-radius:var(--gl-r-control);background:rgba(23,28,38,.92);color:#fff;font-size:13px;line-height:1.45}
      .rk-lab-toast.is-error{background:rgba(190,38,38,.95)}
      @media (max-width:900px){.rk-lab-aside{display:none}}
    `;
    document.head.append(style);
  }

  // ── 侧栏入口 ──
  function mountEntry() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar || document.getElementById(ENTRY_ID)) return;
    const menu = sidebar.querySelector(".sidebar-menu") || sidebar;
    const entry = el("button", "rk-lab-entry");
    entry.id = ENTRY_ID;
    entry.type = "button";
    entry.append(el("span", "rk-lab-entry-dot"));
    entry.append(el("span", "rk-lab-entry-label", "Agent 调试"));
    entry.addEventListener("click", openPanel);
    menu.append(entry);
  }

  // ── 面板 ──
  let positionsPromise = null;
  function positions() {
    if (!positionsPromise) {
      positionsPromise = api("GET", "/api/v1/service-positions?page=1&page_size=1000")
        .then((data) => (Array.isArray(data.items) ? data.items : []))
        .catch((error) => {
          positionsPromise = null;
          throw error;
        });
    }
    return positionsPromise;
  }

  async function openPanel() {
    styles();
    if (document.querySelector(`.${MASK_CLASS}`)) return;

    const mask = el("div", MASK_CLASS);
    const panel = el("section", "rk-lab-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Agent 调试台");
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

    const head = el("header", "rk-lab-head");
    const titles = el("div");
    titles.append(el("h2", null, "Agent 调试台"));
    const sub = el("p", null, "选岗位 → 看事实和人设 → 发一句话 → 看模型原始返回");
    titles.append(sub);

    const right = el("div");
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "10px";

    const select = el("select");
    select.append(el("option", null, "选择岗位"));
    select.value = "";
    const closeBtn = el("button", "rk-lab-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.addEventListener("click", close);
    right.append(select, closeBtn);
    head.append(titles, right);

    const body = el("div", "rk-lab-body");
    const aside = el("aside", "rk-lab-aside");
    const main = el("section", "rk-lab-main");
    body.append(aside, main);

    const thread = el("div", "rk-lab-thread");
    const raw = el("pre", "rk-lab-raw", "（还没有调用）");
    raw.hidden = true;

    const composer = el("div", "rk-lab-composer");
    const input = el("textarea", "rk-lab-input");
    input.placeholder = "输入一句客户会说的话，例如：多少钱一小时？";
    const actions = el("div", "rk-lab-actions");

    const dryLabel = el("label", "rk-lab-flag");
    const dry = document.createElement("input");
    dry.type = "checkbox";
    dryLabel.append(dry, document.createTextNode("只看 prompt"));

    const send = el("button", "primary", "发送");
    send.type = "button";
    const clear = el("button", null, "清空对话");
    clear.type = "button";
    actions.append(dryLabel, send, clear);
    composer.append(input, actions);

    main.append(thread, raw, composer);
    panel.append(head, body);

    const state = { positionId: 0, history: [], busy: false };

    function setRaw(label, value) {
      raw.hidden = false;
      raw.textContent = `${label}\n${JSON.stringify(value, null, 2)}`;
    }

    function bubble(role, textValue, note) {
      const row = el("div", `rk-lab-msg is-${role}`);
      const wrap = el("div");
      wrap.append(el("div", "rk-lab-bubble", textValue));
      if (note) wrap.append(el("div", "rk-lab-meta", note));
      row.append(wrap);
      thread.append(row);
      thread.scrollTop = thread.scrollHeight;
    }

    function renderAside(context) {
      aside.innerHTML = "";
      if (!context) {
        aside.append(el("p", "rk-lab-empty", "先选一个岗位。"));
        return;
      }

      const factsSec = el("div", "rk-lab-sec");
      factsSec.append(el("h3", null, "岗位事实（模型唯一允许引用的数字）"));
      const entries = Object.entries(context.facts || {});
      if (!entries.length) {
        factsSec.append(el("p", "rk-lab-empty", "这个岗位的 data_json 是空的，模型不会拿到任何工价。"));
      } else {
        const dl = el("dl", "rk-lab-kv");
        for (const [key, value] of entries) {
          dl.append(el("dt", null, key), el("dd", null, value));
        }
        factsSec.append(dl);
      }
      aside.append(factsSec);

      const personaSec = el("div", "rk-lab-sec");
      personaSec.append(el("h3", null, "人设"));
      if (String(context.persona || "").trim()) {
        personaSec.append(el("pre", "rk-lab-pre", context.persona));
      } else {
        personaSec.append(el("p", "rk-lab-empty", "还没配人设。模型只会收到一句默认的「你是招聘顾问」。"));
      }
      aside.append(personaSec);

      const openingSec = el("div", "rk-lab-sec");
      openingSec.append(el("h3", null, `开场（${(context.opening || []).length} 条）`));
      if (!(context.opening || []).length) {
        openingSec.append(el("p", "rk-lab-empty", "没有开场条目，新客户会直接进 Agent 会话。"));
      } else {
        const list = el("div", "rk-lab-seq");
        for (const item of context.opening) {
          const row = el("div", "rk-lab-seq-item");
          row.append(el("span", "rk-lab-seq-no", item.seq));
          const bodyNode = el("span", "rk-lab-seq-body");
          if (item.kind === "text") bodyNode.textContent = item.content;
          else {
            bodyNode.classList.add("is-media");
            bodyNode.textContent = `${item.kind === "video" ? "视频" : "图片"} · ${item.media_name || "(未选素材)"}`;
          }
          row.append(bodyNode);
          list.append(row);
        }
        openingSec.append(list);
      }
      aside.append(openingSec);

      const llmSec = el("div", "rk-lab-sec");
      llmSec.append(el("h3", null, "模型"));
      const configured = context.llm && context.llm.configured;
      llmSec.append(
        el("p", "rk-lab-empty", configured
          ? `${context.llm.model} · 已配置 key`
          : `${(context.llm && context.llm.model) || "deepseek-chat"} · 没配 AGENT_LLM_API_KEY，只能看 prompt`),
      );
      aside.append(llmSec);
    }

    async function loadContext(positionId) {
      state.positionId = positionId;
      state.history = [];
      thread.innerHTML = "";
      raw.hidden = true;
      raw.textContent = "";
      if (!positionId) {
        renderAside(null);
        return;
      }
      try {
        const context = await api("GET", `/api/v1/agent/context?position_id=${positionId}`);
        renderAside(context);
        if (!(context.persona || "").trim()) {
          bubble("agent", "提示：这个岗位还没配人设，模型会按默认身份说话。");
        }
        if (!Object.keys(context.facts || {}).length) {
          bubble("agent", "提示：这个岗位没有事实数据，模型不会知道工价和地点。");
        }
      } catch (error) {
        renderAside(null);
        toast(`读取上下文失败：${error.message}`, "error");
      }
    }

    select.addEventListener("change", () => {
      loadContext(Number(select.value) || 0).catch(() => {});
    });

    clear.addEventListener("click", () => {
      state.history = [];
      thread.innerHTML = "";
      raw.hidden = true;
      raw.textContent = "";
    });

    send.addEventListener("click", async () => {
      if (state.busy) return;
      const value = input.value.trim();
      if (!value) return;
      if (!state.positionId) {
        toast("先选一个岗位", "error");
        return;
      }

      state.busy = true;
      send.disabled = true;
      send.textContent = "调用中…";
      bubble("customer", value, new Date().toLocaleTimeString());
      input.value = "";

      const payload = {
        position_id: state.positionId,
        text: value,
        history: state.history.slice(),
        dry: dry.checked,
      };

      try {
        const result = await api("POST", "/api/v1/agent/chat", payload);
        setRaw(dry.checked ? "拼好的 messages（dry，未调模型）" : "接口返回", result);
        const evidence = result.evidence;
        if (evidence) {
          const facts = evidence.facts || {};
          const sources = evidence.fact_sources || {};
          const factSummary = Object.entries(facts).slice(0, 4).map(([key, value]) => {
            const source = sources[key]?.label ? `（${sources[key].label}）` : "";
            return `${key}=${value}${source}`;
          }).join("；");
          bubble("agent", `执行证据：${evidence.engine || "agent"} · ${evidence.flow?.stage || "阶段待上报"}\n${factSummary || "本轮没有可展示的岗位事实"}\ntrace_id：${result.trace_id || evidence.trace_id || "-"}`, "执行追踪");
        }

        if (result.dry) {
          bubble("agent", "dry 模式：没有调用模型，右侧原始 JSON 里是这一轮会发出去的 messages。");
        } else if (result.ok) {
          const lines = [];
          for (const item of result.reply.messages) {
            if (item.type === "text") {
              bubble("agent", item.content, `${result.model || ""} · ${result.latency_ms}ms`);
              lines.push(item.content);
            } else {
              bubble("agent", `[${item.type}] ${item.name}`, "媒体");
              lines.push(`[${item.type}] ${item.name}`);
            }
          }
          const capture = result.reply.capture;
          if (capture && (capture.name || capture.phone)) {
            bubble("agent", `capture：${capture.name || "-"} / ${capture.phone || "-"}`);
          }
          state.history.push({ role: "customer", text: value });
          state.history.push({ role: "agent", text: lines.join("\n") });
        } else {
          bubble("agent", `调用失败：${result.error || "未知原因"}`);
          toast(result.error || "调用失败", "error");
        }
      } catch (error) {
        bubble("agent", `请求失败：${error.message}`);
        toast(error.message, "error");
      } finally {
        state.busy = false;
        send.disabled = false;
        send.textContent = "发送";
      }
    });

    renderAside(null);
    try {
      const list = await positions();
      for (const item of list) {
        const option = el("option", null, `${item.position_name || "未命名"}${item.store_name ? ` · ${item.store_name}` : ""}`);
        option.value = String(item.id);
        select.append(option);
      }
      if (list.length) {
        select.value = String(list[0].id);
        await loadContext(Number(list[0].id));
      }
    } catch (error) {
      toast(`岗位列表读取失败：${error.message}`, "error");
    }
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

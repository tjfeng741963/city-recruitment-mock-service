{
  // 设备页「扫码登录」注入层（2026-11-17）。
  //
  // 背景：企微掉登录后，云端专用机把扫码窗截图推到 4222
  // （POST /bridge/devices/:code/login-qr），网页侧只需要拉取展示。
  // 之前这个能力只在 /dev 调试站有；现在注入到后台「坐席设备」页——
  // 每行设备加一枚「扫码登录」按钮，点开右侧抽屉：
  //   · 设备码 / 绑定岗位 / 在线状态
  //   · 登录二维码（渐变相框 + 扫描线动画），每 5 秒自动刷新
  //   · 扫码成功后客户端自动清图，抽屉里显示等待态
  //
  // 鉴权与后台一致：读 localStorage.token，接口 GET /agent/devices/:code/login-qr。
  // DOM 注入模式与 device-factories.js 相同：每行找设备名单元格，挂按钮，
  // MutationObserver 兜底重挂；值没变不碰 DOM，防自触发空转。

  const QR_ATTR = "data-rk-devqr";
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
    if (document.getElementById("rk-devqr-style")) return;
    const style = document.createElement("style");
    style.id = "rk-devqr-style";
    style.textContent = `
      .rk-devqr-btn{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 12px;border:1px solid var(--rk-border-strong,#c8d2e0);border-radius:999px;background:var(--rk-bg,#f5f7fb);color:var(--rk-ink-1,#1b2432);cursor:pointer;font:inherit;font-size:12px;line-height:22px;transition:border-color .15s ease,color .15s ease}
      .rk-devqr-btn:hover{border-color:var(--rk-accent,#185fa5);color:var(--rk-accent,#185fa5)}
      .rk-devqr-btn i{width:9px;height:9px;border:1.5px solid currentColor;border-radius:2px;position:relative;opacity:.85}
      .rk-devqr-mask{position:fixed;inset:0;z-index:4000;display:flex;justify-content:flex-end;background:rgba(18,28,52,.26);backdrop-filter:blur(6px) saturate(1.2);-webkit-backdrop-filter:blur(6px) saturate(1.2)}
      .rk-devqr-panel{display:flex;flex-direction:column;width:min(460px,100%);height:100%;border:1px solid var(--gl-edge,#e2e8f1);border-radius:var(--gl-r-shell,14px) 0 0 var(--gl-r-shell,14px);background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(250,252,255,.9));backdrop-filter:blur(14px) saturate(1.15);-webkit-backdrop-filter:blur(14px) saturate(1.15);box-shadow:var(--gl-shadow-float,0 24px 60px -24px rgba(20,40,90,.45))}
      .rk-devqr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--rk-border,#e2e8f1)}
      .rk-devqr-head h2{margin:0;font-size:17px;font-weight:600;color:var(--rk-ink-1,#1b2432)}
      .rk-devqr-head p{margin:4px 0 0;font-size:12px;color:var(--rk-ink-3,#93a0b3)}
      .rk-devqr-close{width:30px;height:30px;border:0;background:transparent;color:var(--rk-ink-2,#6b7688);font-size:20px;cursor:pointer;border-radius:999px}
      .rk-devqr-close:hover{background:rgba(31,41,64,.06)}
      .rk-devqr-body{flex:1;overflow:auto;padding:18px 20px}
      .rk-devqr-kv{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
      .rk-devqr-kv .kv-card{padding:11px 13px;border:1px solid var(--rk-border,#e2e8f1);border-radius:10px;background:var(--rk-panel,#fff)}
      .rk-devqr-kv .kv-card b{display:block;font-size:11px;font-weight:400;color:var(--rk-ink-3,#93a0b3);margin-bottom:4px}
      .rk-devqr-kv .kv-card span{font-size:13px;font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace}
      .rk-devqr-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 11px;border-radius:999px;font-size:11.5px;font-weight:600}
      .rk-devqr-pill.on{background:#e6f4ef;color:#0f6e56}
      .rk-devqr-pill.off{background:#fbeaea;color:#a32d2d}
      .rk-devqr-pill i{width:6px;height:6px;border-radius:50%;background:currentColor}
      .rk-devqr-pill.on i{animation:rk-devqr-pulse 1.6s ease-in-out infinite}
      @keyframes rk-devqr-pulse{0%,100%{opacity:1}50%{opacity:.3}}
      .rk-devqr-frame{position:relative;width:240px;height:240px;margin:0 auto;border-radius:14px;padding:10px;background:linear-gradient(135deg,#185fa5,#3b8dd8);transition:opacity .25s ease}
      .rk-devqr-frame img{width:100%;height:100%;object-fit:cover;border-radius:9px;background:#fff;display:block}
      .rk-devqr-frame .scanline{position:absolute;left:10px;right:10px;top:10px;height:3px;border-radius:999px;background:linear-gradient(90deg,transparent,#7ee2c0,#4ade80,transparent);animation:rk-devqr-scan 2.4s ease-in-out infinite;opacity:.9}
      @keyframes rk-devqr-scan{0%{top:12px}50%{top:225px}100%{top:12px}}
      .rk-devqr-wait{width:240px;height:240px;margin:0 auto;border-radius:14px;border:1.5px dashed var(--rk-border-strong,#c8d2e0);display:flex;align-items:center;justify-content:center;text-align:center;color:var(--rk-ink-3,#93a0b3);font-size:12.5px;line-height:1.7;padding:16px}
      .rk-devqr-stamp{margin-top:12px;text-align:center;font-size:11px;color:var(--rk-ink-3,#93a0b3);font-family:ui-monospace,Menlo,Consolas,monospace}
      .rk-devqr-empty{padding:40px 20px;text-align:center;color:var(--rk-ink-3,#93a0b3);font-size:13px;line-height:1.8}
      .rk-devqr-verify{margin-top:18px;padding:14px;border:1px solid var(--rk-border,#e2e8f1);border-radius:12px;background:var(--rk-panel,#fff)}
      .rk-devqr-verify input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:1px solid var(--rk-border-strong,#c8d2e0);border-radius:8px;font:inherit;font-size:14px;color:var(--rk-ink-1,#1b2432);outline:none;transition:border-color .15s ease,box-shadow .15s ease}
      .rk-devqr-verify input:focus{border-color:var(--rk-accent,#185fa5);box-shadow:0 0 0 3px rgba(24,95,165,.14)}
      .rk-devqr-verify button{width:100%;height:34px;margin-top:8px;border:0;border-radius:8px;background:linear-gradient(135deg,#185fa5,#3b8dd8);color:#fff;cursor:pointer;font:inherit;font-size:13px;font-weight:600;transition:opacity .15s ease}
      .rk-devqr-verify button:hover{opacity:.9}
      .rk-devqr-verify button:disabled{opacity:.55;cursor:default}
      .rk-devqr-verify-hint{margin:9px 0 0;font-size:11.5px;line-height:1.6;color:var(--rk-ink-3,#93a0b3)}
    `;
    document.head.append(style);
  }

  function toast(text, isError) {
    let host = document.querySelector(".rk-devqr-toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "rk-devqr-toasts";
      host.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none";
      document.body.append(host);
    }
    const t = document.createElement("div");
    t.style.cssText = "max-width:360px;padding:9px 14px;border-radius:9px;background:rgba(23,28,38,.92);color:#fff;font-size:13px;line-height:1.45";
    if (isError) t.style.background = "rgba(190,38,38,.95)";
    t.textContent = text;
    host.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ── 行内按钮 ──
  function ensureButton(cell, device) {
    const existing = cell.querySelector(`[${QR_ATTR}]`);
    if (existing) {
      // 行重渲染后闭包里的 device 可能过期，同步最新引用
      existing.setAttribute(QR_ATTR, String(device.id ?? ""));
      return existing;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rk-devqr-btn";
    btn.setAttribute(QR_ATTR, String(device.id ?? ""));
    btn.append(document.createElement("i"));
    btn.append(document.createTextNode("扫码登录"));
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPanel(device.device_code, device);
    });
    cell.append(btn);
    return btn;
  }

  // ── 抽屉 ──
  let pollTimer = null;
  let openCode = "";

  function closePanel() {
    const mask = document.querySelector(".rk-devqr-mask");
    if (mask) mask.remove();
    openCode = "";
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function openPanel(code, device) {
    closePanel();
    openCode = code;
    const mask = document.createElement("div");
    mask.className = "rk-devqr-mask";
    const panel = document.createElement("div");
    panel.className = "rk-devqr-panel";
    const head = document.createElement("div");
    head.className = "rk-devqr-head";
    const headText = document.createElement("div");
    headText.append(Object.assign(document.createElement("h2"), { textContent: "企微扫码登录" }));
    headText.append(Object.assign(document.createElement("p"), { textContent: "扫码后本机企微自动恢复登录，无需到服务器现场操作" }));
    head.append(headText);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "rk-devqr-close";
    close.textContent = "×";
    close.addEventListener("click", closePanel);
    head.append(close);
    panel.append(head);

    const body = document.createElement("div");
    body.className = "rk-devqr-body";
    body.id = "rk-devqr-body";
    panel.append(body);
    mask.append(panel);
    mask.addEventListener("click", (event) => { if (event.target === mask) closePanel(); });
    document.body.append(mask);
    document.addEventListener("keydown", function esc(event) {
      if (event.key === "Escape") { closePanel(); document.removeEventListener("keydown", esc); }
    });

    paintBody(code, device);
    pollTimer = setInterval(() => paintBody(code), 5000);
  }

  async function paintBody(code, knownDevice) {
    const body = document.getElementById("rk-devqr-body");
    if (!body || openCode !== code) return;
    try {
      const [devices, qr] = await Promise.all([
        api("GET", "/api/v1/agent/devices"),
        api("GET", `/api/v1/agent/devices/${code}/login-qr`),
      ]);
      const device = (devices.items || []).find((d) => d.device_code === code) || knownDevice || {};
      if (openCode !== code) return;

      const kv = document.createElement("div");
      kv.className = "rk-devqr-kv";
      const positionCell = Object.assign(document.createElement("div"), { className: "kv-card" });
      positionCell.append(Object.assign(document.createElement("b"), { textContent: "绑定岗位" }));
      positionCell.append(Object.assign(document.createElement("span"), { textContent: device.position_id ? `岗位 #${device.position_id}` : "未绑定" }));
      const stateCell = Object.assign(document.createElement("div"), { className: "kv-card" });
      const pill = document.createElement("span");
      pill.className = "rk-devqr-pill " + (device.online ? "on" : "off");
      pill.append(Object.assign(document.createElement("i"), {}));
      pill.append(Object.assign(document.createElement("span"), { textContent: device.online ? "在线" : "离线" }));
      stateCell.append(Object.assign(document.createElement("b"), { textContent: "设备状态" }));
      stateCell.append(pill);
      kv.append(positionCell, stateCell);

      body.innerHTML = "";
      body.append(kv);

      if (qr.available && qr.image) {
        const frame = document.createElement("div");
        frame.className = "rk-devqr-frame";
        const img = document.createElement("img");
        img.src = qr.image;
        img.alt = "企微登录二维码";
        frame.append(img);
        frame.append(Object.assign(document.createElement("div"), { className: "scanline" }));
        body.append(frame);
        body.append(Object.assign(document.createElement("div"), {
          className: "rk-devqr-stamp",
          textContent: "截图时间 " + (qr.captured_at || "") + " · 每 30 秒自动刷新",
        }));
      } else {
        const wait = document.createElement("div");
        wait.className = "rk-devqr-wait";
        wait.textContent = device.online
          ? "设备在线，没有待扫的二维码。"
          : "等待客户端推送二维码……\n服务器上的企微掉登录后 30 秒内会自动出现在这里。";
        body.append(wait);
      }

      // ── 短信验证码输入（扫码后企微可能要求）────────────────────────
      // 提交 → 设备 5 秒内取走并在企微窗口敲入。码只有几分钟时效，输了没反应
      // 多半是过期了，重新输一个即可。
      body.append(buildVerifyRow(code));
    } catch (error) {
      toast("二维码读取失败：" + error.message, true);
    }
  }

  /** 验证码输入行：扫码后企微要求短信验证码时用。 */
  function buildVerifyRow(code) {
    const row = document.createElement("div");
    row.className = "rk-devqr-verify";
    const input = Object.assign(document.createElement("input"), {
      type: "text",
      inputMode: "numeric",
      maxLength: 8,
      placeholder: "企微要求验证码时在此输入",
    });
    const submit = document.createElement("button");
    submit.type = "button";
    submit.textContent = "提交验证码";
    submit.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!/^\d{4,8}$/.test(value)) {
        toast("验证码是 4-8 位数字", true);
        return;
      }
      submit.disabled = true;
      submit.textContent = "提交中…";
      try {
        await api("POST", `/api/v1/agent/devices/${code}/verify-code`, { code: value });
        toast("验证码已下发，设备几秒内自动输入");
        input.value = "";
      } catch (error) {
        toast("提交失败：" + error.message, true);
      }
      submit.disabled = false;
      submit.textContent = "提交验证码";
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit.click();
    });
    const hint = document.createElement("p");
    hint.className = "rk-devqr-verify-hint";
    hint.textContent = "扫码后在手机上确认，如企微弹短信验证码，收到后立刻在这里输入（几分钟时效）";
    row.append(input, submit, hint);
    return row;
  }

  // ── 行定位：与 device-factories.js 同一思路，读单元格文本匹配设备码 ──
  function decorateRows(root) {
    const rows = (root || document).querySelectorAll("tbody tr");
    rows.forEach((row) => {
      const cells = [...row.querySelectorAll("td .cell")];
      let code = "";
      for (const cell of cells) {
        if (cell.querySelector(`[${QR_ATTR}]`) || cell.querySelector("[data-rk-devf]")) continue;
        const text = cell.textContent.trim();
        if (/^AG-[A-Z0-9]{6}$/.test(text)) { code = text; break; }
      }
      if (!code) return;
      const target = cells.find((cell) => cell.querySelector("[data-rk-devf]")) || cells[1];
      if (target && !target.querySelector(`[${QR_ATTR}]`)) {
        ensureButton(target, { id: 0, device_code: code });
      }
    });
  }

  function start() {
    injectStyle();
    decorateRows(document);
    new MutationObserver(() => {
      try { decorateRows(document); } catch {}
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}

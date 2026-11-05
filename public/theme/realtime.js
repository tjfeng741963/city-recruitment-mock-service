/**
 * realtime.js — 前端实时注入层（普通脚本，必须早于 /assets/index-*.js 执行）
 *
 * 目标：不改 Vue 产物，用「劫持 setInterval + 订阅 SSE」把会话页 3s/10s 的轮询
 * 变成「事件到达即刷新」。
 *
 * 设计约束：
 *   1. 只读 DOM / 只包装 window.setInterval，不碰 Vue 内部状态，也不改 bundle。
 *   2. 任何异常都吞掉：注入层坏掉最多回到原轮询节奏，绝不能让页面白屏。
 *   3. 不写全局变量（IIFE），只在 console 打统一的 [realtime] 前缀日志。
 */
(function () {
  "use strict";

  var TAG = "[realtime]";

  // ---------------------------------------------------------------- 配置 --
  // device_code 固定 pc-office-01；localStorage 里的 realtime_device_code 只是
  // 本地联调用的覆盖开关（生产不会设置）。
  var DEVICE_CODE = "pc-office-01";
  try {
    DEVICE_CODE = localStorage.getItem("realtime_device_code") || DEVICE_CODE;
  } catch (e) { /* 隐私模式禁 localStorage 时用默认值 */ }

  // Vue 侧轮询：fetchMessages 3000ms（快）、loadConversations 10000ms（慢）。
  var FAST_RANGE = [2500, 3500];
  var SLOW_RANGE = [8000, 12000];
  var FIRE_THROTTLE_MS = 300;      // 同类轮询器两次触发的最小间隔
  var BACKOFF_BASE_MS = 1000;
  var BACKOFF_MAX_MS = 30000;
  var TOAST_MS = 5000;
  var TITLE_MS = 1500;

  var DEBUG = false;
  try { DEBUG = localStorage.getItem("realtime_debug") === "1"; } catch (e) { /* ignore */ }

  function log() {
    if (!DEBUG) return;
    try { console.debug.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
  }
  function warn() {
    try { console.warn.apply(console, [TAG].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
  }
  function safe(fn, label) {
    try { return fn(); } catch (e) { warn("handler failed:", label, e && e.message); return undefined; }
  }

  // 老浏览器没有 EventSource：整体降级为纯轮询，连 setInterval 都不劫持。
  if (typeof window.EventSource !== "function") {
    log("EventSource unsupported, skip realtime layer");
    return;
  }

  // ------------------------------------------------------------ token 读取 --
  // bundle 里是 localStorage.setItem("token", access_token)，所以 key 就是 token。
  // 兼容被 JSON.stringify 包了一层的写法（"\"eyJ...\""）。
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

  // ------------------------------------------------------- setInterval 劫持 --
  var nativeSetInterval = window.setInterval;
  var nativeClearInterval = window.clearInterval;
  var fastTimers = Object.create(null);   // id -> { fn, at }
  var slowTimers = Object.create(null);
  var fastLast = 0;
  var slowLast = 0;

  function inRange(delay, range) {
    return typeof delay === "number" && isFinite(delay) && delay >= range[0] && delay <= range[1];
  }

  function remember(bucket, id, fn) {
    bucket[id] = { fn: fn, at: Date.now() };
  }

  function forget(id) {
    delete fastTimers[id];
    delete slowTimers[id];
  }

  function countOf(bucket) {
    return Object.keys(bucket).length;
  }

  if (typeof nativeSetInterval === "function") {
    window.setInterval = function (handler, delay) {
      var args = Array.prototype.slice.call(arguments, 2);
      var id = nativeSetInterval.apply(window, arguments);
      safe(function () {
        if (typeof handler !== "function") return;
        if (inRange(delay, FAST_RANGE)) {
          remember(fastTimers, id, function () { return handler.apply(window, args); });
          log("tracked fast", id, delay + "ms");
        } else if (inRange(delay, SLOW_RANGE)) {
          remember(slowTimers, id, function () { return handler.apply(window, args); });
          log("tracked slow", id, delay + "ms");
        }
      }, "setInterval track");
      return id;
    };

    window.clearInterval = function (id) {
      // 组件卸载会 clearInterval：这里同步摘除，避免回调已经失效还去刷接口。
      safe(function () { forget(id); }, "clearInterval track");
      return nativeClearInterval.apply(window, arguments);
    };
  }

  // 触发一类轮询器；同类 ≥300ms 节流，单个回调异常不影响其他回调。
  function fire(kind) {
    var now = Date.now();
    if (kind === "fast") {
      if (now - fastLast < FIRE_THROTTLE_MS) return 0;
      fastLast = now;
    } else {
      if (now - slowLast < FIRE_THROTTLE_MS) return 0;
      slowLast = now;
    }
    var bucket = kind === "fast" ? fastTimers : slowTimers;
    var ids = Object.keys(bucket);
    var fired = 0;
    for (var i = 0; i < ids.length; i += 1) {
      var entry = bucket[ids[i]];
      if (!entry) continue;
      try { entry.fn(); fired += 1; } catch (e) { log("poller " + ids[i] + " threw", e && e.message); }
    }
    log("fire", kind, fired);
    return fired;
  }

  function fireAll(reason) {
    log("refresh", reason, "fast=" + countOf(fastTimers), "slow=" + countOf(slowTimers));
    fire("fast");
    fire("slow");
  }

  // ------------------------------------------------ 页面切走时的攒批处理 --
  // 隐藏标签页里刷接口没有意义（用户看不见），把事件攒成「待刷新」，
  // 回到前台立刻补一次，效果等同「回来就是最新」。
  var pending = false;

  function hidden() {
    try { return document.visibilityState === "hidden"; } catch (e) { return false; }
  }

  function refresh(reason) {
    if (hidden()) { pending = true; log("deferred", reason); return; }
    fireAll(reason);
  }

  document.addEventListener("visibilitychange", function () {
    safe(function () {
      if (hidden() || !pending) return;
      pending = false;
      fireAll("visible-catchup");
    }, "visibilitychange");
  });

  // ------------------------------------------------------------- 提示音 --
  var audioCtx = null;

  function ensureAudio() {
    if (audioCtx) return audioCtx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try { audioCtx = new Ctx(); } catch (e) { audioCtx = null; }
    return audioCtx;
  }

  // 浏览器自动播放策略要求用户手势后才能出声，先把 ctx 建在第一次交互上。
  ["pointerdown", "keydown", "touchstart"].forEach(function (type) {
    document.addEventListener(type, function () {
      safe(function () {
        var ctx = ensureAudio();
        if (ctx && ctx.state === "suspended" && ctx.resume) ctx.resume();
      }, "audio unlock");
    }, { passive: true, capture: true });
  });

  function beep() {
    safe(function () {
      var ctx = ensureAudio();
      if (!ctx) return;
      if (ctx.state === "suspended" && ctx.resume) ctx.resume();
      var t0 = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, t0);
      osc.frequency.exponentialRampToValueAtTime(660, t0 + 0.12);
      // 音量压得很低：这是「有人在跟你说话」的提示，不是警报。
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.18);
    }, "beep");
  }

  // --------------------------------------------------------- 标题闪一下 --
  var titleTimer = 0;
  var titleBase = "";

  function flashTitle() {
    safe(function () {
      if (!titleBase) titleBase = document.title;
      document.title = "（新）" + titleBase;
      if (titleTimer) clearTimeout(titleTimer);
      titleTimer = setTimeout(function () {
        safe(function () { document.title = titleBase; }, "title restore");
      }, TITLE_MS);
    }, "flashTitle");
  }

  // -------------------------------------------------------- 角标 / toast --
  var overlay = null;

  function layer() {
    if (overlay && overlay.parentNode) return overlay;
    overlay = document.createElement("div");
    overlay.setAttribute("data-rk-realtime", "layer");
    overlay.style.cssText = [
      "position:fixed", "right:18px", "bottom:18px", "z-index:2147483000",
      "display:flex", "flex-direction:column", "align-items:flex-end", "gap:8px",
      "pointer-events:none", "font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
    ].join(";");
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  var reduceMotion = false;
  try { reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { /* ignore */ }

  function toast(text, tone) {
    safe(function () {
      var host = layer();
      var box = document.createElement("div");
      box.setAttribute("role", "status");
      box.style.cssText = [
        "max-width:340px", "padding:10px 14px", "border-radius:10px",
        "background:" + (tone === "error" ? "rgba(190,38,38,.95)" : "rgba(23,28,38,.92)"),
        "color:#fff", "font-size:13px", "line-height:1.45",
        "box-shadow:0 8px 24px rgba(0,0,0,.18)",
        "opacity:0", "transform:translateY(6px)",
        reduceMotion ? "" : "transition:opacity .22s ease,transform .22s ease",
        "word-break:break-word",
      ].filter(Boolean).join(";");
      box.textContent = text;   // textContent：错误信息可能含 < >，不拼 HTML
      host.appendChild(box);
      requestAnimationFrame(function () {
        box.style.opacity = "1";
        box.style.transform = "translateY(0)";
      });
      setTimeout(function () {
        box.style.opacity = "0";
        box.style.transform = "translateY(6px)";
        setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 260);
      }, TOAST_MS);
    }, "toast");
  }

  // device.updated 只更新角标/提示，不强制刷列表（设备上下线跟消息无关）。
  function deviceBadge(data) {
    safe(function () {
      var online = data && data.online === true;
      var state = (data && data.wecom_state) || (online ? "online" : "offline");
      toast("设备 " + ((data && data.device_code) || DEVICE_CODE) + "：" + (online ? "在线" : state === "scanning" ? "扫码中" : "离线"), online ? "info" : "error");
    }, "deviceBadge");
  }

  // ----------------------------------------------------------------- SSE --
  var source = null;
  var retryTimer = 0;
  var attempt = 0;
  var closed = false;

  function streamUrl(token) {
    return "/api/v1/agent/stream?token=" + encodeURIComponent(token) + "&device_code=" + encodeURIComponent(DEVICE_CODE);
  }

  function scheduleReconnect() {
    if (closed) return;
    if (!readToken()) { log("no token, stop reconnecting"); return; }
    var delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
    attempt += 1;
    log("reconnect in", delay, "ms (attempt", attempt + ")");
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { retryTimer = 0; connect(); }, delay);
  }

  function disconnect() {
    if (source) {
      try { source.close(); } catch (e) { /* ignore */ }
      source = null;
    }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
  }

  function connect() {
    safe(function () {
      var token = readToken();
      if (!token) { log("token missing, realtime disabled (page falls back to polling)"); return; }
      if (source) return;    // 已连着

      var es;
      try { es = new EventSource(streamUrl(token)); } catch (e) { warn("EventSource ctor failed", e && e.message); return; }
      source = es;

      es.addEventListener("ready", function (event) {
        safe(function () {
          attempt = 0;               // 连上就重置退避
          log("ready", event && event.data);
          // 断线期间可能漏事件，重连成功后补一次（间隔很久就白刷，交给节流）。
          fireAll("ready");
        }, "ready");
      });

      es.addEventListener("message.created", function (event) {
        safe(function () {
          var payload = parse(event);
          var msg = payload && payload.message;
          if (msg && msg.direction === "inbound") {
            flashTitle();
            beep();
          }
          refresh("message.created");
        }, "message.created");
      });

      es.addEventListener("command.updated", function (event) {
        safe(function () {
          var payload = parse(event);
          if (payload && payload.status === "failed") {
            toast("发送失败：" + (payload.error || "设备未确认送达"), "error");
          }
          refresh("command.updated");
        }, "command.updated");
      });

      es.addEventListener("device.updated", function (event) {
        safe(function () { deviceBadge(parse(event)); }, "device.updated");
      });

      es.onerror = function () {
        safe(function () {
          // 不 close 的话浏览器会自己立刻重连，退避就失效了：先关，再按指数退避重开。
          try { es.close(); } catch (e) { /* ignore */ }
          if (source === es) source = null;
          scheduleReconnect();
        }, "sse error");
      };
    }, "connect");
  }

  function parse(event) {
    try {
      var raw = event && event.data;
      if (!raw) return null;
      var value = JSON.parse(raw);
      return value && typeof value === "object" ? value : null;
    } catch (e) { return null; }
  }

  // ------------------------------------------------- 监听 token 出现/消失 --
  // 登录页是同一个 SPA：进页面时还没有 token，登录成功后 Vue 才 setItem。
  // 劫持一次 setItem 就能在登录后立刻接上，不用轮询 localStorage。
  safe(function () {
    var proto = window.Storage && window.Storage.prototype;
    if (!proto || !proto.setItem) return;
    var nativeSetItem = proto.setItem;
    proto.setItem = function (key, value) {
      var result = nativeSetItem.apply(this, arguments);
      if (key === "token") {
        safe(function () {
          if (value) { attempt = 0; connect(); }
          else { disconnect(); }
        }, "token hook");
      }
      return result;
    };
  }, "hook Storage.setItem");

  // 页面卸载时收尾，避免 BFCache 里挂着旧连接。
  window.addEventListener("pagehide", function () {
    closed = true;
    disconnect();
  });
  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    closed = false;
    connect();
  });

  // 切回前台时如果连接已断（比如休眠过），补一次连接。
  document.addEventListener("visibilitychange", function () {
    if (!hidden() && !source && !retryTimer) safe(connect, "visibility reconnect");
  });

  connect();
})();

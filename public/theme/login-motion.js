const FINE = matchMedia("(hover: hover) and (pointer: fine)").matches;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SVG_NS = "http://www.w3.org/2000/svg";
const SKY_W = 1600;
const SKY_H = 280;
const TWINKLE_EVERY = 9;
const BOKEH_COUNT = 7;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function skylineLayer(seed, minH, maxH, minW, maxW) {
  const rand = rng(seed);
  const blocks = [];
  let d = `M0 ${SKY_H}`;
  for (let x = 0; x < SKY_W; ) {
    const w = Math.round(minW + rand() * (maxW - minW));
    const top = SKY_H - Math.round(minH + rand() ** 1.6 * (maxH - minH));
    d += ` V${top} H${x + w}`;
    blocks.push({ x, w, top });
    x += w;
  }
  return { d: `${d} V${SKY_H} Z`, blocks };
}

function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function gradient(id, top, bottom) {
  const grad = svgEl("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(
    svgEl("stop", { offset: 0, "stop-color": top[0], "stop-opacity": top[1] }),
    svgEl("stop", { offset: 1, "stop-color": bottom[0], "stop-opacity": bottom[1] }),
  );
  return grad;
}

function windowLights(blocks) {
  const rand = rng(91);
  const group = svgEl("g", { class: "rk-sky-lights" });
  let n = 0;
  for (const b of blocks) {
    if (b.top > SKY_H - 110 || b.w < 40) continue;
    for (let y = b.top + 14; y < SKY_H - 70; y += 16) {
      for (let x = b.x + 8; x < b.x + b.w - 10; x += 12) {
        if (rand() >= 0.22) continue;
        const win = svgEl("rect", { x, y, width: 4, height: 6, rx: 1 });
        if (n++ % TWINKLE_EVERY === 0) {
          win.setAttribute("class", "rk-win-twinkle");
          win.style.animationDelay = `${(rand() * 6).toFixed(2)}s`;
        }
        group.append(win);
      }
    }
  }
  return group;
}
function buildSkyline() {
  const svg = svgEl("svg", {
    class: "rk-skyline",
    viewBox: `0 0 ${SKY_W} ${SKY_H}`,
    preserveAspectRatio: "xMidYMax slice",
    "aria-hidden": "true",
  });
  const defs = svgEl("defs", {});
  defs.append(
    gradient("rk-sky-back", ["#8fb2f4", 0.5], ["#c9d9f8", 0.15]),
    gradient("rk-sky-front", ["#ffffff", 0.9], ["#f3f6fc", 1]),
  );
  const far = skylineLayer(7, 70, 230, 34, 96);
  const near = skylineLayer(23, 26, 140, 46, 130);
  const farGroup = svgEl("g", { class: "rk-sky-far" });
  farGroup.append(svgEl("path", { d: far.d, fill: "url(#rk-sky-back)" }), windowLights(far.blocks));
  const nearGroup = svgEl("g", { class: "rk-sky-near" });
  nearGroup.append(svgEl("path", { d: near.d, fill: "url(#rk-sky-front)" }));
  svg.append(defs, farGroup, nearGroup);
  return svg;
}

function buildHero() {
  const hero = document.createElement("div");
  hero.className = "rk-login-hero";
  hero.innerHTML =
    '<p class="rk-hero-eyebrow"><span class="rk-hero-dot"></span>City Recruitment Platform</p>' +
    '<h2 class="rk-hero-title">让每一座城市的岗位<br><span class="rk-hero-grad">找到对的人</span></h2>' +
    '<p class="rk-hero-desc">城市、工厂、岗位与招聘对话，在一个控制台里统一配置与追踪。</p>' +
    '<ul class="rk-hero-tags"><li>城市配置</li><li>工厂岗位</li><li>智能对话</li><li>数据看板</li></ul>';
  return hero;
}

function decorate(bg) {
  bg.dataset.rkReady = "1";
  const bokeh = document.createElement("div");
  bokeh.className = "rk-bokeh";
  bokeh.setAttribute("aria-hidden", "true");
  for (let i = 0; i < BOKEH_COUNT; i += 1) bokeh.append(document.createElement("i"));
  const aurora = document.createElement("div");
  aurora.className = "bg-shape shape-4";
  bg.append(aurora, bokeh, buildSkyline(), buildHero());
}

function scan() {
  const bg = document.querySelector(".login-page .login-bg:not([data-rk-ready])");
  if (bg) decorate(bg);
}

scan();
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });

if (FINE && !REDUCED) {
  let frame = 0;
  window.addEventListener(
    "pointermove",
    (event) => {
      const page = document.querySelector(".login-page");
      if (!page || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        page.style.setProperty("--mx", (event.clientX / innerWidth).toFixed(3));
        page.style.setProperty("--my", (event.clientY / innerHeight).toFixed(3));
        const card = page.querySelector(".login-card");
        if (!card) return;
        const box = card.getBoundingClientRect();
        card.style.setProperty("--cx", `${event.clientX - box.left}px`);
        card.style.setProperty("--cy", `${event.clientY - box.top}px`);
      });
    },
    { passive: true },
  );
}

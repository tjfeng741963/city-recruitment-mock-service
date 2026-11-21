(function () {
  "use strict";

  const STYLE_ID = "recruitment-page-guidance-style";
  const NOTE_ATTR = "data-rk-recruitment-note";
  const HIDDEN_CITY_FIELDS = new Set([
    "招聘状态",
    "主线路（可多选/输入后回车新增）",
    "区域 / 区县（可多选/输入后回车新增）",
    "流程类型",
    "工厂模式",
    "男女住宿策略",
    "是否主推城市",
    "是否询问住宿",
    "排序",
    "面试坐标",
    "签到码",
    "联系人",
    "面试通知模板",
    "面试指引",
  ]);

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .rk-recruitment-note{margin:10px 0 14px;padding:9px 12px;border-left:3px solid var(--rk-accent,#2563eb);background:var(--rk-panel-2,#f4f7fb);color:var(--rk-ink-2,#444);font-size:12px;line-height:1.65}
      .rk-recruitment-drawer-note{margin:0 0 12px}
      .rk-import-disabled{opacity:.55!important;cursor:not-allowed!important}
    `;
    document.head.append(style);
  }

  function addNote(anchor, key, text, className = "", before = false) {
    if (!anchor || document.querySelector(`[${NOTE_ATTR}="${key}"]`)) return;
    const note = document.createElement("p");
    note.className = `rk-recruitment-note ${className}`.trim();
    note.setAttribute(NOTE_ATTR, key);
    note.textContent = text;
    if (before) anchor.parentNode.insertBefore(note, anchor);
    else anchor.after(note);
  }

  function currentPage() {
    const title = document.querySelector(".page-title");
    return title?.textContent.trim() || "";
  }

  function adjustCityPage() {
    if (location.pathname !== "/cities" || currentPage() !== "城市管理") return;
    const header = document.querySelector(".page-header");
    const description = document.querySelector(".page-desc");
    const descriptionText = "维护城市资料和新岗位默认值；现有岗位的招聘回复由岗位资料控制。";
    if (description && description.textContent !== descriptionText) description.textContent = descriptionText;
    addNote(header, "city-template", "城市里的薪资、工时、要求和面试资料只作为新岗位默认值；创建时带入一次，修改城市不会覆盖已有岗位。", "");
    for (const drawer of document.querySelectorAll(".el-drawer")) {
      if (!/^(添加|编辑|复制)城市/.test(drawer.querySelector(".el-drawer__header")?.textContent.trim() || "")) continue;
      for (const item of drawer.querySelectorAll(".el-form-item")) {
        const label = item.querySelector(".el-form-item__label")?.textContent.trim();
        if (HIDDEN_CITY_FIELDS.has(label)) item.style.display = "none";
      }
      for (const group of drawer.querySelectorAll(".el-collapse-item")) {
        const fields = [...group.querySelectorAll(".el-form-item")];
        if (fields.length && fields.every((item) => item.style.display === "none")) group.style.display = "none";
      }
    }
    for (const item of document.querySelectorAll(".el-dropdown-menu__item")) {
      if (item.textContent.trim() === "切换状态") item.style.display = "none";
    }
  }

  function adjustPositionPage() {
    if (location.pathname !== "/service-positions" || currentPage() !== "岗位管理") return;
    const header = document.querySelector(".page-header");
    const description = document.querySelector(".page-desc");
    const descriptionText = "编辑岗位招聘事实和 AI 接待配置；保存的岗位资料将进入回复与 QA。";
    if (description && description.textContent !== descriptionText) description.textContent = descriptionText;
    addNote(header, "position-facts", "岗位资料是 AI 回复依据。新岗位的空白项会带入所属城市默认值；保存后请核对岗位资料，再启用接待。", "");
    addNote(header, "position-import", "Excel 导入暂未接入岗位数据；当前导出只包含岗位索引信息。", "");
    for (const button of document.querySelectorAll("button, .el-button")) {
      if (button.textContent.trim() !== "开始导入") continue;
      button.disabled = true;
      button.classList.add("rk-import-disabled");
      button.title = "岗位导入暂不可用，文件不会写入岗位数据";
      button.setAttribute("aria-disabled", "true");
    }
  }

  function adjustDrawers() {
    for (const drawer of document.querySelectorAll(".el-drawer")) {
      const heading = drawer.querySelector(".el-drawer__header");
      const body = drawer.querySelector(".el-drawer__body");
      if (!heading || !body) continue;
      const title = heading.textContent.trim();
      if (/^(添加|编辑|复制)城市/.test(title)) {
        if (body.firstElementChild) addNote(body.firstElementChild, "city-drawer-" + title, "城市默认资料仅用于新建岗位；已有岗位的回复内容不会随城市修改。", "rk-recruitment-drawer-note", true);
      } else if (/^(添加|编辑|复制)岗位/.test(title)) {
        if (body.firstElementChild) addNote(body.firstElementChild, "position-drawer-" + title, "本页保存的岗位事实进入 Agent 回复；年龄、身高、住宿、薪资、工时、要求和面试地址会参与 dry QA。", "rk-recruitment-drawer-note", true);
        if (title === "添加岗位") bindCityTemplate(drawer);
      }
    }
  }

  function setInputValue(input, value) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function bindCityTemplate(drawer) {
    if (drawer.dataset.rkCityTemplateBound === "1") return;
    drawer.dataset.rkCityTemplateBound = "1";
    const cityItem = [...drawer.querySelectorAll(".el-form-item")].find((item) =>
      item.querySelector(".el-form-item__label")?.textContent.trim() === "所属城市",
    );
    const select = cityItem?.querySelector(".el-select__placeholder");
    const note = drawer.querySelector(`[${NOTE_ATTR}="position-drawer-添加岗位"]`);
    if (!select || !note) return;
    let lastCity = "";
    let requestId = 0;

    const applySelectedCity = async () => {
      const cityName = select.textContent.trim();
      if (!cityName || cityName === "请选择城市" || cityName === lastCity) return;
      lastCity = cityName;
      const currentRequest = ++requestId;
      const token = localStorage.getItem("cr_token") || localStorage.getItem("token") || "";
      try {
        const response = await fetch("/api/v1/cities?page=1&page_size=1000", {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || `HTTP ${response.status}`);
        if (currentRequest !== requestId || !drawer.isConnected) return;
        const city = (result.items || []).find((item) => item.city_name === cityName);
        if (!city) throw new Error("城市模板未找到");
        const salary = city.salary && typeof city.salary === "object" ? city.salary : {};
        const hours = city.work_hours && typeof city.work_hours === "object" ? city.work_hours : {};
        const requirements = city.requirements && typeof city.requirements === "object" ? city.requirements : {};
        const interview = city.interview && typeof city.interview === "object" ? city.interview : {};
        const values = [
          ["薪资详情", salary.raw],
          ["工作时间", hours.raw],
          ["招聘要求", requirements.raw],
          ["社保情况", city.social_insurances],
          ["面试时间", interview.time || interview.raw_time],
          ["面试/工作地址", interview.location || interview.raw_address || city.interview_site_name],
        ];
        let filled = 0;
        for (const [label, rawValue] of values) {
          const value = String(rawValue || "").trim();
          const item = [...drawer.querySelectorAll(".el-form-item")].find((candidate) =>
            candidate.querySelector(".el-form-item__label")?.textContent.trim() === label,
          );
          const input = item?.querySelector("input.el-input__inner, textarea.el-textarea__inner");
          if (!input) continue;
          const previous = input.dataset.rkCityTemplateValue || "";
          const current = input.value.trim();
          if (current && current !== previous) continue;
          if (!value && !previous) continue;
          setInputValue(input, value);
          input.dataset.rkCityTemplateValue = value;
          if (value) filled++;
        }
        note.textContent = filled
          ? `已从「${cityName}」带入 ${filled} 项默认资料；只填空白项，核对后保存，岗位保存后成为 AI 回复依据。`
          : `「${cityName}」没有可带入的默认资料；请填写岗位事实后保存。`;
      } catch {
        if (currentRequest === requestId && drawer.isConnected) {
          note.textContent = `「${cityName}」模板读取失败；可继续手动填写。保存时空白项仍会使用城市模板默认值，保存后请核对。`;
        }
      }
    };

    const observer = new MutationObserver(() => { void applySelectedCity(); });
    observer.observe(select, { childList: true, subtree: true, characterData: true });
    drawer.addEventListener("change", () => { void applySelectedCity(); });
  }

  function run() {
    styles();
    adjustCityPage();
    adjustPositionPage();
    adjustDrawers();
  }

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      run();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
})();

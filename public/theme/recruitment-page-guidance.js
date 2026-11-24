(function () {
  "use strict";

  const STYLE_ID = "recruitment-page-guidance-style";
  const NOTE_ATTR = "data-rk-recruitment-note";

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .rk-recruitment-note{margin:4px 0 0;color:var(--rk-ink-2,#444);font-size:12px;line-height:1.5}
      .rk-import-disabled{opacity:.55!important;cursor:not-allowed!important}
    `;
    document.head.append(style);
  }

  function currentPage() {
    const title = document.querySelector(".page-title");
    return title?.textContent.trim() || "";
  }

  function adjustPositionPage() {
    if (location.pathname !== "/service-positions" || !["岗位管理","招聘岗位"].includes(currentPage())) return;
    // This fallback only handles the legacy bundle's dialog. The Vue source
    // declares its disabled state directly.
    const dialog = [...document.querySelectorAll(".el-dialog")].find((item) =>
      item.querySelector(".el-dialog__title")?.textContent.trim() === "导入 / 导出",
    );
    if (!dialog) return;
    for (const button of dialog.querySelectorAll("button")) {
      if (button.textContent.trim() !== "开始导入") continue;
      button.disabled = true;
      button.classList.add("rk-import-disabled");
      button.title = "暂不支持导入；导出仅含岗位索引";
      button.setAttribute("aria-disabled", "true");
      if (button.parentElement && !button.parentElement.querySelector(`[${NOTE_ATTR}]`)) {
        const note = document.createElement("p");
        note.className = "rk-recruitment-note";
        note.setAttribute(NOTE_ATTR, "import");
        note.textContent = "暂不支持导入";
        button.after(note);
      }
    }
  }

  function adjustDrawers() {
    for (const drawer of document.querySelectorAll(".el-drawer")) {
      const heading = drawer.querySelector(".el-drawer__header");
      if (heading?.textContent.trim() === "添加岗位") bindCityTemplate(drawer);
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
    if (!select) return;
    const showResult = (text) => {
      let note = drawer.querySelector(`[${NOTE_ATTR}="city-defaults"]`);
      if (!note && cityItem.after) {
        note = document.createElement("p");
        note.className = "rk-recruitment-note";
        note.setAttribute(NOTE_ATTR, "city-defaults");
        note.setAttribute("role", "status");
        cityItem.after(note);
      }
      if (note) note.textContent = text;
    };
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
          ["默认面试地址", interview.location || interview.raw_address || city.interview_site_name],
          ["面试/工作地址", interview.location || interview.raw_address || city.interview_site_name],
        ];
        let filled = 0;
        for (const [label, rawValue] of values) {
          const value = String(rawValue || "").trim();
          const item = [...drawer.querySelectorAll(".el-form-item")].find((candidate) =>
            (candidate.querySelector("[data-position-field-name]") || candidate.querySelector(".el-form-item__label"))?.textContent.trim() === label,
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
        showResult(filled ? `已带入 ${filled} 项城市默认资料` : "暂无可带入的城市资料");
      } catch {
        if (currentRequest === requestId && drawer.isConnected) {
          showResult("城市资料读取失败，可手动填写");
        }
      }
    };

    const observer = new MutationObserver(() => { void applySelectedCity(); });
    observer.observe(select, { childList: true, subtree: true, characterData: true });
    drawer.addEventListener("change", () => { void applySelectedCity(); });
  }

  function run() {
    styles();
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

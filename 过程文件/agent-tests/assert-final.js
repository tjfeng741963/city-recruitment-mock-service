(() => {
  const sidebar = document.querySelector(".sidebar-menu");
  const items = sidebar ? Array.from(sidebar.querySelectorAll(".el-menu-item")) : [];
  const rows = items.map((el) => {
    const span = el.querySelector(":scope > span");
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      text: (span ? span.textContent : el.textContent).trim(),
      display: cs.display,
      height: Math.round(r.height),
      width: Math.round(r.width),
      hiddenFlag: el.dataset.rkHidden || "",
      renamedFlag: el.dataset.rkRenamed || "",
    };
  });
  const visible = rows.filter((r) => r.display !== "none" && r.height > 0);
  const holiday = rows.filter((r) => r.text.includes("节假日"));
  const summary = rows.filter((r) => r.text.includes("运营汇总"));
  const oldName = rows.filter((r) => r.text.includes("郎职师"));
  const rects = visible.map((r) => r.height);
  const overlapping = sidebar ? (() => {
    const boxes = visible.map((r, i) => items[rows.indexOf(r)]).filter(Boolean).map((el) => el.getBoundingClientRect());
    let bad = 0;
    for (let i = 1; i < boxes.length; i++) if (boxes[i].top < boxes[i - 1].bottom - 1) bad++;
    return bad;
  })() : -1;
  return JSON.stringify({
    url: location.href,
    sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
    sidebarVisibleText: sidebar ? sidebar.innerText : "",
    A_summary_visible: summary.some((r) => r.display !== "none" && r.height > 0),
    A_summary_rows: summary,
    A_old_name_in_sidebar: oldName.length,
    A_old_name_in_body: document.body.innerText.includes("郎职师"),
    B_holiday_in_dom: holiday.length,
    B_holiday_visible: holiday.some((r) => r.display !== "none" && r.height > 0),
    B_holiday_rows: holiday,
    visibleMenuCount: visible.length,
    visibleMenuTexts: visible.map((r) => r.text),
    hiddenMenuTexts: rows.filter((r) => r.display === "none").map((r) => r.text),
    overlappingPairs: overlapping,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  });
})()

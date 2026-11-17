(() => {
  const sidebar = document.querySelector(".sidebar-menu");
  const items = sidebar ? Array.from(sidebar.querySelectorAll(".el-menu-item")) : [];
  const rows = items.map((el) => {
    const span = el.querySelector(":scope > span");
    const cs = getComputedStyle(el);
    return {
      text: (span ? span.textContent : el.textContent).trim(),
      display: cs.display,
      visibility: cs.visibility,
      height: Math.round(el.getBoundingClientRect().height),
      hiddenFlag: el.dataset.rkHidden || "",
      renamedFlag: el.dataset.rkRenamed || "",
      route: el.getAttribute("data-route") || el.getAttribute("index") || "",
    };
  });
  const visibleRows = rows.filter((r) => r.display !== "none" && r.visibility !== "hidden" && r.height > 0);
  const holiday = rows.filter((r) => r.text.includes("节假日"));
  const sidebarText = sidebar ? sidebar.innerText : "";
  const pageH2 = Array.from(document.querySelectorAll(".page-title, h1, h2")).map((n) => n.textContent.trim()).filter(Boolean);
  const scrollW = document.documentElement.scrollWidth;
  const clientW = document.documentElement.clientWidth;
  return JSON.stringify({
    url: location.href,
    hasSidebar: !!sidebar,
    sidebarVisibleText: sidebarText,
    hasOperationalSummaryVisible: visibleRows.some((r) => r.text === "运营汇总"),
    hasOldLabelAnywhere: document.body.innerText.includes("郎职师运营"),
    hasOldLabelInSidebar: sidebarText.includes("郎职师运营"),
    holidayEntryInDom: holiday.length,
    holidayEntryVisible: holiday.some((r) => r.display !== "none" && r.height > 0),
    holidayRows: holiday,
    visibleMenuCount: visibleRows.length,
    visibleMenuTexts: visibleRows.map((r) => r.text),
    hiddenMenuTexts: rows.filter((r) => r.display === "none").map((r) => r.text),
    pageHeadings: pageH2.slice(0, 8),
    horizontalOverflow: scrollW > clientW + 1 ? { scrollW, clientW } : false,
    sidebarRect: sidebar ? { w: Math.round(sidebar.getBoundingClientRect().width), h: Math.round(sidebar.getBoundingClientRect().height) } : null,
  });
})()

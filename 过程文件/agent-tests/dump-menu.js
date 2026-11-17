(() => {
  const menu = document.querySelector(".sidebar-menu") || document.querySelector("aside .el-menu") || document.querySelector(".el-menu");
  const root = menu || document.body;
  const pick = (sel) => Array.from(root.querySelectorAll(sel)).map((el) => {
    const cs = getComputedStyle(el);
    return {
      t: el.textContent.trim().replace(/\s+/g, " "),
      d: cs.display,
      h: Math.round(el.getBoundingClientRect().height),
      cls: el.className,
      rk: el.dataset.rkHidden || el.dataset.rkRenamed || "",
    };
  });
  const items = pick(".el-menu-item");
  const subs = pick(".el-sub-menu__title");
  const aside = document.querySelector("aside, .layout-sidebar, .sidebar");
  return JSON.stringify({
    url: location.href,
    hasSidebarMenu: !!document.querySelector(".sidebar-menu"),
    menuRootClass: menu ? menu.className : null,
    asideClass: aside ? aside.className : null,
    asideRect: aside ? { w: Math.round(aside.getBoundingClientRect().width), h: Math.round(aside.getBoundingClientRect().height) } : null,
    itemCount: items.length,
    subCount: subs.length,
    items,
    subs,
    menuInnerText: menu ? menu.innerText : "",
    bodyHasOld: document.body.innerText.includes("郎职师"),
    bodyHasHoliday: document.body.innerText.includes("节假日"),
  });
})()

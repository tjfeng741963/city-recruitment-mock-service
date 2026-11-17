/**
 * 侧栏与标题的文案调整（运行时补丁）。
 *
 * 为什么是补丁而不是改源码：线上后台是编译好的 Vue 包（public/assets/），
 * 仓库里没有 .vue 源码。和 theme/sidebar.js、theme/city-factories.js 一样，
 * 在页面加载后用 DOM 操作调整，不改压缩过的 bundle。
 *
 * 做两件事：
 *   1. 侧栏「郎职师运营」改回「运营汇总」，页面内 H2「郎职师 · 运营汇总」同步改
 *      ——「郎职师」是早期写死的账号前缀，不是这个页面该有的名字。
 *   2. 隐藏侧栏「节假日管理」入口
 *      —— 该页与「放假总表」重复，客户不需要两个入口。
 *
 * 两条不能破的规矩（照抄 city-factories.js 的教训）：
 *   * 隐藏用 display:none，不 remove()。节点归 Vue 管理，删了会让下一次 patch
 *     找不到节点而报错。
 *   * 用 data 属性做幂等标记。Vue 重新渲染会把文案改回去，MutationObserver
 *     会再调一次，没有标记就会无限触发。
 */
(function () {
  "use strict";

  // 旧文案 → 新文案。菜单项和页面标题共用这张表。
  const RENAME = [
    ["郎职师运营", "运营汇总"],
    ["郎职师 · 运营汇总", "运营汇总"],
  ];

  // 要隐藏的侧栏入口（按菜单文字匹配，不认路由：路由常量可能变，文字是稳定的）
  // 2026-11-17：老友/候选人/设备报表/激活看板四页的后端接口已随旧链路下线
  // （页面点开会 404），入口一并隐藏；「未知问题」由 kb-console.js 负责。
  // 「运营汇总」（原郎职师运营）是照原目标系统照搬的对照页，数据源
  // /agent/report/account-summary 从未实现过，也是 404，一并隐藏。
  const HIDE_MENU = [
    "节假日管理",
    "老友管理",
    "候选人员",
    "设备报表",
    "激活看板",
    "未知问题",
    "运营汇总",
    // 「复聊激活」分组（2026-11-17 用户截图圈出）：激活名单/策略配置/
    // 设备配置/语料库全是旧 kb/复聊链路的功能，后端接口已下线（点开 404）。
    // 子项全隐藏后分组标题由下方逻辑整组隐藏，不留空壳组名。
    "激活名单",
    "策略配置",
    "设备配置",
    "语料库",
  ];

  /** 把节点里的旧文案换成新文案。返回是否改过。 */
  function renameText(node) {
    if (!node) return false;
    const text = node.textContent;
    if (!text) return false;
    let next = text;
    for (const [from, to] of RENAME) {
      if (next.includes(from)) next = next.split(from).join(to);
    }
    if (next === text) return false;
    node.textContent = next;
    return true;
  }

  /** 侧栏菜单项：改文案 + 隐藏指定入口。 */
  function adjustMenu() {
    const sidebar = document.querySelector(".sidebar-menu");
    if (!sidebar) return;

    for (const item of sidebar.querySelectorAll(".el-menu-item")) {
      const span = item.querySelector(":scope > span");
      // 先看当前文字是否命中要隐藏的入口
      const label = span?.textContent.trim() || "";
      if (HIDE_MENU.includes(label) && item.dataset.rkHidden !== "1") {
        item.dataset.rkHidden = "1";
        // 用 CSS 隐藏而不是 remove()：节点归 Vue 管理，删掉会让 patch 出错
        item.style.display = "none";
        continue;
      }
      // 再处理改名
      if (span && renameText(span) && item.dataset.rkRenamed !== "1") {
        item.dataset.rkRenamed = "1";
        // 侧栏折叠态的悬浮提示读的是 data-rk-label，改名后要一起更新
        if (item.dataset.rkLabel) item.dataset.rkLabel = span.textContent.trim();
      }
    }

    // 子项全部被隐藏的分组，连同组标题整组隐藏——否则留一个点不开的
    // 空壳组名挂在侧栏（「复聊激活」四个子项全是死菜单后的遗留问题）。
    for (const sub of sidebar.querySelectorAll(".el-sub-menu")) {
      if (sub.dataset.rkGroupHidden === "1") continue;
      const items = sub.querySelectorAll(".el-menu-item");
      if (!items.length) continue;
      const allHidden = Array.prototype.every.call(
        items,
        (it) => it.style.display === "none",
      );
      if (allHidden) {
        sub.dataset.rkGroupHidden = "1";
        sub.style.display = "none";
      }
    }
  }

  /** 页面标题：账户汇总页的标题是 div.page-title，不是 h1/h2，要一起覆盖。 */
  function adjustHeadings() {
    // 只对**叶子标题节点**做替换。
    // 绝不能把 .main-scroll / .ex-toolbar 这类容器传进 renameText：
    // 该函数用 textContent 整体赋值，会把容器里的所有子节点抹掉，整页报废。
    const nodes = document.querySelectorAll(
      ".page-title, h1, h2, .mod-title, .mod-head h1, .ex-toolbar h2",
    );
    for (const node of nodes) {
      // 只处理没有元素子节点的标题；带子元素的（比如标题里有按钮）跳过
      if (node.children.length > 0) continue;
      renameText(node);
    }
  }

  function run() {
    try {
      adjustMenu();
      adjustHeadings();
    } catch {
      /* 单个节点结构不认识时静默跳过，绝不影响页面其他部分 */
    }
  }

  let frame = 0;
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      run();
    });
  }

  // Vue 渲染是异步的，初次挂载可能晚于本脚本；用 MutationObserver 兜住后续渲染。
  // frame 节流避免一次 DOM 变更风暴里反复跑。
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  if (document.body) run();
  else document.addEventListener("DOMContentLoaded", run, { once: true });

  // 路由切换后标题会整块重建，popstate 再补一次
  window.addEventListener("popstate", schedule);
})();

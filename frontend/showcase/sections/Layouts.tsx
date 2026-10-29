import { useState } from "react";
import { Avatar, Badge, Icon, SearchField, SegmentedControl, StatTile, type IconName, type Tone } from "@ui";
import { Chapter, Spec, UxNotes } from "./Kit";

const NAV_WORK: Array<{ label: string; icon: IconName; count?: number }> = [
  { label: "城市总览", icon: "city" },
  { label: "工厂管理", icon: "factory" },
  { label: "服务岗位", icon: "briefcase" },
  { label: "候选人", icon: "users", count: 47 },
  { label: "招聘员", icon: "user" },
  { label: "会话", icon: "chat", count: 3 },
];
const NAV_OPS: Array<{ label: string; icon: IconName }> = [
  { label: "设备", icon: "device" },
  { label: "激活策略", icon: "bolt" },
  { label: "数据报表", icon: "chart" },
];
const TASKS: Array<{ title: string; detail: string; tone: Tone }> = [
  { title: "岗位即将过期", detail: "富士康龙华 · 3 个", tone: "warning" },
  { title: "设备离线", detail: "惠州 2 台", tone: "danger" },
  { title: "新候选人待派单", detail: "12 人", tone: "accent" },
];

function NavButton({ label, icon, count, active, onSelect }: { label: string; icon: IconName; count?: number; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`lay-nav ${active ? "is-active" : ""}`} aria-current={active ? "page" : undefined} onClick={onSelect}>
      <Icon name={icon} size={17} />
      <span>{label}</span>
      {count !== undefined && <span className="lay-nav-count ui-num">{count}</span>}
    </button>
  );
}

function ShellPreview() {
  const [active, setActive] = useState("城市总览");
  const [range, setRange] = useState("week");
  const [q, setQ] = useState("");
  return (
    <div className="lay-shell" aria-label="应用框架示例">
      <aside className="lay-sidebar">
        <div className="lay-brand">
          <span className="lay-brand-mark" aria-hidden="true">
            <Icon name="city" size={16} />
          </span>
          城市招聘
        </div>
        <nav aria-label="主导航" className="lay-nav-list">
          <span className="lay-nav-group">工作台</span>
          {NAV_WORK.map((n) => (
            <NavButton key={n.label} {...n} active={active === n.label} onSelect={() => setActive(n.label)} />
          ))}
          <span className="lay-nav-group">运营</span>
          {NAV_OPS.map((n) => (
            <NavButton key={n.label} {...n} active={active === n.label} onSelect={() => setActive(n.label)} />
          ))}
        </nav>
        <div className="lay-user">
          <Avatar name="林调度" size={30} status="online" />
          <span>
            <strong>林调度</strong>
            <small>深圳 · 管理员</small>
          </span>
        </div>
      </aside>
      <div className="lay-main">
        <header className="lay-toolbar">
          <h4>{active}</h4>
          <div className="lay-toolbar-tools">
            <SearchField label="全局搜索" value={q} onChange={setQ} placeholder="搜索" shortcut="⌘K" />
            <button type="button" className="ui-icon-btn" aria-label="通知">
              <Icon name="bell" size={18} />
            </button>
          </div>
        </header>
        <div className="lay-content">
          <div className="lay-page-head">
            <div>
              <h5>本周概况</h5>
              <p>深圳、东莞、惠州 · 更新于 10:42</p>
            </div>
            <SegmentedControl
              label="时间范围"
              size="sm"
              value={range}
              onChange={setRange}
              options={[
                { value: "day", label: "今日" },
                { value: "week", label: "本周" },
                { value: "month", label: "本月" },
              ]}
            />
          </div>
          <div className="lay-bento">
            <div className="lay-bento-hero">
              <StatTile icon="users" label="新增候选人" value="1,284" delta="+12.4%" spark={[12, 18, 14, 22, 19, 28, 31]} />
            </div>
            <StatTile icon="check" label="已入职" value="326" unit="人" delta="+38" />
            <StatTile icon="alert" label="待回访" value="47" delta="需处理" deltaTone="warning" />
            <div className="lay-bento-list">
              <strong>需要你处理</strong>
              {TASKS.map((t) => (
                <div key={t.title} className="lay-task">
                  <Badge tone={t.tone} dot>
                    {t.title}
                  </Badge>
                  <span>{t.detail}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Wire({ title, use, kind }: { title: string; use: string; kind: "overview" | "list" | "settings" }) {
  return (
    <figure className="lay-wire">
      <div className={`lay-wire-frame is-${kind}`} aria-hidden="true">
        <span className="w-side" />
        <span className="w-bar" />
        {kind === "overview" && (
          <>
            <span className="w-hero" />
            <span className="w-tile" />
            <span className="w-tile" />
            <span className="w-chart" />
            <span className="w-list" />
          </>
        )}
        {kind === "list" && (
          <>
            <span className="w-filter" />
            <span className="w-table" />
            <span className="w-sheet" />
          </>
        )}
        {kind === "settings" && (
          <>
            <span className="w-sub" />
            <span className="w-group" />
            <span className="w-group is-short" />
            <span className="w-group" />
          </>
        )}
      </div>
      <figcaption>
        <strong>{title}</strong>
        <span>{use}</span>
      </figcaption>
    </figure>
  );
}

const METRICS: Array<[string, string]> = [
  ["侧栏", "240 / 折叠 64"],
  ["工具栏", "52"],
  ["内容最大宽", "1280"],
  ["卡片内边距", "20"],
  ["卡片间距", "16"],
  ["区块间距", "32"],
];
const BREAKPOINTS: Array<[string, string]> = [
  ["≥ 1200", "侧栏展开，卡片 4 列"],
  ["768–1199", "侧栏折叠成图标，卡片 2 列，侧板变全屏"],
  ["< 768", "侧栏收进左上角菜单，卡片单列，表格变卡片列表，主按钮固定在底部"],
];

export function Layouts() {
  return (
    <Chapter id="layout" index="05" title="布局" lead="采用 macOS 应用的骨架：左侧侧栏，顶部毛玻璃工具栏，内容区是浅灰底上的白色卡片。所有页面共用这一套框架，只换中间的内容。">
      <div className="kit-grid">
        <Spec title="应用框架 · 可交互" why="侧栏 240px，分组标题区分“工作台”和“运营”。工具栏 52px，滚动时内容从毛玻璃下方穿过。内容区最大宽度 1280px。" wide>
          <ShellPreview />
          <UxNotes
            items={[
              ["侧栏", "选中项用浅蓝底 #D3E3FD + 深蓝字，不用实心色块。待处理数量显示在右侧，让人一眼知道去哪。"],
              ["工具栏", "左边是当前页标题，右边是全局搜索和通知。页面级操作（新建、导出）放在页面标题行，不放这里。"],
              ["首屏", "总览页用大小不一的卡片：最重要的指标占两格，“需要你处理”的清单放在右侧最显眼的位置。"],
            ]}
          />
        </Spec>
        <Spec title="栅格与尺寸" why="12 列栅格，列间距 16。页面左右留白：桌面 32，平板 24，手机 16。">
          <div className="lay-grid-demo" aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <span key={i} />
            ))}
          </div>
          <dl className="lay-metrics">
            {METRICS.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="ui-num">{v}</dd>
              </div>
            ))}
          </dl>
        </Spec>
        <Spec title="响应式" why="三个断点。框架会变，组件不变。">
          <dl className="lay-metrics is-stack">
            {BREAKPOINTS.map(([k, v]) => (
              <div key={k}>
                <dt className="ui-num">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </Spec>
        <Spec title="三种典型页面" why="后台里的每个页面都属于这三种之一：先选骨架，再放组件。" wide>
          <div className="lay-wires">
            <Wire kind="overview" title="总览页" use="指标卡 + 待办清单 + 趋势图。用于城市总览、数据报表。" />
            <Wire kind="list" title="列表页" use="筛选条 + 表格 + 右侧编辑侧板。用于工厂、岗位、候选人、设备。" />
            <Wire kind="settings" title="设置页" use="二级导航 + 分组列表。用于派单规则、激活策略、系统设置。" />
          </div>
        </Spec>
      </div>
    </Chapter>
  );
}

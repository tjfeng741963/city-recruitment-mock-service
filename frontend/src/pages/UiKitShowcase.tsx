import { useEffect, useState } from "react";
import { Icon, SegmentedControl } from "../components/ui";
import { Chapter } from "./uikit/Kit";
import { Foundations } from "./uikit/Foundations";
import { ButtonSpec, InputSpec, SelectionSpec, ToggleSpec } from "./uikit/Controls";
import { DisplaySpec, EmptySpec, FeedbackSpec, ListSpec, MetricSpec, NavSpec, TableSpec } from "./uikit/Patterns";
import { Layouts } from "./uikit/Layouts";

type Theme = "light" | "dark";

const TOC = [
  { id: "thinking", label: "设计思路" },
  { id: "tone", label: "品牌调性" },
  { id: "foundations", label: "基础规范" },
  { id: "components", label: "组件" },
  { id: "layout", label: "布局" },
];
const TOC_IDS = TOC.map((t) => t.id);

function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, [ids]);
  return active;
}

export function UiKitShowcase() {
  const [theme, setTheme] = useState<Theme>("light");
  const active = useActiveSection(TOC_IDS);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);

  return (
    <div className="kit-page">
      <header className="kit-topbar">
        <div className="kit-topbar-inner">
          <a className="kit-logo" href="#thinking">
            <span className="kit-logo-mark" aria-hidden="true">
              <Icon name="city" size={15} />
            </span>
            城市招聘 · 设计系统
          </a>
          <nav className="kit-toc" aria-label="章节">
            {TOC.map((t) => (
              <a key={t.id} href={`#${t.id}`} className={active === t.id ? "is-active" : undefined} aria-current={active === t.id ? "true" : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
          <SegmentedControl
            label="外观"
            size="sm"
            value={theme}
            onChange={(v) => setTheme(v as Theme)}
            options={[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
          />
        </div>
      </header>

      <section className="kit-hero">
        <p className="kit-hero-kicker">Design System · v2.0</p>
        <h1>
          安静的界面，
          <br />
          清楚的判断。
        </h1>
        <p className="kit-hero-lead">
          城市招聘配置后台的完整设计语言：设计思路、品牌调性、基础规范、全部组件与它们的交互，以及页面布局。页面里的组件都是可以直接操作的真实代码。
        </p>
        <dl className="kit-hero-facts">
          <div>
            <dt>组件</dt>
            <dd className="ui-num">26</dd>
          </div>
          <div>
            <dt>主色</dt>
            <dd>谷歌蓝</dd>
          </div>
          <div>
            <dt>对比度</dt>
            <dd>WCAG AA</dd>
          </div>
          <div>
            <dt>主题</dt>
            <dd>浅色 / 深色</dd>
          </div>
        </dl>
      </section>

      <main className="kit-main">
        <Foundations />

        <Chapter id="components" index="04" title="组件" lead="每个组件都写明为什么这样设计，以及交互规则。状态格里的悬停、聚焦、按下是强制渲染出来的，方便对比；其余都可以直接点。">
          <div className="kit-grid">
            <ButtonSpec />
            <InputSpec />
            <SelectionSpec />
            <ToggleSpec />
            <ListSpec />
            <DisplaySpec />
            <MetricSpec />
            <NavSpec />
            <FeedbackSpec />
            <TableSpec />
            <EmptySpec />
          </div>
        </Chapter>

        <Layouts />
      </main>

      <footer className="kit-footer">
        <p>城市招聘 · 设计系统 · 2026-10-28</p>
        <p>Google Sans · 谷歌蓝渐变 · 2025 G 标四色 · 蓝绿黄背景光</p>
      </footer>
    </div>
  );
}

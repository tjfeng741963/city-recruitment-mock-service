import { useState } from "react";
import { Button, Icon, ICON_NAMES } from "../../components/ui";
import { Chapter, Spec } from "./Kit";

const PRINCIPLES = [
  {
    title: "内容先于外壳",
    body: "调度员一天要扫几百行工厂、岗位和候选人。界面只用白底、浅灰和一种谷歌蓝，层级交给字重和留白，让数据本身成为页面上最显眼的东西。",
    rule: "一屏只出现一个渐变主按钮",
  },
  {
    title: "清爽的谷歌蓝",
    body: "主色沿用 Gemini、Stitch 和谷歌官网现在的那套蓝：#0B57D0 起，到 #1A6BE0 收的一条短渐变，只用在“可以点的”和“现在选中的”东西上：主按钮、开关、单选、进度、当前步骤。2025 版 G 标的红黄绿蓝四色只出现在 logo 描边上。页面底下铺一层很淡的蓝、绿、黄背景光，和 Gemini 首页的光晕同源。状态色永远配文字。",
    rule: "渐变只上控件，不上大面积色块",
  },
  {
    title: "按下就有回应",
    body: "每个控件在 100ms 内给出手感：按钮按下变深、开关滑块拉伸、列表行按下变灰。动画只用来说明“发生了什么”，不做装饰。",
    rule: "反馈 ≤100ms，过渡 ≤420ms",
  },
  {
    title: "错误要给出路",
    body: "提示文案写原因和改法：“电话需为 11 位数字”，不写“格式错误”。危险操作先说后果，再让人确认，能撤销的就不弹确认框。",
    rule: "能撤销的操作不弹确认框",
  },
];

const TONE = [
  ["像", "一个靠谱的同事：说话短、给结论、不抢戏"],
  ["不像", "Ant 默认蓝后台、蓝绿橙三色仪表盘、满屏霓虹渐变"],
  ["参照", "Gemini、Stitch、谷歌官网：#F8FAFD 冷白底，白卡片，浅蓝 #D3E3FD 标出选中"],
  ["文案", "动词开头，数字具体：“派单 12 人”而不是“操作成功”"],
];

const SURFACES = [
  { token: "--page", name: "页面底", hex: "#F8FAFD", note: "所有页面的底色" },
  { token: "--bg", name: "卡片", hex: "#FFFFFF", note: "内容承载面" },
  { token: "--panel-2", name: "内嵌面", hex: "#F0F4F9", note: "卡片里的分区" },
  { token: "--fill", name: "填充", hex: "灰 12%", note: "次按钮、搜索框" },
];
const INKS = [
  { token: "--ink-1", name: "标题墨", hex: "#1F1F1F", note: "16.5:1" },
  { token: "--ink-2", name: "正文墨", hex: "#444746", note: "9.4:1" },
  { token: "--ink-3", name: "说明墨", hex: "#5E5E5E", note: "6.5:1" },
  { token: "--control-border", name: "控件线", hex: "#747775", note: "4.5:1" },
];
const ACCENTS = [
  { token: "--accent", name: "主色 · 谷歌蓝", hex: "#0B57D0", note: "按钮填充" },
  { token: "--accent-ink", name: "谷歌蓝 · 文字", hex: "#0B57D0", note: "链接与选中" },
  { token: "--accent-soft", name: "谷歌蓝 · 浅底", hex: "#D3E3FD", note: "选中行、徽标" },
  { token: "--grad-primary", name: "主渐变", hex: "深蓝→谷歌蓝", note: "主按钮、选中控件" },
  { token: "--up", name: "成功", hex: "#146C2E", note: "已入职、在线" },
  { token: "--warn", name: "注意", hex: "#A14F00", note: "待处理、临期" },
  { token: "--down", name: "错误", hex: "#B3261E", note: "失败、删除" },
];

const GLOWS = [
  { token: "--ambient-a", name: "背景光 · 蓝", pos: "右上" },
  { token: "--ambient-b", name: "背景光 · 绿", pos: "左侧" },
  { token: "--ambient-c", name: "背景光 · 黄", pos: "底部" },
];

const TYPE = [
  { token: "--t-display", px: 56, w: 700, use: "展示页大标题", sample: "城市招聘" },
  { token: "--t-large", px: 34, w: 700, use: "页面标题", sample: "工厂管理" },
  { token: "--t-title2", px: 22, w: 700, use: "卡片标题", sample: "本周入职趋势" },
  { token: "--t-title3", px: 19, w: 600, use: "弹窗标题", sample: "删除这家工厂？" },
  { token: "--t-body", px: 15, w: 400, use: "正文 / 表格", sample: "富士康龙华园区 · 长白班，包吃住" },
  { token: "--t-subhead", px: 13, w: 400, use: "辅助说明", sample: "候选人状态变更时发送短信" },
  { token: "--t-caption", px: 11, w: 500, use: "表头 / 角标", sample: "更新于 10:42" },
];

const SPACING = [4, 8, 12, 16, 20, 24, 32, 48, 64];
const RADII = [
  { token: "--r-xs", px: 8, use: "标签、小控件" },
  { token: "--r-sm", px: 12, use: "输入框、分组列表" },
  { token: "--r", px: 18, use: "卡片" },
  { token: "--r-lg", px: 28, use: "弹窗、侧板" },
  { token: "--r-pill", px: 999, use: "按钮、徽标" },
];
const MOTION = [
  { token: "--dur-instant", ms: 100, ease: "--ease-standard", use: "按压、勾选" },
  { token: "--dur-fast", ms: 180, ease: "--ease-standard", use: "悬停、颜色" },
  { token: "--dur-base", ms: 280, ease: "--ease-signature", use: "分段滑块、标签下划线" },
  { token: "--dur-slow", ms: 420, ease: "--ease-spring", use: "弹窗、通知入场" },
];

function SwatchRow({ items }: { items: typeof SURFACES }) {
  return (
    <div className="kit-swatches">
      {items.map((s) => (
        <div className="kit-swatch" key={s.token}>
          <span className="kit-swatch-chip" style={{ background: `var(${s.token})` }} />
          <strong>{s.name}</strong>
          <code>{s.hex}</code>
          <span>{s.note}</span>
        </div>
      ))}
    </div>
  );
}

function MotionLab() {
  const [on, setOn] = useState(false);
  return (
    <div className="kit-motion">
      <Button variant="secondary" size="sm" onClick={() => setOn((v) => !v)}>
        {on ? "复位" : "播放全部"}
      </Button>
      {MOTION.map((m) => (
        <div className="kit-motion-row" key={m.token}>
          <code>{m.ms}ms</code>
          <div className="kit-motion-lane">
            <span
              className="kit-motion-dot"
              data-on={on || undefined}
              style={{ transitionDuration: `var(${m.token})`, transitionTimingFunction: `var(${m.ease})` }}
            />
          </div>
          <span>{m.use}</span>
        </div>
      ))}
    </div>
  );
}

export function Foundations() {
  return (
    <>
      <Chapter id="thinking" index="01" title="设计思路" lead="这是一套给招聘调度员用的工作台。他们每天对着工厂、岗位和候选人做几百次判断，所以界面要安静、清楚、手感准确，像一件好用的系统工具。">
        <div className="kit-principles">
          {PRINCIPLES.map((p, i) => (
            <article key={p.title} className={`kit-principle ${i === 0 ? "is-lead" : ""}`}>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
              <span className="kit-principle-rule">{p.rule}</span>
            </article>
          ))}
        </div>
      </Chapter>

      <Chapter id="tone" index="02" title="品牌调性" lead="白底谷歌蓝，清爽、可信。白色卡片浮在冷白底上，铺一层淡淡的蓝绿黄背景光；一条谷歌蓝渐变负责所有可交互的东西，其余全部交给中性色和排版。">
        <div className="kit-tone">
          <div className="kit-tone-hero" aria-hidden="true">
            <span className="kit-tone-word">安静</span>
            <span className="kit-tone-word">清楚</span>
            <span className="kit-tone-word is-accent">可靠</span>
          </div>
          <dl className="kit-tone-list">
            {TONE.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Chapter>

      <Chapter id="foundations" index="03" title="基础规范" lead="所有组件只引用这里的 token。浅色与深色两套全部通过 WCAG AA：正文 ≥ 4.5:1，控件描边与焦点环 ≥ 3:1。">
        <div className="kit-grid">
          <Spec title="色彩 · 表面与墨色" why="四层灰阶就是全部的层级。没有边框也能分出层次，靠的是 #F8FAFD、#F0F4F9 和 #FFFFFF 之间的一点明度差，三层都带一点冷蓝。" wide>
            <SwatchRow items={SURFACES} />
            <SwatchRow items={INKS} />
          </Spec>
          <Spec title="色彩 · 谷歌蓝与语义色" why="主色 #0B57D0 填充和文字共用一个值（白字 6.4:1，冷灰底 5.8:1）。选中项不用实心色块，用浅蓝底 #D3E3FD 配深蓝字 #041E49（12.6:1）。深色模式下主色反过来变成浅蓝 #A8C7FA 配深蓝字 #062E6F。成功、注意、错误用谷歌的绿 #146C2E、橙 #A14F00、红 #B3261E，各配一个同色系浅底。语义色永远搭配文字或图标，不单靠颜色传达。" wide>
            <SwatchRow items={ACCENTS} />
          </Spec>
          <Spec title="渐变与背景光" why="主渐变 110° 从 #0842A0 经 #0B57D0 到 #1A6BE0，只在蓝色里走一小段明度，每个色标上的白字都 ≥ 4.9:1。四色渐变 #FC413D→#FFE432→#00B95C→#3186FF 取自 2025 版 G 标，只用于 logo，不垫在文字下面。背景光是蓝、绿、黄三团大半径径向光，固定在视口上；深色模式底色是 Gemini 的 #131314。" wide>
            <div className="kit-glow-demo">
              <div className="kit-glow-stage">
                <div className="kit-glow-card">
                  <strong>今日待派单</strong>
                  <span className="ui-num">128</span>
                  <Button>立即派单</Button>
                </div>
              </div>
              <div className="kit-glow-legend">
                <div className="kit-glow-bar" />
                {GLOWS.map((g) => (
                  <div className="kit-swatch" key={g.token}>
                    <span className="kit-swatch-chip" style={{ background: `var(${g.token})` }} />
                    <strong>{g.name}</strong>
                    <code>{g.token}</code>
                    <span>{g.pos}</span>
                  </div>
                ))}
              </div>
            </div>
          </Spec>
          <Spec title="字体" why="系统字体栈：Mac 上是苹方 + SF，Windows 上是微软雅黑 + Segoe。中文标题行高放到 1.2，比英文宽松；数字统一用等宽数字，方便列对齐。" wide>
            <div className="kit-type">
              {TYPE.map((t) => (
                <div className="kit-type-row" key={t.token}>
                  <code>
                    {t.px} / {t.w}
                  </code>
                  <span style={{ fontSize: t.px, fontWeight: t.w, letterSpacing: t.px >= 28 ? "-0.02em" : 0 }}>{t.sample}</span>
                  <span className="kit-type-use">{t.use}</span>
                </div>
              ))}
            </div>
          </Spec>
          <Spec title="间距" why="4 的倍数。卡片内边距 20，卡片间距 16，分区之间 48。">
            <div className="kit-spacing">
              {SPACING.map((s) => (
                <div key={s} className="kit-space">
                  <span style={{ width: s, height: s }} />
                  <code>{s}</code>
                </div>
              ))}
            </div>
          </Spec>
          <Spec title="圆角" why="内层圆角小于外层：卡片 18 里放 12 的输入框。按钮和徽标用全圆。">
            <div className="kit-radii">
              {RADII.map((r) => (
                <div key={r.token} className="kit-radius">
                  <span style={{ borderRadius: `var(${r.token})` }} />
                  <code>{r.px === 999 ? "pill" : r.px}</code>
                  <small>{r.use}</small>
                </div>
              ))}
            </div>
          </Spec>
          <Spec title="材质与阴影" why="卡片只用一层极淡的阴影。毛玻璃只给浮在内容上方的东西：顶栏、菜单、通知。">
            <div className="kit-material">
              <div className="kit-mat" style={{ boxShadow: "var(--shadow)" }}>
                <strong>卡片</strong>
                <code>shadow</code>
              </div>
              <div className="kit-mat" style={{ boxShadow: "var(--shadow-md)" }}>
                <strong>悬浮</strong>
                <code>shadow-md</code>
              </div>
              <div className="kit-mat" style={{ boxShadow: "var(--shadow-lg)" }}>
                <strong>弹窗</strong>
                <code>shadow-lg</code>
              </div>
              <div className="kit-mat is-glass">
                <strong>毛玻璃</strong>
                <code>blur 20 · 72%</code>
              </div>
            </div>
          </Spec>
          <Spec title="动效" why="四档时长、三条曲线。系统开启“减少动态效果”后全部归零，焦点环永远立即出现。">
            <MotionLab />
          </Spec>
          <Spec title="图标" why="24 网格、1.75 描边、圆头圆角，和 SF Symbols 的线条一致。默认 18px，列表里 16px。" wide>
            <div className="kit-icons">
              {ICON_NAMES.map((n) => (
                <span key={n} className="kit-icon" title={n}>
                  <Icon name={n} size={20} />
                  <code>{n}</code>
                </span>
              ))}
            </div>
          </Spec>
        </div>
      </Chapter>
    </>
  );
}

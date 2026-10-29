import { useCallback, useState } from "react";
import {
  Alert,
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  Input,
  ListGroup,
  ListRow,
  Menu,
  Pagination,
  ProgressBar,
  Skeleton,
  StatTile,
  Stepper,
  Switch,
  Tabs,
  Tag,
  ToastViewport,
  Tooltip,
  type Column,
  type ToastItem,
  type Tone,
} from "@ui";
import { Spec, UxNotes } from "./Kit";

const DEFAULT_TAGS = ["长白班", "包吃住", "18–45 岁", "可住宿"];

export function DisplaySpec() {
  const [tags, setTags] = useState(DEFAULT_TAGS);
  return (
    <Spec title="徽标 · 标签 · 头像" why="徽标表示状态，只读；标签表示条件，可以移除。两者都用浅底深字，不用实心色块。" wide>
      <div className="kit-row">
        <Badge tone="success" dot>
          已入职
        </Badge>
        <Badge tone="accent" dot>
          面试中
        </Badge>
        <Badge tone="warning" dot>
          待回访
        </Badge>
        <Badge tone="danger" dot>
          已流失
        </Badge>
        <Badge>草稿</Badge>
        <Badge tone="accent">+12</Badge>
      </div>
      <div className="kit-row">
        {tags.map((t) => (
          <Tag key={t} onRemove={() => setTags((s) => s.filter((x) => x !== t))}>
            {t}
          </Tag>
        ))}
        <Tag>只读标签</Tag>
        {tags.length < DEFAULT_TAGS.length && (
          <Button variant="ghost" size="sm" onClick={() => setTags(DEFAULT_TAGS)}>
            还原
          </Button>
        )}
      </div>
      <div className="kit-row">
        <Avatar name="王建国" size={40} status="online" />
        <Avatar name="李晓雯" size={40} status="away" />
        <Avatar name="陈立" size={40} status="offline" />
        <Avatar name="周敏" size={32} />
        <Avatar name="赵磊" size={24} />
        <Tooltip content="招聘员在线，平均 3 分钟回复">
          <button type="button" className="ui-icon-btn" aria-label="在线说明">
            <Icon name="info" size={18} />
          </button>
        </Tooltip>
      </div>
      <UxNotes
        items={[
          ["状态色", "绿=完成，蓝=进行中，橙=需要人处理，红=失败。始终带圆点和文字，色弱用户也能分辨。"],
          ["头像", "没有照片时显示姓氏，灰色渐变底。在线状态点用白色描边从头像里切出来。"],
          ["提示气泡", "悬停 300ms 后出现，键盘聚焦立即出现。只放补充说明，不放必须看到的信息。"],
        ]}
      />
    </Spec>
  );
}

export function MetricSpec() {
  return (
    <Spec title="指标卡 · 进度 · 骨架屏" why="数字是主角：28px 粗体等宽数字，标签只用 13px 灰字。趋势线只画形状，不画坐标轴。" wide>
      <div className="kit-stats">
        <StatTile icon="users" label="本周新增候选人" value="1,284" delta="+12.4%" spark={[12, 18, 14, 22, 19, 28, 31]} />
        <StatTile icon="check" label="已入职" value="326" unit="人" delta="+38" spark={[8, 9, 12, 10, 14, 16, 19]} />
        <StatTile icon="clock" label="平均到岗时长" value="3.2" unit="天" delta="-0.4 天" spark={[5, 4.6, 4.4, 4, 3.8, 3.5, 3.2]} />
        <StatTile icon="alert" label="待回访" value="47" delta="需处理" deltaTone="warning" />
      </div>
      <div className="kit-cols">
        <div className="kit-col">
          <ProgressBar label="深圳 · 本月招聘目标" value={72} />
          <ProgressBar label="东莞 · 本月招聘目标" value={100} tone="success" />
          <ProgressBar label="惠州 · 设备在线率" value={34} tone="warning" />
        </div>
        <div className="kit-col kit-skeleton-demo" aria-label="加载中示例">
          <div className="kit-row">
            <Skeleton width={40} height={40} round />
            <div className="kit-skeleton-lines">
              <Skeleton width="60%" />
              <Skeleton width="35%" height={12} />
            </div>
          </div>
          <Skeleton height={64} />
          <Skeleton width="80%" />
        </div>
      </div>
      <UxNotes
        items={[
          ["骨架屏", "形状和真实内容一致，加载完成时没有跳动。超过 1 秒才显示，快的接口直接出内容。"],
          ["趋势", "越低越好的指标（到岗时长）下降时也用绿色，颜色表达好坏，不表达涨跌。"],
        ]}
      />
    </Spec>
  );
}

export function NavSpec() {
  const [tab, setTab] = useState("all");
  const [page, setPage] = useState(1);
  return (
    <Spec title="导航 Tabs · 面包屑 · 分页 · 步骤条" why="标签页切换同一对象的不同视图；面包屑说明“我在哪”；步骤条只用于必须按顺序完成的流程。" wide>
      <Breadcrumb items={["城市总览", "深圳", "富士康龙华"]} />
      <Tabs
        label="候选人状态"
        value={tab}
        onChange={setTab}
        items={[
          { value: "all", label: "全部", count: 128 },
          { value: "talking", label: "沟通中", count: 42 },
          { value: "interview", label: "待面试", count: 17 },
          { value: "onboard", label: "已入职", count: 61 },
          { value: "lost", label: "已流失", count: 8 },
        ]}
      />
      <Stepper steps={["选择城市", "配置岗位", "分配招聘员", "确认上线"]} current={2} />
      <Pagination page={page} total={128} pageSize={20} onChange={setPage} />
      <UxNotes
        items={[
          ["标签页", "谷歌蓝下划线从中间展开，数量角标跟随选中变色。左右方向键切换。"],
          ["分页", "只给“上一页 / 下一页”和位置，后台列表很少需要跳到第 37 页。"],
        ]}
      />
    </Spec>
  );
}

export function ListSpec() {
  return (
    <Spec title="分组列表 List" why="设置页和详情页使用 iOS 的分组列表：白色圆角块，分隔线从文字处开始，不贯穿整行。">
      <div className="kit-col">
        <ListGroup header="派单规则" footer="关闭后，新候选人需要手动分配给招聘员。">
          <ListRow icon="bolt" title="自动派单" trailing={<Switch id="k-row-sw" label="" aria-label="自动派单" defaultChecked />} />
          <ListRow icon="clock" iconTone="warning" title="超时回收" detail="30 分钟" onClick={() => undefined} />
          <ListRow icon="users" iconTone="success" title="派单范围" subtitle="仅本城市在线招聘员" onClick={() => undefined} />
        </ListGroup>
        <ListGroup header="危险操作">
          <ListRow icon="trash" iconTone="danger" title="清空历史会话" onClick={() => undefined} />
        </ListGroup>
      </div>
      <UxNotes items={[["整行可点", "有箭头的行整行都是点击区，按下时整行变灰；带开关的行只有开关可点。"]]} />
    </Spec>
  );
}

let toastSeq = 0;

export function FeedbackSpec() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setToasts((s) => s.filter((t) => t.id !== id)), []);
  const push = (tone: Tone, title: string, undo?: boolean) => {
    const id = ++toastSeq;
    setToasts((s) => [...s.slice(-2), { id, tone, title, undo }]);
    window.setTimeout(() => dismiss(id), 4000);
  };
  const closeDialog = useCallback(() => setDialog(false), []);
  const closeSheet = useCallback(() => setSheet(false), []);

  return (
    <Spec title="反馈 Alert · Toast · Dialog · Sheet · Menu" why="按打扰程度从低到高：行内提示 → 底部通知 → 侧板 → 弹窗。能用低一级解决的，不升级。" wide>
      <div className="kit-col">
        <Alert tone="accent" title="深圳有 3 家工厂岗位即将过期">
          过期后招聘员端将不再展示，建议今天内更新。
        </Alert>
        <Alert
          tone="warning"
          title="2 台设备离线超过 1 小时"
          action={
            <Button size="sm" variant="secondary">
              查看
            </Button>
          }
        />
        <Alert tone="danger" title="同步失败：企业微信接口返回 401">
          令牌已过期，请在“系统设置 → 企业微信”重新授权。
        </Alert>
        <Alert tone="success" title="已为 12 位候选人完成派单" />
      </div>
      <div className="kit-row">
        <Button variant="secondary" onClick={() => push("success", "已派单给 王建国", true)}>
          底部通知
        </Button>
        <Button variant="secondary" onClick={() => push("danger", "保存失败，网络已断开")}>
          错误通知
        </Button>
        <Button variant="secondary" onClick={() => setSheet(true)}>
          打开侧板
        </Button>
        <Button variant="destructive" onClick={() => setDialog(true)}>
          删除工厂
        </Button>
        <Menu
          label="更多操作"
          items={[
            { label: "编辑", icon: "edit" },
            { label: "复制链接", icon: "link" },
            { label: "导出", icon: "download" },
            { label: "删除", icon: "trash", danger: true },
          ]}
        />
      </div>
      <UxNotes
        items={[
          ["通知", "底部居中、毛玻璃胶囊，4 秒后消失，最多叠 3 条。可撤销的操作直接给“撤销”，不弹确认框。"],
          ["弹窗", "只用于不可撤销的操作。标题写成问题，正文写后果，危险按钮放在最右并标红。Esc 关闭，焦点回到触发按钮。"],
          ["侧板", "从右侧滑入，用于“不离开列表就能编辑”。点遮罩或 Esc 关闭。"],
          ["菜单", "从按钮所在的角放大弹出，方向键移动，悬停整行染上浅绿。"],
        ]}
      />
      <Dialog
        open={dialog}
        onClose={closeDialog}
        title="删除“富士康龙华”？"
        description="该工厂下的 6 个岗位会一起下线，已在沟通的 23 位候选人会转入“待分配”。此操作无法撤销。"
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog}>
              取消
            </Button>
            <Button variant="destructive" onClick={closeDialog}>
              删除工厂
            </Button>
          </>
        }
      />
      <Dialog
        open={sheet}
        onClose={closeSheet}
        variant="sheet"
        title="编辑岗位"
        footer={
          <>
            <Button variant="secondary" onClick={closeSheet}>
              取消
            </Button>
            <Button onClick={closeSheet}>保存</Button>
          </>
        }
      >
        <Input id="k-sheet-1" label="岗位名称" defaultValue="普工 · 长白班" />
        <Input id="k-sheet-2" label="月薪（元）" defaultValue="5800–7200" helperText="填写区间，招聘员端按区间展示" />
        <Switch id="k-sheet-3" label="包吃住" defaultChecked />
      </Dialog>
      <ToastViewport items={toasts} onDismiss={dismiss} />
    </Spec>
  );
}

interface Candidate {
  id: string;
  name: string;
  city: string;
  factory: string;
  status: "onboard" | "interview" | "talking" | "lost";
  days: number;
}

const STATUS: Record<Candidate["status"], { tone: Tone; label: string }> = {
  onboard: { tone: "success", label: "已入职" },
  interview: { tone: "accent", label: "待面试" },
  talking: { tone: "neutral", label: "沟通中" },
  lost: { tone: "danger", label: "已流失" },
};

const CANDIDATES: Candidate[] = [
  { id: "C-1041", name: "王建国", city: "深圳", factory: "富士康龙华", status: "onboard", days: 2 },
  { id: "C-1042", name: "李晓雯", city: "东莞", factory: "立讯精密", status: "interview", days: 5 },
  { id: "C-1043", name: "陈立", city: "深圳", factory: "比亚迪坪山", status: "talking", days: 1 },
  { id: "C-1044", name: "周敏", city: "惠州", factory: "TCL 仲恺", status: "lost", days: 9 },
  { id: "C-1045", name: "赵磊", city: "东莞", factory: "欧菲光", status: "interview", days: 3 },
];

const COLUMNS: Column<Candidate>[] = [
  {
    key: "name",
    header: "候选人",
    sortable: true,
    render: (r) => (
      <span className="kit-cell-person">
        <Avatar name={r.name} size={28} />
        <span>
          <strong>{r.name}</strong>
          <small>{r.id}</small>
        </span>
      </span>
    ),
  },
  { key: "city", header: "城市", sortable: true },
  { key: "factory", header: "意向工厂" },
  {
    key: "status",
    header: "状态",
    render: (r) => (
      <Badge tone={STATUS[r.status].tone} dot>
        {STATUS[r.status].label}
      </Badge>
    ),
  },
  { key: "days", header: "跟进天数", align: "right", sortable: true },
];

const TABLE_MODES = [
  { value: "data", label: "有数据" },
  { value: "loading", label: "加载中" },
  { value: "empty", label: "空结果" },
] as const;

export function TableSpec() {
  const [mode, setMode] = useState<(typeof TABLE_MODES)[number]["value"]>("data");
  return (
    <Spec title="数据表格 Table" why="没有竖线、没有斑马纹，只有一条极淡的横线。数字列右对齐，用等宽数字。勾选后批量操作条覆盖在表头上，不挤压内容。" wide>
      <div className="kit-row">
        {TABLE_MODES.map((m) => (
          <Button key={m.value} size="sm" variant={mode === m.value ? "tinted" : "ghost"} onClick={() => setMode(m.value)}>
            {m.label}
          </Button>
        ))}
      </div>
      <DataTable
        caption="候选人列表"
        columns={COLUMNS}
        rows={mode === "empty" ? [] : CANDIDATES}
        loading={mode === "loading"}
        selectable
        emptyAction={
          <Button variant="tinted" size="sm" onClick={() => setMode("data")}>
            清除筛选
          </Button>
        }
        bulkActions={(_sel, clear) => (
          <>
            <Button size="sm" variant="ghost" onClick={clear}>
              派单
            </Button>
            <Button size="sm" variant="ghost" onClick={clear}>
              导出
            </Button>
            <Button size="sm" variant="ghost" onClick={clear}>
              取消
            </Button>
          </>
        )}
      />
      <UxNotes
        items={[
          ["排序", "点击表头循环：升序 → 降序 → 不排序。未排序的列悬停时才显示箭头。"],
          ["选择", "全选框有“部分选中”状态。选中行用浅绿底，批量条用深色反白，和普通内容明显区分。"],
          ["空状态", "说明为什么空，并给一个能直接解决问题的按钮。"],
        ]}
      />
    </Spec>
  );
}

export function EmptySpec() {
  return (
    <Spec title="空状态 Empty" why="空状态是引导，不是报错。一个灰色图标、一句话说明、一个动作。">
      <EmptyState
        icon="factory"
        title="这个城市还没有工厂"
        description="添加第一家工厂后，招聘员就能开始向候选人推荐岗位。"
        action={
          <Button variant="tinted" icon={<Icon name="plus" size={16} />}>
            添加工厂
          </Button>
        }
      />
    </Spec>
  );
}

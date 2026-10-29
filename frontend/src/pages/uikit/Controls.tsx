import { useState } from "react";
import {
  Button,
  Checkbox,
  Icon,
  Input,
  RadioGroup,
  SearchField,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  Textarea,
} from "../../components/ui";
import { Spec, State, States, UxNotes } from "./Kit";

const MODULES = [
  { value: "factory", label: "工厂管理" },
  { value: "service", label: "服务岗位" },
  { value: "recruiter", label: "招聘员" },
];
const EMPLOY = [
  { value: "full", label: "全职", description: "每周 5 天，社保齐全" },
  { value: "part", label: "兼职", description: "按小时结算" },
];

export function ButtonSpec() {
  const [saving, setSaving] = useState(false);
  return (
    <Spec title="按钮 Button" why="胶囊形，44px 高。主按钮一屏只放一个；次按钮用灰色填充而不是描边，视觉更轻。" wide>
      <div className="kit-variants">
        <Button>保存配置</Button>
        <Button variant="tinted" icon={<Icon name="plus" size={16} />}>
          新建工厂
        </Button>
        <Button variant="secondary">取消</Button>
        <Button variant="ghost">查看日志</Button>
        <Button variant="destructive">删除</Button>
        <Button size="sm">筛选</Button>
        <Button
          loading={saving}
          onClick={() => {
            setSaving(true);
            window.setTimeout(() => setSaving(false), 1400);
          }}
        >
          点我试试加载
        </Button>
      </div>
      <States>
        <State name="default">
          <Button>保存配置</Button>
        </State>
        <State name="hover">
          <Button className="is-hover">保存配置</Button>
        </State>
        <State name="focus-visible">
          <Button className="is-focus">保存配置</Button>
        </State>
        <State name="active">
          <Button className="is-active">保存配置</Button>
        </State>
        <State name="disabled">
          <Button disabled>保存配置</Button>
        </State>
        <State name="loading">
          <Button loading>保存配置</Button>
        </State>
      </States>
      <UxNotes
        items={[
          ["层级", "主 → 浅绿 → 灰 → 文字按钮，从“最推荐”到“最次要”。危险按钮只在确认弹窗里出现。"],
          ["加载", "保持原宽度，左侧转圈，文字保留。超过 300ms 才显示转圈，避免一闪而过。"],
          ["文案", "动词 + 对象，2–6 个字：“保存配置”“派单”。不写“确定”“提交”。"],
        ]}
      />
    </Spec>
  );
}

export function InputSpec() {
  return (
    <Spec title="输入框 Input · Textarea" why="标签在上方，提示信息在下方并预留高度，出现错误时页面不会跳动。" wide>
      <States>
        <State name="default">
          <Input id="k-in-1" label="工厂名称" placeholder="例如：富士康龙华" helperText="会显示在招聘员端" />
        </State>
        <State name="hover">
          <Input id="k-in-2" label="工厂名称" placeholder="例如：富士康龙华" className="is-hover" />
        </State>
        <State name="focus-visible">
          <Input id="k-in-3" label="工厂名称" defaultValue="富士康龙华" className="is-focus" />
        </State>
        <State name="disabled">
          <Input id="k-in-4" label="城市编码" defaultValue="SZ-0755" disabled />
        </State>
        <State name="loading">
          <Input id="k-in-5" label="地址" placeholder="正在解析地址…" loading />
        </State>
        <State name="error">
          <Input id="k-in-6" label="联系电话" required defaultValue="1380013" error="电话需为 11 位数字，当前 7 位" />
        </State>
        <State name="success">
          <Input id="k-in-7" label="工号" defaultValue="WK-10293" success="工号可用" />
        </State>
        <State name="textarea">
          <Textarea id="k-ta-1" label="岗位说明" placeholder="职责、班次、待遇" />
        </State>
      </States>
      <UxNotes
        items={[
          ["校验时机", "离开输入框时校验，不在打字过程中报错。改对后立即清除错误。"],
          ["错误文案", "说清原因和差多少：“当前 7 位”，让人不用猜。"],
          ["焦点", "谷歌蓝描边 + 4px 浅蓝光晕，焦点环立即出现，不做淡入。"],
        ]}
      />
    </Spec>
  );
}

export function SelectionSpec() {
  const [seg, setSeg] = useState("week");
  const [view, setView] = useState("list");
  const [radio, setRadio] = useState("full");
  const [q, setQ] = useState("");
  const [threshold, setThreshold] = useState(70);
  return (
    <Spec title="选择类 Select · Segmented · Radio · Checkbox" why="2–4 个互斥选项用分段控件；5 个以上用下拉；需要解释的选项用单选。" wide>
      <div className="kit-cols">
        <div className="kit-col">
          <SegmentedControl
            label="时间范围"
            value={seg}
            onChange={setSeg}
            options={[
              { value: "day", label: "今日" },
              { value: "week", label: "本周" },
              { value: "month", label: "本月" },
            ]}
          />
          <SegmentedControl
            label="视图"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "list", label: "列表" },
              { value: "board", label: "看板" },
            ]}
          />
          <SegmentedControl
            label="禁用"
            value="a"
            disabled
            onChange={() => undefined}
            options={[
              { value: "a", label: "已锁定" },
              { value: "b", label: "选项" },
            ]}
          />
          <SearchField label="搜索候选人" value={q} onChange={setQ} placeholder="搜索姓名、电话" shortcut="⌘K" />
        </div>
        <div className="kit-col">
          <Select id="k-se-1" label="所属模块" options={MODULES} placeholder="请选择模块" />
          <Select id="k-se-2" label="审批人" options={MODULES} placeholder="请选择" required error="请选择审批人后再提交" />
          <Slider label="匹配阈值" valueLabel={`${threshold}%`} min={0} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        </div>
        <div className="kit-col">
          <RadioGroup name="k-rg" legend="用工类型" options={EMPLOY} value={radio} onChange={setRadio} />
          <Checkbox id="k-cb-1" label="启用短信通知" description="候选人状态变更时发送" defaultChecked />
          <Checkbox id="k-cb-2" label="同步到企业微信" />
          <Checkbox id="k-cb-3" label="已停用的选项" disabled />
        </div>
      </div>
      <UxNotes
        items={[
          ["分段控件", "白色滑块跟手滑到选中项，280ms。键盘左右方向键切换。"],
          ["搜索", "Esc 清空；有内容时右侧出现清除按钮，没内容时显示快捷键提示。"],
          ["滑块", "数值实时显示在右上角，按住时拇指放大 15%。"],
        ]}
      />
    </Spec>
  );
}

export function ToggleSpec() {
  return (
    <Spec title="开关 Switch" why="立即生效的设置用开关；需要点“保存”才生效的用复选框。">
      <States>
        <State name="off">
          <Switch id="k-sw-1" label="自动派单" description="命中规则后分配招聘员" />
        </State>
        <State name="on">
          <Switch id="k-sw-2" label="自动派单" defaultChecked />
        </State>
        <State name="focus-visible">
          <Switch id="k-sw-3" label="键盘聚焦" defaultChecked className="is-focus" />
        </State>
        <State name="active">
          <Switch id="k-sw-4" label="按下时拉长" className="is-active" />
        </State>
        <State name="disabled">
          <Switch id="k-sw-5" label="无权限" disabled />
        </State>
      </States>
      <UxNotes items={[["手感", "按下时滑块朝移动方向拉长 4px，松手回弹到位，像真的拨动。"]]} />
    </Spec>
  );
}

import { useState, type FormEvent } from "react";
import { flowApi, FLOW_CONDITION_TYPES, type FlowEdge, type FlowNode } from "../../api/flow";
import { ApiError } from "../../api/client";
import { Alert, Button, Dialog, Input, Select, Textarea } from "@ui";

// 节点编辑弹窗。
// 「话术正文」留空时该节点走系统默认话术（send_info 会按岗位数据渲染），
// 运营可以先只搭结构、不写话术，再逐步替换。
export function NodeDialog({
  entry,
  verticalCode,
  deviceCode,
  onClose,
  onDone,
}: {
  entry: FlowNode | null;
  verticalCode: string;
  deviceCode: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [nodeKey, setNodeKey] = useState(entry?.node_key ?? "");
  const [title, setTitle] = useState(entry?.title ?? "");
  const [body, setBody] = useState(entry?.body ?? "");
  const [media, setMedia] = useState(entry?.media ?? "");
  const [isEntry, setIsEntry] = useState(entry?.is_entry ? "1" : "0");
  const [sortOrder, setSortOrder] = useState(String(entry?.sort_order ?? 100));
  const [status, setStatus] = useState(entry?.status ?? "enabled");
  const [errors, setErrors] = useState<{ nodeKey?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = { nodeKey: nodeKey.trim() ? undefined : "请填写节点标识" };
    setErrors(found);
    if (found.nodeKey) return;
    setSaving(true);
    setError(null);
    try {
      await flowApi.saveNode({
        device_code: deviceCode,
        vertical_code: verticalCode,
        node_key: nodeKey.trim(),
        title: title.trim(),
        body,
        media: media.trim(),
        is_entry: Number(isEntry),
        status,
        sort_order: Number(sortOrder) || 0,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "保存失败");
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={entry ? `编辑节点「${entry.title || entry.node_key}」` : "添加节点"}
      description="节点标识是程序认的，别随意改；话术正文留空则用系统默认。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="flow-node-form" loading={saving}>保存</Button>
        </>
      }
    >
      <form id="flow-node-form" className="mod-form" onSubmit={submit}>
        <Input
          id="fn-key"
          label="节点标识"
          placeholder="send_info / ask_interview / faq_pitch"
          helperText="字母、数字、下划线。已存在的标识会覆盖原节点。"
          value={nodeKey}
          onChange={(e) => setNodeKey(e.target.value.trim())}
          error={errors.nodeKey}
          disabled={Boolean(entry)}
          required
        />
        <Input id="fn-title" label="名称" placeholder="发岗位卡" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea
          id="fn-body"
          label="话术正文"
          placeholder="留空 = 用默认话术。可写 {{factory}} {{wage}} {{place}} {{window}} 等占位符。"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
        />
        <Input
          id="fn-media"
          label="媒体标记"
          placeholder="【图片:广州面试点】"
          helperText="跟着这条消息一起发的图/视频，客户端从 C:\\agent\\media 找同名文件"
          value={media}
          onChange={(e) => setMedia(e.target.value)}
        />
        <Select
          id="fn-entry"
          label="入口节点"
          helperText="新好友从入口节点开始。一个板块只应该有一个入口。"
          value={isEntry}
          onChange={(e) => setIsEntry(e.target.value)}
          options={[{ value: "0", label: "否" }, { value: "1", label: "是（入口）" }]}
        />
        <div className="mod-form-row">
          <Input
            id="fn-sort"
            label="排序"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <Select
            id="fn-status"
            label="状态"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[{ value: "enabled", label: "启用" }, { value: "disabled", label: "停用" }]}
          />
        </div>
        {error && <Alert tone="danger" title={error} />}
      </form>
    </Dialog>
  );
}

// 连线编辑弹窗。
// 条件值的写法直接影响命中：关键词用逗号分隔，已收集填槽位名（如 phone）。
export function EdgeDialog({
  entry,
  nodes,
  verticalCode,
  deviceCode,
  onClose,
  onDone,
}: {
  entry: FlowEdge | null;
  nodes: FlowNode[];
  verticalCode: string;
  deviceCode: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [fromNode, setFromNode] = useState(entry?.from_node ?? nodes[0]?.node_key ?? "");
  const [toNode, setToNode] = useState(entry?.to_node ?? "");
  const [conditionType, setConditionType] = useState(entry?.condition_type ?? "always");
  const [conditionValue, setConditionValue] = useState(entry?.condition_value ?? "");
  const [priority, setPriority] = useState(String(entry?.priority ?? 100));
  const [errors, setErrors] = useState<{ from?: string; to?: string; value?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hint = FLOW_CONDITION_TYPES.find((c) => c.value === conditionType)?.hint ?? "";
  const nodeOptions = nodes.map((n) => ({ value: n.node_key, label: `${n.title || n.node_key}（${n.node_key}）` }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = {
      from: fromNode ? undefined : "请选择起始节点",
      to: toNode ? undefined : "请选择目标节点",
      value: conditionType === "always" || conditionValue.trim() ? undefined : "这种条件需要填写条件值",
    };
    setErrors(found);
    if (found.from || found.to || found.value) return;
    setSaving(true);
    setError(null);
    try {
      await flowApi.saveEdge({
        device_code: deviceCode,
        vertical_code: verticalCode,
        from_node: fromNode,
        to_node: toNode,
        condition_type: conditionType,
        condition_value: conditionValue.trim(),
        priority: Number(priority) || 100,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "保存失败");
      setSaving(false);
    }
  }

  const valuePlaceholder = conditionType === "collected"
    ? "phone"
    : conditionType === "keyword"
      ? "面试,可以,行"
      : "";

  return (
    <Dialog
      open
      onClose={onClose}
      title={entry ? "编辑连线" : "添加连线"}
      description="多条条件同时命中时，优先级数字小的先生效。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" form="flow-edge-form" loading={saving}>保存</Button>
        </>
      }
    >
      <form id="flow-edge-form" className="mod-form" onSubmit={submit}>
        <Select
          id="fe-from"
          label="从哪个节点"
          value={fromNode}
          onChange={(e) => setFromNode(e.target.value)}
          options={nodeOptions}
          placeholder="请选择"
          error={errors.from}
          required
        />
        <Select
          id="fe-to"
          label="转到哪个节点"
          value={toNode}
          onChange={(e) => setToNode(e.target.value)}
          options={nodeOptions}
          placeholder="请选择"
          error={errors.to}
          required
        />
        <Select
          id="fe-type"
          label="条件类型"
          helperText={hint}
          value={conditionType}
          onChange={(e) => setConditionType(e.target.value)}
          options={FLOW_CONDITION_TYPES.map((c) => ({ value: c.value, label: c.label }))}
        />
        <Input
          id="fe-value"
          label="条件值"
          placeholder={valuePlaceholder}
          helperText={conditionType === "always" ? "无条件不需要填" : "关键词用逗号分隔"}
          value={conditionValue}
          onChange={(e) => setConditionValue(e.target.value)}
          error={errors.value}
          disabled={conditionType === "always"}
        />
        <Input
          id="fe-priority"
          label="优先级"
          helperText="数字小的先判断，默认 100"
          value={priority}
          onChange={(e) => setPriority(e.target.value.replace(/[^0-9]/g, ""))}
        />
        {error && <Alert tone="danger" title={error} />}
      </form>
    </Dialog>
  );
}

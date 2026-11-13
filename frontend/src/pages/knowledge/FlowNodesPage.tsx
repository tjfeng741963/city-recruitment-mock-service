import { useCallback, useEffect, useState } from "react";
import {
  flowApi,
  conditionLabel,
  type FlowEdge,
  type FlowNode,
} from "../../api/flow";
import { devicesApi } from "../../api/admin";
import { Alert, Button, DataTable, EmptyState, Icon, Select, useFeedback, type Column } from "@ui";
import { ModuleTabs, errorText } from "./shared";
import { NodeDialog, EdgeDialog } from "./FlowNodeDialogs";

// DataTable 要求行带 string id；actions 是虚拟列，用 never 让它成为合法 key
// （同 DeviceScriptsPage 的写法）。
type NodeRow = Omit<FlowNode, "id"> & { id: string; actions?: never };
type EdgeRow = Omit<FlowEdge, "id"> & { id: string; actions?: never };

// 节点配置台：一个板块一套流程，设备可单独覆盖。
// 设计上刻意用表格而不是画布——先用两三周确认节点模型是否够用，
// 再决定要不要投 3-5 天做拖拽图。
export function FlowNodesPage() {
  const { toast, confirm } = useFeedback();
  const [verticalCode, setVerticalCode] = useState("factory");
  const [deviceCode, setDeviceCode] = useState("");
  const [verticals, setVerticals] = useState<Array<{ code: string; name: string }>>([]);
  const [devices, setDevices] = useState<Array<{ code: string; name: string }>>([]);
  const [nodes, setNodes] = useState<FlowNode[] | null>(null);
  const [edges, setEdges] = useState<FlowEdge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [editingNode, setEditingNode] = useState<null | "new" | FlowNode>(null);
  const [editingEdge, setEditingEdge] = useState<null | "new" | FlowEdge>(null);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    devicesApi
      .verticals()
      .then((res) => {
        if (alive) setVerticals((res.items ?? []).map((v) => ({ code: String(v.code), name: String(v.name) })));
      })
      .catch(() => { /* 拉不到板块时仍按默认 factory 工作 */ });
    // 设备列表用于「设备覆盖」下拉；拉不到就只有「板块通用」一项，不影响主流程
    devicesApi
      .list()
      .then((res) => {
        if (alive) setDevices((res.items ?? []).map((d) => ({ code: d.device_code, name: d.name })));
      })
      .catch(() => { /* 忽略 */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    setNodes(null);
    setEdges(null);
    const scope = { vertical_code: verticalCode, device_code: deviceCode || undefined };
    Promise.all([flowApi.nodes(scope), flowApi.edges(scope)])
      .then(([n, e]) => {
        if (!alive) return;
        setNodes(n.items);
        setEdges(e.items);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setNodes([]);
        setEdges([]);
        setError(errorText(err, "流程节点加载失败"));
      });
    return () => { alive = false; };
  }, [verticalCode, deviceCode, version]);

  async function removeNode(row: NodeRow) {
    const ok = await confirm({
      title: `删除节点「${row.title || row.node_key}」？`,
      description: "还有连线指向它时不允许删除，请先删线。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await flowApi.removeNode(Number(row.id));
      toast("已删除", "success");
      reload();
    } catch (err) {
      toast(errorText(err, "删除失败"), "danger");
    }
  }

  async function removeEdge(row: EdgeRow) {
    const ok = await confirm({
      title: "删除这条连线？",
      description: `${row.from_node} → ${row.to_node} 删掉后，这条路径不再生效。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await flowApi.removeEdge(Number(row.id));
      toast("已删除", "success");
      reload();
    } catch (err) {
      toast(errorText(err, "删除失败"), "danger");
    }
  }

  const nodeColumns: Column<NodeRow>[] = [
    {
      key: "node_key",
      header: "节点标识",
      width: "170px",
      render: (r) => (
        <span className="kn-question">
          {r.node_key}
          {r.is_entry ? <span className="kn-muted">（入口）</span> : null}
        </span>
      ),
    },
    { key: "title", header: "名称", width: "130px", render: (r) => r.title || <span className="kn-muted">—</span> },
    {
      key: "body",
      header: "话术正文",
      render: (r) => (r.body
        ? <span title={r.body}>{r.body.slice(0, 40)}{r.body.length > 40 ? "…" : ""}</span>
        : <span className="kn-muted">用默认话术</span>),
    },
    {
      key: "actions",
      header: "操作",
      width: "120px",
      render: (r) => (
        <span className="kn-actions">
          <Button size="sm" variant="ghost" onClick={() => setEditingNode({ ...r, id: Number(r.id) })}>编辑</Button>
          <Button size="sm" variant="ghost" onClick={() => removeNode(r)}>删除</Button>
        </span>
      ),
    },
  ];

  const edgeColumns: Column<EdgeRow>[] = [
    { key: "from_node", header: "从", width: "130px", render: (r) => r.from_node },
    { key: "to_node", header: "到", width: "130px", render: (r) => r.to_node },
    { key: "condition_type", header: "条件", width: "90px", render: (r) => conditionLabel(r.condition_type) },
    {
      key: "condition_value",
      header: "条件值",
      render: (r) => (r.condition_value ? <code className="kn-ph">{r.condition_value}</code> : <span className="kn-muted">—</span>),
    },
    { key: "priority", header: "优先级", width: "80px", render: (r) => String(r.priority) },
    {
      key: "actions",
      header: "操作",
      width: "80px",
      render: (r) => <Button size="sm" variant="ghost" onClick={() => removeEdge(r)}>删除</Button>,
    },
  ];

  const verticalOptions = (verticals.length
    ? verticals
    : [{ code: "factory", name: "工厂" }, { code: "subway", name: "地铁安检" }]
  ).map((v) => ({ value: v.code, label: v.name }));

  return (
    <div className="mod-page">
      <div className="kn-head">
        <div>
          <h2 className="mod-title">流程节点</h2>
          <p className="kn-sub">一个板块一套流程。节点决定「说什么」，连线决定「什么条件下转到哪」。改完约 30 秒生效。</p>
        </div>
        <ModuleTabs active="flow-nodes" />
      </div>

      <div className="kn-toolbar">
        <div className="kn-toolbar-filters">
          <Select
            id="flow-vertical"
            label="板块"
            value={verticalCode}
            onChange={(e) => setVerticalCode(e.target.value)}
            options={verticalOptions}
          />
          <Select
            id="flow-device"
            label="设备覆盖"
            value={deviceCode}
            onChange={(e) => setDeviceCode(e.target.value)}
            options={[{ value: "", label: "板块通用（所有设备）" }, ...devices.map((d) => ({ value: d.code, label: d.name || d.code }))]}
            helperText="选具体设备时，同标识的节点以设备那份为准"
          />
        </div>
        <div className="kn-toolbar-actions">
          <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setEditingEdge("new")}>添加连线</Button>
          <Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setEditingNode("new")}>添加节点</Button>
        </div>
      </div>

      {error && <Alert tone="danger" title="加载失败">{error}</Alert>}

      <h3 className="kn-section-title">节点</h3>
      {nodes !== null && nodes.length === 0 && !error ? (
        <EmptyState
          icon="info"
          title="这个板块还没有节点"
          description="跑一次迁移会预置工厂/地铁两套默认节点，也可以点「添加节点」自己搭。"
          action={<Button onClick={() => setEditingNode("new")}>添加第一个节点</Button>}
        />
      ) : (
        <DataTable
          key={`nodes-${verticalCode}-${deviceCode}-${version}`}
          caption="流程节点"
          columns={nodeColumns}
          rows={(nodes ?? []).map((n) => ({ ...n, id: String(n.id) }))}
          loading={nodes === null}
        />
      )}

      <h3 className="kn-section-title">连线</h3>
      {edges !== null && edges.length === 0 && !error ? (
        <EmptyState
          icon="info"
          title="还没有连线"
          description="没有连线时流程会退回内置的五阶段逻辑，不会卡住。"
          action={<Button onClick={() => setEditingEdge("new")}>添加第一条连线</Button>}
        />
      ) : (
        <DataTable
          key={`edges-${verticalCode}-${deviceCode}-${version}`}
          caption="流程连线"
          columns={edgeColumns}
          rows={(edges ?? []).map((e) => ({ ...e, id: String(e.id) }))}
          loading={edges === null}
        />
      )}

      {editingNode && (
        <NodeDialog
          key={editingNode === "new" ? "new-node" : `edit-node-${editingNode.id}`}
          entry={editingNode === "new" ? null : editingNode}
          verticalCode={verticalCode}
          deviceCode={deviceCode}
          onClose={() => setEditingNode(null)}
          onDone={() => { setEditingNode(null); reload(); }}
        />
      )}
      {editingEdge && (
        <EdgeDialog
          key={editingEdge === "new" ? "new-edge" : `edit-edge-${editingEdge.id}`}
          entry={editingEdge === "new" ? null : editingEdge}
          nodes={nodes ?? []}
          verticalCode={verticalCode}
          deviceCode={deviceCode}
          onClose={() => setEditingEdge(null)}
          onDone={() => { setEditingEdge(null); reload(); }}
        />
      )}
    </div>
  );
}

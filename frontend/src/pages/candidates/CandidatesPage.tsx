import { useMemo, useState } from "react";
import { Badge, Button, DataTable, FilterBar, Icon, Input, Pagination, Select, Tabs, useFeedback, type Column } from "@ui";
import { candidatesApi, type Candidate, type CandidateEventType } from "../../api/candidates";
import { ChatDialog, MarkDialog, STATUS_LABEL } from "./CandidateDialogs";
import { LoadError, ModHead, PageSizeSelect, downloadCsv, useLoader, useMyDevices } from "./shared";

const TABS: Array<{ value: CandidateEventType; label: string }> = [
  { value: "invited", label: "报名成功" },
  { value: "disqualified", label: "不符合" },
  { value: "checked_in", label: "已签到" },
];

type Row = Omit<Candidate, "id"> & { id: string; raw: Candidate; device: string; region: string; ops: string };

function buildColumns(tab: CandidateEventType, onChat: (c: Candidate) => void, onMark: (c: Candidate) => void): Column<Row>[] {
  const dash = (v: string) => v || "—";
  const cols: Array<Column<Row> | false> = [
    { key: "device", header: "招聘经理" },
    {
      key: "name",
      header: "求职者",
      render: (r) => (
        <span className="cd-person">
          <strong>{r.name || r.nickname || "—"}</strong>
          {r.name && r.nickname && <small>{r.nickname}</small>}
        </span>
      ),
    },
    { key: "phone", header: "电话", render: (r) => <span className="ui-num">{dash(r.phone)}</span> },
    { key: "event_at", header: "事件时间", sortable: true, render: (r) => <span className="ui-num" title={r.event_at}>{r.event_at ? r.event_at.slice(5, 16) : "—"}</span> },
    tab === "invited" && { key: "interview_date", header: "面试日期", sortable: true, render: (r) => <span className="ui-num">{dash(r.interview_date)}</span> },
    tab === "invited" && { key: "factory_name", header: "面试工厂", render: (r) => dash(r.factory_name) },
    tab === "invited" && { key: "region", header: "城市/区县", render: (r) => dash(r.region) },
    tab === "invited" && {
      key: "remind_count",
      header: "提醒",
      render: (r) => (r.remind_count > 0 ? <Badge tone="success">已提醒 {r.remind_count} 次</Badge> : <Badge>未提醒</Badge>),
    },
    tab === "disqualified" && { key: "disqualified_reason", header: "不符合原因", render: (r) => dash(r.disqualified_reason) },
    { key: "status", header: "当前标记", render: (r) => <Badge tone={r.status === "disqualified" ? "warning" : "accent"}>{STATUS_LABEL[r.status] ?? r.status ?? "—"}</Badge> },
    {
      key: "ops",
      header: "操作",
      render: (r) => (
        <span className="cd-row-ops">
          <Button size="sm" variant="ghost" onClick={() => onChat(r.raw)}>对话记录</Button>
          <Button size="sm" variant="ghost" onClick={() => onMark(r.raw)}>标记</Button>
        </span>
      ),
    },
  ];
  return cols.filter((c): c is Column<Row> => Boolean(c));
}

export function CandidatesPage() {
  const { toast } = useFeedback();
  const { devices, names } = useMyDevices();
  const [tab, setTab] = useState<CandidateEventType>("invited");
  const [device, setDevice] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [interviewDate, setInterviewDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [chat, setChat] = useState<Candidate | null>(null);
  const [marking, setMarking] = useState<Candidate[] | null>(null);

  const interview = tab === "invited" ? interviewDate : "";
  const { data, error, loading, reload } = useLoader(
    () => candidatesApi.list({ event_type: tab, page, page_size: pageSize, device_code: device, event_date: eventDate, interview_date: interview }),
    [tab, page, pageSize, device, eventDate, interview],
  );
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const rows: Row[] = useMemo(
    () =>
      items.map((c) => ({
        ...c,
        id: String(c.id),
        raw: c,
        device: names.get(c.device_code) ?? (c.device_code || "—"),
        region: [c.city, c.district].filter(Boolean).join("/"),
        ops: "",
      })),
    [items, names],
  );
  const columns = useMemo(() => buildColumns(tab, setChat, (c) => setMarking([c])), [tab]);

  function resetPage<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setPage(1);
    };
  }

  function exportCsv() {
    const head = ["招聘经理", "姓名", "电话", "面试日期", "面试工厂", "城市", "区县", "事件时间"];
    downloadCsv(`候选人_${TABS.find((t) => t.value === tab)?.label ?? tab}.csv`, [
      head,
      ...rows.map((r) => [r.device, r.name, r.phone, r.interview_date, r.factory_name, r.city, r.district, r.event_at]),
    ]);
  }

  const hasFilter = Boolean(device || eventDate || interview);

  return (
    <div className="mod-page">
      <ModHead
        title="候选人"
        active="/candidates"
        actions={<Button size="sm" variant="secondary" icon={<Icon name="download" size={14} />} disabled={rows.length === 0} onClick={exportCsv}>导出本页</Button>}
      />
      <Tabs label="候选人类型" items={TABS.map((t) => ({ ...t, count: t.value === tab && data ? total : undefined }))} value={tab} onChange={(v) => resetPage(setTab)(v as CandidateEventType)} />
      <FilterBar
        result={data ? `共 ${total} 人` : undefined}
        onClear={hasFilter ? () => { setDevice(""); setEventDate(""); setInterviewDate(""); setPage(1); } : undefined}
      >
        <Select
          id="cd-device"
          label="招聘经理"
          value={device}
          onChange={(e) => resetPage(setDevice)(e.target.value)}
          options={[{ value: "", label: "全部" }, ...devices.map((d) => ({ value: d.device_code, label: d.name || d.device_code }))]}
        />
        <Input id="cd-event-date" type="date" label="事件日期" value={eventDate} onChange={(e) => resetPage(setEventDate)(e.target.value)} />
        {tab === "invited" && (
          <Input id="cd-interview-date" type="date" label="面试日期" value={interviewDate} onChange={(e) => resetPage(setInterviewDate)(e.target.value)} />
        )}
      </FilterBar>

      {error && <LoadError message={error} onRetry={reload} />}

      <DataTable<Row>
        key={`${tab}-${page}-${pageSize}`}
        caption="候选人列表"
        columns={columns}
        rows={rows}
        loading={loading && !data}
        selectable
        bulkActions={(ids, clear) => (
          <Button size="sm" onClick={() => { setMarking(rows.filter((r) => ids.includes(r.id)).map((r) => r.raw)); clear(); }}>批量标记</Button>
        )}
        emptyAction={hasFilter ? undefined : <span className="cd-muted">AI 识别到报名、签到或不符合时，会自动记到这里。</span>}
      />

      {total > 0 && (
        <div className="cd-pager">
          <PageSizeSelect id="cd-page-size" value={pageSize} onChange={resetPage(setPageSize)} />
          <Pagination page={page} total={total} pageSize={pageSize} onChange={setPage} />
        </div>
      )}

      {chat && <ChatDialog candidate={chat} onClose={() => setChat(null)} />}
      {marking && (
        <MarkDialog
          targets={marking}
          onClose={() => setMarking(null)}
          onDone={(status, failed) => {
            const ok = marking.length - failed;
            toast(failed ? `已标记 ${ok} 人，${failed} 人没标上` : `已标记为「${STATUS_LABEL[status] ?? status}」`, failed ? "warning" : "success");
            setMarking(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * 为编译版候选人表格补列，不修改压缩 bundle。
 *
 * 客户在 /candidates 页要看到 OA 的十个字段（docs/会议对齐-OA字段与邀约流程.md 第一节）：
 * 归属账号、客户微信昵称、厂名、面试时间、客户真名、手机号码、省/市/区、客户状态标签、
 * 提醒到场按钮、聊天记录入口。
 *
 * 原表只有：设备 / 昵称 / 姓名 / 电话 / 事件时间 / 面试日期 / 面试工厂 / 城市区县 /
 * 操作 / 提醒状态 / 记录时间。缺的四项都在接口里已经有值，只是没有列：
 *   - account        归属账号（由候选人查询 join bridge_devices.account_id）
 *   - interview_time 面试时间（原表只显示日期）
 *   - province       省（原表只有城市/区县）
 *   - status         客户状态标签（原表只有顶部 tab 过滤，行内没有标签）
 * 加上「提醒到场」按钮，走 POST /api/v1/agent/candidates/:id/remind。
 */

/** 客户状态 → 页面标签。未知状态原样显示，不吞信息。 */
export const STATUS_LABELS = {
  invited: "报名成功",
  disqualified: "不符合",
  checked_in: "已签到",
  pending_invite: "待邀约",
  communicating: "沟通中",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || "-";
}

/** 面试时间：日期 + 时间；只有日期时只显示日期。 */
export function interviewMoment(row) {
  const date = String(row?.interview_date || "").trim();
  const time = String(row?.interview_time || "").trim();
  if (!date) return "-";
  return time ? `${date} ${time}` : date;
}

/** 省/市/区：逐级拼接，缺哪一级就跳过。 */
export function regionText(row) {
  const parts = [row?.province, row?.city, row?.district]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join("/") : "-";
}

/** 「提醒到场」点击处理：调接口并把结果反馈给操作人。 */
async function remindCandidate(row) {
  const token = localStorage.getItem("token") || "";
  const id = row?.id;
  if (!id) return;
  if (!window.confirm(`给「${row.nickname || row.name || "该候选人"}」发一条面试提醒？`)) return;
  try {
    const response = await fetch(`/api/v1/agent/candidates/${id}/remind`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      window.alert(body?.detail || "提醒发送失败");
      return;
    }
    window.alert(`已发送：${body?.content ?? ""}`);
  } catch (error) {
    window.alert(`提醒发送失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 人工标记「已签到 / 不符合」。
 *
 * 为什么必须有这个按钮：2026-11-16 把 checked_in 从默认事件规则里删掉了
 * （面试通知里带「请准时到本公司面试」，一发通知就把客户标成已签到，
 * 而他第二天才来）。删掉之后，这个编译版页面**没有任何打标记的入口**，
 * 「已签到」标签页会永远为空。签到是客户到场的事实，只能人来确认。
 */
async function markCandidate(row, status, label) {
  const token = localStorage.getItem("token") || "";
  const id = row?.id;
  if (!id) return;
  if (!window.confirm(`把「${row.nickname || row.name || "该候选人"}」标记为「${label}」？`)) return;
  try {
    const response = await fetch(`/api/v1/agent/candidates/${id}/mark`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      window.alert(body?.detail || "标记失败");
      return;
    }
    window.alert(`已标记为「${label}」，刷新后生效`);
  } catch (error) {
    window.alert(`标记失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 在候选人表格上补齐 OA 字段列（原生 Element Plus 列，不动 bundle）。 */
export function addRegistrationColumn(node, createVNode, withCtx) {
  if (!node || typeof node !== "object") return;
  if (node.type?.name === "ElTable" && typeof node.children?.default === "function") {
    const original = node.children.default;
    node.children.default = withCtx((...args) => {
      const columns = original(...args);
      if (!Array.isArray(columns)) return columns;
      // 去重按 prop 或 key：新增列有的只有 key（formatter 列没有 prop），
      // 只看 prop 会让补丁跑第二遍时重复加列。
      const existing = new Set(
        columns.flatMap((column) => [column?.props?.prop, column?.props?.key, column?.key]).filter(Boolean),
      );
      const labels = new Set(columns.map(column => column?.props?.label));
      const equivalents = { 'candidate-account': ['归属账号'], 'candidate-interview-time': ['面试时间'],
        'candidate-region': ['省市区', '省/市/区'], 'candidate-registration': ['登记摘要'],
        'candidate-status': ['客户状态'], 'candidate-remind': ['提醒到场'], 'candidate-checkin': ['签到'] };
      for (const [key, names] of Object.entries(equivalents)) {
        if (names.some(name => labels.has(name))) existing.add(key);
      }
      const columnType = columns.find((column) => column?.type?.name === "ElTableColumn")?.type;
      if (!columnType) return columns;

      const added = [];
      const makeColumn = (key, props, slot) => createVNode(columnType, { key, ...props }, slot);
      const actionIndex = columns.findIndex((column) => column?.props?.fixed === "right");
      const insertAt = actionIndex < 0 ? columns.length : actionIndex;

      // 归属账号：紧跟在「设备」后面，客户说的「归属账号」就是这个账号
      if (!existing.has("candidate-account")) {
        const account = makeColumn("candidate-account", { prop: "account", label: "归属账号", "min-width": 140, "show-overflow-tooltip": true });
        columns.splice(1, 0, account);
        existing.add("candidate-account");
      }
      // 这些插在操作列之前
      if (!existing.has("candidate-interview-time")) {
        added.push(makeColumn("candidate-interview-time", {
          label: "面试时间", "min-width": 150,
          formatter: (row) => interviewMoment(row),
        }));
      }
      if (!existing.has("candidate-region")) {
        added.push(makeColumn("candidate-region", {
          label: "省/市/区", "min-width": 160,
          formatter: (row) => regionText(row),
        }));
      }
      if (!existing.has("candidate-registration")) {
        added.push(makeColumn("candidate-registration", {
          prop: "registration_text", label: "登记摘要", "min-width": 260, "show-overflow-tooltip": true,
        }));
      }
      if (!existing.has("candidate-status")) {
        added.push(makeColumn("candidate-status", {
          label: "客户状态", width: 100,
          formatter: (row) => statusLabel(row?.status),
        }));
      }
      if (!existing.has("candidate-remind")) {
        added.push(makeColumn("candidate-remind", { label: "提醒到场", width: 100 }, {
          default: withCtx(({ row }) => [
            createVNode("button", {
              type: "button",
              class: "candidate-remind-btn",
              onClick: () => remindCandidate(row),
            }, "提醒到场"),
          ]),
        }));
      }
      // 已签到：唯一的人工入口（自动判定已删除，理由见 markCandidate 注释）
      if (!existing.has("candidate-checkin")) {
        added.push(makeColumn("candidate-checkin", { label: "签到", width: 90 }, {
          default: withCtx(({ row }) => [
            createVNode("button", {
              type: "button",
              class: "candidate-checkin-btn",
              onClick: () => markCandidate(row, "checked_in", "已签到"),
            }, "标记签到"),
          ]),
        }));
      }

      if (!added.length) return columns;
      return [...columns.slice(0, insertAt), ...added, ...columns.slice(insertAt)];
    });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) addRegistrationColumn(child, createVNode, withCtx);
  }
}

/** 为编译版候选人表格增加原生 Element Plus 列，不修改压缩 bundle。 */
export function addRegistrationColumn(node, createVNode, withCtx) {
  if (!node || typeof node !== "object") return;
  if (node.type?.name === "ElTable" && typeof node.children?.default === "function") {
    const original = node.children.default;
    node.children.default = withCtx((...args) => {
      const columns = original(...args);
      if (!Array.isArray(columns) || columns.some(column => column?.props?.prop === "registration_text")) return columns;
      const columnType = columns.find(column => column?.type?.name === "ElTableColumn")?.type;
      if (!columnType) return columns;
      const registration = createVNode(columnType, {
        key: "candidate-registration", prop: "registration_text", label: "登记摘要",
        "min-width": 260, "show-overflow-tooltip": true,
      });
      const actionIndex = columns.findIndex(column => column?.props?.fixed === "right");
      const index = actionIndex < 0 ? columns.length : actionIndex;
      return [...columns.slice(0, index), registration, ...columns.slice(index)];
    });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) addRegistrationColumn(child, createVNode, withCtx);
  }
}

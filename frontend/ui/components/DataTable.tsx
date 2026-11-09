import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Skeleton, EmptyState } from "./Display";

export interface Column<T> {
  key: keyof T & string;
  header: string;
  align?: "left" | "right";
  sortable?: boolean;
  width?: string;
  render?: (row: T) => ReactNode;
}

export interface DataTableProps<T extends { id: string }> {
  columns: Column<T>[];
  rows: T[];
  caption: string;
  loading?: boolean;
  selectable?: boolean;
  bulkActions?: (selected: string[], clear: () => void) => ReactNode;
  emptyAction?: ReactNode;
}

type Sort = { key: string; dir: "asc" | "desc" } | null;

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  caption,
  loading,
  selectable,
  bulkActions,
  emptyAction,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<Sort>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => {
      const x = a[sort.key as keyof T];
      const y = b[sort.key as keyof T];
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "zh");
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, sort]);

  const allChecked = rows.length > 0 && selected.length === rows.length;
  const someChecked = selected.length > 0 && !allChecked;

  function toggleSort(key: string) {
    setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));
  }

  function toggleRow(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  return (
    <div className="ui-table-wrap">
      {selectable && selected.length > 0 && bulkActions && (
        <div className="ui-table-bulk" role="region" aria-label="批量操作">
          <span className="ui-num">已选 {selected.length} 项</span>
          <div className="ui-table-bulk-actions">{bulkActions(selected, () => setSelected([]))}</div>
        </div>
      )}
      <div className="ui-table-scroll">
        <table className="ui-table">
          <caption className="ui-sr-only">{caption}</caption>
          <thead>
            <tr>
              {selectable && (
                <th className="ui-table-check">
                  <input
                    type="checkbox"
                    aria-label="全选"
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = someChecked;
                    }}
                    onChange={() => setSelected(allChecked ? [] : rows.map((r) => r.id))}
                  />
                </th>
              )}
              {columns.map((c) => {
                const dir = sort?.key === c.key ? sort.dir : null;
                return (
                  <th
                    key={c.key}
                    style={{ width: c.width, textAlign: c.align }}
                    aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
                  >
                    {c.sortable ? (
                      <button type="button" className={`ui-th-sort ${dir ? "is-sorted" : ""}`} onClick={() => toggleSort(c.key)}>
                        {c.header}
                        <Icon name="chevronDown" size={12} className={`ui-th-caret ${dir === "asc" ? "is-up" : ""}`} />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 4 }, (_, i) => (
                <tr key={`sk-${i}`} aria-hidden="true">
                  {selectable && <td />}
                  {columns.map((c) => (
                    <td key={c.key}>
                      <Skeleton width={c.align === "right" ? 48 : "70%"} />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading &&
              sorted.map((row) => {
                const isSel = selected.includes(row.id);
                return (
                  <tr key={row.id} className={isSel ? "is-selected" : undefined}>
                    {selectable && (
                      <td className="ui-table-check">
                        <input type="checkbox" aria-label={`选择 ${row.id}`} checked={isSel} onChange={() => toggleRow(row.id)} />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.key} style={{ textAlign: c.align }} className={c.align === "right" ? "ui-num" : undefined}>
                        {c.render ? c.render(row) : String(row[c.key])}
                      </td>
                    ))}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && (
        <EmptyState icon="search" title="没有符合条件的记录" description="换个关键词，或清除筛选条件后再试。" action={emptyAction} />
      )}
    </div>
  );
}

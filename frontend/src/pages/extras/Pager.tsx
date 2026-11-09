import { Pagination, Select } from "@ui";
import { PAGE_SIZES } from "./model";

// Pagination has no page-size control, so it is paired with a Select here.
export function Pager({
  id,
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  id: string;
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  if (total === 0) return null;
  return (
    <div className="ex-pager">
      <div className="ex-pager-size">
        <Select
          id={id}
          aria-label="每页条数"
          value={String(pageSize)}
          onChange={(e) => onPageSize(Number(e.target.value))}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: `每页 ${n} 条` }))}
        />
      </div>
      <Pagination page={page} pageSize={pageSize} total={total} onChange={onPage} />
    </div>
  );
}

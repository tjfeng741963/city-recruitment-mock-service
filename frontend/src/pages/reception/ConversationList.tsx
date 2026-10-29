import { useMemo, useState } from "react";
import { Avatar, SearchField } from "@ui";
import { formatWait, sortGroup, type GroupKey, type TriagedConversation } from "./triage";

const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: "waiting", label: "等你回" },
  { key: "active", label: "AI 在聊" },
  { key: "ended", label: "已结束" },
];

function matches(item: TriagedConversation, term: string): boolean {
  if (!term) return true;
  const { nickname, city, district } = item.conversation;
  return [nickname, city, district].some((v) => v.toLowerCase().includes(term));
}

function Row({ item, selected, onSelect }: { item: TriagedConversation; selected: boolean; onSelect: () => void }) {
  const { conversation: c } = item;
  const name = c.nickname || `候选人 ${c.customer_id}`;
  return (
    <li>
      <button type="button" className={`rc-row ${selected ? "is-selected" : ""}`} aria-current={selected || undefined} onClick={onSelect}>
        <Avatar name={name} size={30} />
        <span className="rc-row-text">
          <span className="rc-row-title">
            {name}
            {c.city && <span className="rc-row-city">{c.city}</span>}
          </span>
          <span className="rc-row-sub">{c.last_msg || "还没有消息"}</span>
        </span>
        <span className="rc-row-meta">
          {item.waitingMinutes !== null ? (
            <span className="rc-wait ui-num">等了 {formatWait(item.waitingMinutes)}</span>
          ) : (
            c.takeover === 1 && <span className="rc-chip">你在接</span>
          )}
          {c.unread > 0 && <span className="rc-unread ui-num" aria-label={`${c.unread} 条未读`}>{c.unread}</span>}
        </span>
      </button>
    </li>
  );
}

export function ConversationList({
  items,
  selectedKey,
  onSelect,
}: {
  items: TriagedConversation[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [showEnded, setShowEnded] = useState(false);
  const term = query.trim().toLowerCase();
  const filtered = useMemo(() => items.filter((item) => matches(item, term)), [items, term]);

  return (
    <nav className="rc-list" aria-label="会话列表">
      <div className="rc-list-search">
        <SearchField value={query} onChange={setQuery} label="搜索昵称或城市" placeholder="搜索昵称 / 城市" />
      </div>
      <div className="rc-list-scroll">
        {GROUPS.map(({ key, label }) => {
          const group = sortGroup(filtered, key);
          if (key === "waiting" && group.length === 0) {
            return (
              <p key={key} className="rc-group-empty">
                {term ? "没有匹配的人在等你" : "没有人在等你"}
              </p>
            );
          }
          if (group.length === 0) return null;
          const collapsed = key === "ended" && !showEnded && !term;
          return (
            <section key={key} className={`rc-group is-${key}`} aria-label={label}>
              <h2 className="rc-group-head">
                {key === "ended" ? (
                  <button type="button" className="rc-group-toggle" aria-expanded={!collapsed} onClick={() => setShowEnded((v) => !v)}>
                    {label} <span className="ui-num">{group.length}</span>
                  </button>
                ) : (
                  <>
                    {label} <span className="ui-num">{group.length}</span>
                  </>
                )}
              </h2>
              {!collapsed && (
                <ul>
                  {group.map((item) => (
                    <Row key={item.key} item={item} selected={item.key === selectedKey} onSelect={() => onSelect(item.key)} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </nav>
  );
}

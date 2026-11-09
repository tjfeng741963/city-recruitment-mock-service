import { Avatar, Badge, EmptyState, Reveal, RevealItem, Skeleton } from "@ui";
import type { MobileConversation } from "../../../api/extras";
import { displayName, preview, shortTime, statusLabel, statusOf } from "./model";

function Row({ c, onOpen }: { c: MobileConversation; onOpen: (c: MobileConversation) => void }) {
  const name = displayName(c);
  const status = statusLabel(c);
  const showInterview = Boolean(c.interview_date) && statusOf(c) === "invited";
  const remark = c.remark && c.remark !== name ? c.remark : "";
  return (
    <button type="button" className="mx-conv" onClick={() => onOpen(c)}>
      <span className="mx-conv-avatar">
        <Avatar name={name} size={44} />
        {c.unread > 0 && !c.is_old_friend && <span className="mx-unread ui-num">{c.unread > 99 ? "99+" : c.unread}</span>}
      </span>
      <span className="mx-conv-body">
        <span className="mx-conv-top">
          <span className="mx-conv-name">
            {name}
            {c.name && c.nickname && <span className="mx-conv-nick">{c.nickname}</span>}
          </span>
          <time className="mx-conv-time ui-num">{showInterview ? `面试 ${String(c.interview_date).slice(5, 10)}` : shortTime(c.last_msg_at)}</time>
        </span>
        <span className="mx-conv-tags">
          <Badge tone={status.tone}>{status.label}</Badge>
          <Badge tone={c.takeover ? "accent" : "neutral"}>{c.takeover ? "人工" : "AI"}</Badge>
          {c.is_old_friend && <Badge>老友</Badge>}
          {remark && <span className="mx-conv-remark">{remark}</span>}
        </span>
        <span className="mx-conv-msg">{preview(c.last_msg)}</span>
      </span>
    </button>
  );
}

export function MobileConversationList({
  loading,
  hasDevice,
  filtered,
  items,
  onOpen,
}: {
  loading: boolean;
  hasDevice: boolean;
  filtered: boolean;
  items: MobileConversation[];
  onOpen: (c: MobileConversation) => void;
}) {
  if (loading) {
    return (
      <div className="mx-scroll" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="mx-conv is-skeleton">
            <Skeleton width={44} height={44} round />
            <span className="mx-conv-body">
              <Skeleton width="40%" />
              <Skeleton width="80%" />
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (!hasDevice) {
    return <EmptyState icon="device" title="还没有分配给你的微信号" description="请联系主账号在「微信号」里把号分给你。" />;
  }
  if (!items.length) {
    return (
      <EmptyState
        icon="chat"
        title={filtered ? "没有符合条件的会话" : "这段时间还没有会话"}
        description={filtered ? "换个状态，或把日期范围放宽一些。" : "应聘者发来消息后会出现在这里。"}
      />
    );
  }
  return (
    <Reveal as="ul" className="mx-scroll mx-conv-list">
      {items.map((c) => (
        <RevealItem as="li" key={`${c.device_code}:${c.customer_id}`}>
          <Row c={c} onOpen={onOpen} />
        </RevealItem>
      ))}
    </Reveal>
  );
}

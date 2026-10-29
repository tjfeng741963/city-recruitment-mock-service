import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { Badge, Button, Icon, Menu, Skeleton, useFeedback, type MenuItem } from "@ui";
import { agentApi } from "../../../api/agent";
import { mobileApi, type MobileConversation, type MobileDevice, type MobileMessage } from "../../../api/extras";
import { errorText } from "../model";
import { displayName, isFromCustomer, messageBody, shortTime, statusLabel } from "./model";
import { sendErrorText, sendManualReply, useThread } from "./useThread";

type UploadKind = "image" | "video";

function Bubble({ m }: { m: MobileMessage }) {
  const body = messageBody(m);
  const side = isFromCustomer(m) ? "is-in" : "is-out";
  return (
    <div className={`mx-msg ${side} ${m.status === "failed" ? "is-failed" : ""}`}>
      <div className="mx-bubble">
        {body.kind === "image" && (
          <a href={body.url} target="_blank" rel="noopener noreferrer">
            <img src={body.url} alt="图片消息" className="mx-media" loading="lazy" />
          </a>
        )}
        {body.kind === "video" && <video src={body.url} controls className="mx-media" />}
        {body.kind === "file" && (
          <a href={body.url} target="_blank" rel="noopener noreferrer" className="mx-file">
            <Icon name="link" size={14} /> 附件
          </a>
        )}
        {body.kind === "text" && <p className="mx-text">{body.text}</p>}
        {m.status === "failed" && <span className="mx-flag">没发出去（AI 异常）</span>}
        {m.dedup_original && <span className="mx-flag">原文：{m.dedup_original}</span>}
      </div>
      <time className="mx-time ui-num">{shortTime(m.created_at)}</time>
    </div>
  );
}

export function MobileChatDetail({
  device,
  conversation,
  onBack,
  onUpdated,
}: {
  device: MobileDevice;
  conversation: MobileConversation;
  onBack: () => void;
  onUpdated: () => void;
}) {
  const { toast, confirm } = useFeedback();
  const { messages, error, pull } = useThread(device.device_code, conversation.customer_id);
  const [conv, setConv] = useState(conversation);
  const [takeover, setTakeover] = useState(conversation.takeover === 1);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [uploadKind, setUploadKind] = useState<UploadKind>("image");
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const name = displayName(conv);
  const status = statusLabel(conv);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages?.length]);

  async function deliver(content: string) {
    setSending(true);
    setSendError(null);
    try {
      await sendManualReply(device.device_code, conv.customer_id, content);
      await pull();
      return true;
    } catch (err) {
      setSendError(sendErrorText(err));
      return false;
    } finally {
      setSending(false);
    }
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    if (await deliver(content)) setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function pick(kind: UploadKind) {
    setUploadKind(kind);
    setToolsOpen(false);
    // The accept attribute must update before the picker opens.
    window.setTimeout(() => fileInput.current?.click(), 0);
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSending(true);
    setSendError(null);
    try {
      const { url } = await mobileApi.uploadFile(file);
      setSending(false);
      if (await deliver(uploadKind === "image" ? `###图片（${url}）` : `###文件（${url}）`)) toast("已发送");
    } catch (err) {
      setSendError(errorText(err, "上传失败，请重试"));
      setSending(false);
    }
  }

  async function toggleTakeover() {
    const next = !takeover;
    try {
      await agentApi.setTakeover(device.device_code, conv.customer_id, next);
      setTakeover(next);
      toast(next ? "已切换为人工接管，AI 暂停回复" : "已交还 AI 自动回复");
      onUpdated();
    } catch (err) {
      toast(errorText(err, "切换失败"), "danger");
    }
  }

  async function runAction(kind: "reset" | "oldfriend" | "restart") {
    const prompts = {
      reset: { title: "改为「进行中」？", description: "之后 AI 会正常回复这位应聘者。", confirmLabel: "确认", danger: false },
      oldfriend: { title: `把 ${name} 标为老友？`, description: "标记后，这位客户的消息不再触发 AI 回复。", confirmLabel: "标为老友", danger: false },
      restart: { title: `重聊「${name}」？`, description: "会清掉这位客户的对话记录、候选人状态和面试提醒，下次发消息按新客户处理。", confirmLabel: "确认重聊", danger: true },
    }[kind];
    if (!(await confirm(prompts))) return;
    try {
      if (kind === "reset") {
        await mobileApi.resetDisqualified(device.device_code, conv.customer_id);
        setConv((c) => ({ ...c, recruit_status: "none", state: "active" }));
        toast("已改为进行中");
      } else if (kind === "oldfriend") {
        await mobileApi.markOldFriend(device.device_code, conv.customer_id, conv.nickname || "");
        setConv((c) => ({ ...c, is_old_friend: true }));
        toast("已标为老友");
      } else {
        await mobileApi.restart(device.device_code, conv.customer_id);
        toast("已重置，下次按新客户处理");
        onUpdated();
        onBack();
        return;
      }
      onUpdated();
    } catch (err) {
      toast(errorText(err, "操作失败"), "danger");
    }
  }

  const menu: MenuItem[] = [];
  if (conv.recruit_status === "disqualified") menu.push({ label: "改为进行中", icon: "refresh", onSelect: () => runAction("reset") });
  if (!conv.is_old_friend) menu.push({ label: "转为老友", icon: "user", onSelect: () => runAction("oldfriend") });
  menu.push({ label: "重聊（清空记录）", icon: "trash", danger: true, onSelect: () => runAction("restart") });
  const sub = [conv.name && conv.nickname ? conv.nickname : "", conv.remark && conv.remark !== name ? conv.remark : ""].filter(Boolean).join(" · ");

  return (
    <section className="mx-detail" aria-label={`与 ${name} 的对话`}>
      <header className="mx-bar">
        <button type="button" className="mx-icon-btn" aria-label="返回会话列表" onClick={onBack}>
          <Icon name="chevronLeft" size={22} />
        </button>
        <div className="mx-bar-title">
          <span className="mx-bar-name">{name}</span>
          <span className="mx-bar-sub">
            <Badge tone={status.tone}>{status.label}</Badge>
            {sub && <span className="mx-ellipsis">{sub}</span>}
          </span>
        </div>
        <button type="button" className={`mx-mode ${takeover ? "is-manual" : ""}`} aria-pressed={takeover} onClick={toggleTakeover}>
          <Icon name={takeover ? "user" : "robot"} size={14} />
          {takeover ? "人工接管" : "AI 自动"}
        </button>
        <Menu label="更多操作" items={menu} />
      </header>

      <div className="mx-thread" ref={scroller} role="log" aria-live="polite">
        {messages === null && !error && (
          <div className="mx-thread-skeleton" aria-hidden="true">
            <Skeleton width="60%" height={36} />
            <Skeleton width="45%" height={36} />
            <Skeleton width="70%" height={36} />
          </div>
        )}
        {error && <p className="mod-error" role="alert">{error}，3 秒后自动重试</p>}
        {messages?.length === 0 && <p className="mx-empty">还没有消息</p>}
        {messages?.map((m) => <Bubble key={m.id} m={m} />)}
      </div>

      <footer className="mx-compose">
        {sendError && <p className="mx-compose-error" role="alert">{sendError}</p>}
        {!takeover && <p className="mx-compose-hint">AI 正在自动回复，你发的消息会和 AI 的回复一起出现。</p>}
        {toolsOpen && (
          <div className="mx-tools">
            <Button variant="secondary" size="sm" onClick={() => pick("image")}>发图片</Button>
            <Button variant="secondary" size="sm" onClick={() => pick("video")}>发视频</Button>
          </div>
        )}
        <form className="mx-compose-row" onSubmit={send}>
          <button type="button" className="mx-icon-btn" aria-label={toolsOpen ? "收起" : "发图片或视频"} aria-expanded={toolsOpen} onClick={() => setToolsOpen((v) => !v)}>
            <Icon name={toolsOpen ? "x" : "plus"} size={20} />
          </button>
          <textarea
            className="mx-input"
            aria-label="消息内容"
            rows={1}
            placeholder="输入消息"
            value={draft}
            onFocus={() => setToolsOpen(false)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <Button type="submit" size="sm" loading={sending} disabled={!draft.trim()}>发送</Button>
        </form>
        <input ref={fileInput} type="file" hidden accept={uploadKind === "video" ? "video/*" : "image/*"} onChange={onFile} />
      </footer>
    </section>
  );
}

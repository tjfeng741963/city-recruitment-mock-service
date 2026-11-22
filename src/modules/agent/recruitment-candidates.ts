import type { DatabaseSync } from 'node:sqlite';
import { archiveCandidates } from './archive-candidates.js';
type Row = Record<string, unknown>;
const text = (...values: unknown[]) => String(values.find(value => value !== null && value !== undefined && String(value).trim()) ?? '');
const json = (value: unknown): Row => { try { return JSON.parse(String(value || '{}')) as Row; } catch { return {}; } };
const identity = (code: unknown, customer: unknown) => JSON.stringify([String(code || ''), String(customer ?? '')]);
const stamp = (raw:unknown):number => {
  const value=String(raw || '');
  const normalized=/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(value)?value.replace(' ','T')+'Z':value;
  return Date.parse(normalized)||0;
};
const classify = (row: Row, fallback = 'communicating'): string => {
  if (row.arrival_status === 'arrived' || row.status === 'checked_in' || row.event_type === 'checked_in') return 'checked_in';
  if (row.recruit_status === 'disqualified' || row.status === 'disqualified' || row.event_type === 'disqualified') return 'disqualified';
  if (row.recruit_status === 'invited' || row.status === 'invited' || row.event_type === 'invited') return 'invited';
  if (text(row.name, row.phone, row.interview_date) || row.recruit_status === 'pending_invite' || row.state === 'pending_invite') return 'pending_information';
  return fallback;
};

/** Read-only union of the three actual sources. Never merge people by nickname or telephone. */
export function recruitmentCandidates(db: DatabaseSync): Row[] {
  const archives = archiveCandidates(db);
  const rows: Row[] = [];
  const byCustomer = new Map<string, Row>();
  for (const archive of archives) {
    const row: Row = { ...archive, source: 'archive', status: archive.status === 'invited' && !archive.interview_date && !archive.interview_time && !archive.interview_confirmed ? 'pending_information' : archive.status };
    rows.push(row);
    if (archive.has_conversation) byCustomer.set(identity(archive.device_code, archive.customer_id), row);
  }
  const conversations = db.prepare(`SELECT * FROM agent_conversations
    WHERE COALESCE(external_conversation_id,'') NOT LIKE 'group:%'
      AND COALESCE(external_conversation_id,'') NOT LIKE 'R:%' ORDER BY updated_at DESC,id DESC`).all() as Row[];
  for (const conversation of conversations) {
    const key = identity(conversation.device_code, conversation.customer_id);
    if (byCustomer.has(key)) continue;
    const profile = json(conversation.profile_json);
    const row: Row = { id: `conversation:${conversation.id}`, session_key: text(conversation.external_conversation_id),
      device_code: text(conversation.device_code), customer_id: text(conversation.customer_id),
      nickname: text(conversation.nickname), name: text(conversation.name, profile.name), phone: text(conversation.phone, profile.phone),
      province: text(conversation.province, profile.province), city: text(conversation.city, profile.city), district: text(conversation.district, profile.district),
      factory_name: text(conversation.factory_name, profile.factory_name), interview_date: text(conversation.interview_date, profile.interview_date),
      interview_time: text(conversation.interview_time, profile.interview_time), event_at: text(conversation.updated_at, conversation.created_at),
      created_at: text(conversation.created_at), recruit_status: conversation.recruit_status,
      registration_text: text(profile.registration_text), has_conversation: true, association_status: 'linked',
      source: 'conversation', remind_status: 'not_reminded', remind_count: 0 };
    row.status = classify({ ...row, state: conversation.state });
    rows.push(row); byCustomer.set(key, row);
  }
  const events = db.prepare(`SELECT * FROM candidate_events WHERE status<>'converted'
    ORDER BY updated_at DESC,event_at DESC,id DESC`).all() as Row[];
  const eventSeen=new Set<string>();
  for (const event of events) {
    const key = identity(event.device_code, event.customer_id);
    const latestEvent=!eventSeen.has(key);
    eventSeen.add(key);
    const existing = byCustomer.get(key);
    const eventData = json(event.data_json);
    if (existing) {
      // Archives retain confirmed fields; events only fill missing values.
      for (const name of ['name','phone','province','city','district','factory_name','interview_date','interview_time','nickname']) {
        if (!text(existing[name])) existing[name] = text(event[name]);
      }
      if (!text(existing.registration_text)) existing.registration_text = text(eventData.registration_text);
      // Respect current conversation resets and newer dispositions; old events cannot rewind state.
      const next=classify(event);
      const eventStamp=Math.max(stamp(event.updated_at),stamp(event.event_at));
      const currentStamp=stamp(existing.event_at);
      if(latestEvent && eventStamp>=currentStamp && existing.status!=='checked_in') {
        existing.status=next;
      }
      if(existing.status==='communicating')existing.status=classify(existing);
      continue;
    }
    const row: Row = { ...event, id: `event:${event.id}`, session_key: '', customer_id: text(event.customer_id),
      device_code: text(event.device_code), nickname: text(event.nickname), registration_text: text(eventData.registration_text),
      source: 'event', has_conversation: false, association_status: 'unlinked', remind_status: 'not_reminded',
      status: classify(event), event_at: text(event.event_at,event.updated_at),created_at:text(event.created_at) };
    rows.push(row); byCustomer.set(key,row);
  }
  for (const row of rows) {
    const code = text(row.device_code);
    const device = db.prepare("SELECT device_name,data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=? ORDER BY id DESC LIMIT 1").get(code) as Row | undefined;
    const config = json(device?.data_json);
    row.device_name = text(config.name, device?.device_name, code);
    row.recruiter_id = text(config.recruiter_id, row.recruiter_id);
    if (row.source !== 'archive') {
      const prefix = `followup:${code}:${text(row.customer_id)}:${text(row.interview_date)}:`;
      const reminder = db.prepare('SELECT status FROM bridge_commands WHERE device_code=? AND customer_id=? AND substr(idempotency_key,1,?)=? ORDER BY created_at DESC LIMIT 1')
        .get(code,text(row.customer_id),prefix.length,prefix) as Row | undefined;
      row.remind_status = text(reminder?.status, 'not_reminded');
    }
  }
  return rows.sort((a,b) => text(b.event_at,b.created_at).localeCompare(text(a.event_at,a.created_at)));
}

export function candidateConversation(db: DatabaseSync, id: string): {device_code:string;customer_id:string;nickname:string} | undefined {
  if (/^dify:[a-f0-9]{64}$/.test(id)) {
    return db.prepare(`SELECT c.device_code,CAST(c.customer_id AS TEXT) customer_id,c.nickname
      FROM agent_archive a JOIN agent_conversations c ON c.id=a.dify_conversation_row_id AND c.device_code=a.dify_device_code
        AND c.external_conversation_id=a.dify_external_session
      WHERE a.session_key=?`).get(id) as ReturnType<typeof candidateConversation>;
  }
  if (/^conversation:\d+$/.test(id)) {
    return db.prepare('SELECT device_code,CAST(customer_id AS TEXT) customer_id,nickname FROM agent_conversations WHERE id=?').get(Number(id.slice(13))) as ReturnType<typeof candidateConversation>;
  }
  if (/^event:\d+$/.test(id)) {
    return db.prepare(`SELECT c.device_code,CAST(c.customer_id AS TEXT) customer_id,c.nickname FROM candidate_events e
      JOIN agent_conversations c ON c.device_code=e.device_code AND CAST(c.customer_id AS TEXT)=e.customer_id WHERE e.id=?`).get(Number(id.slice(6))) as ReturnType<typeof candidateConversation>;
  }
  return undefined;
}

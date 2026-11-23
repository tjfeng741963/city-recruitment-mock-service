import type { DatabaseSync } from "node:sqlite";
import {
  buildInviteMessage, DIFY_GROUP_NOTIFICATION_PREFIX, deviceInviteGroupBinding, ensureGroupConversation,
  readInviteGroupConfig, resolveDeviceInviteGroup,
} from "../../shared/invite-group.js";
import { DeviceBridgeStore } from "../messaging/device-bridge.js";

const notificationKey = (archiveKey: string) => DIFY_GROUP_NOTIFICATION_PREFIX + archiveKey;

export function difyGroupNotificationState(db: DatabaseSync, deviceCode: string, archiveKey: string, binding: string) {
  const command = db.prepare(`SELECT c.status, c.simulated, c.lease_until, COALESCE(NULLIF(b.nickname,''),c.contact_id) AS target
    FROM bridge_commands c LEFT JOIN bridge_contacts b ON b.device_code=c.device_code AND b.contact_id=c.contact_id
    WHERE c.device_code=? AND c.idempotency_key=?`).get(deviceCode, notificationKey(archiveKey)) as
    { status: string; simulated: number; lease_until: number; target: string } | undefined;
  if (command) {
    let status = command.status;
    if (status === "succeeded") status = command.simulated ? "unknown" : "sent";
    else if (status === "claimed" && command.lease_until <= Date.now()) status = "unknown";
    return { status, target: command.target };
  }
  const pending = db.prepare("SELECT dify_notify_binding FROM agent_archive WHERE session_key=?").get(archiveKey) as
    { dify_notify_binding: string } | undefined;
  const target = pending?.dify_notify_binding || binding.trim();
  if (!target) return { status: "no-group", target };
  const group = target === binding.trim() && resolveDeviceInviteGroup(db, deviceCode, target);
  return { status: group ? "pending" : "group-unavailable", target: group ? group.name : target };
}

export function queueDifyGroupNotification(db: DatabaseSync, deviceCode: string, archiveKey: string, job: {
  title: string; factory: string;
}) {
  const idempotencyKey = notificationKey(archiveKey);
  if (db.prepare("SELECT 1 FROM bridge_commands WHERE device_code=? AND idempotency_key=?").get(deviceCode, idempotencyKey)) return;

  const binding = deviceInviteGroupBinding(db, deviceCode);
  if (!binding) return;

  const archive = db.prepare(`SELECT name, phone, city, remark, interview_date, interview_time, interview_address, interview_point,
      dify_notify_binding, dify_notify_content
    FROM agent_archive WHERE session_key=? AND dify_device_code=? AND interview_confirmed=1`)
    .get(archiveKey, deviceCode) as Record<string, string> | undefined;
  if (!archive || (archive.dify_notify_binding && archive.dify_notify_binding !== binding)) return;
  const content = archive.dify_notify_content || buildInviteMessage({
    city: archive.city, interviewDate: archive.interview_date, name: archive.name, phone: archive.phone,
    remark: archive.remark,   // 备注 = 群里认人的微信名称，和 Agent 链路同一语义
    cityAbbr: readInviteGroupConfig(db).cityAbbr, factoryName: job.factory, jobTitle: job.title,
    interviewTime: archive.interview_time, interviewPlace: archive.interview_address || archive.interview_point,
  }).replace(/\s+/g, " ").replace(/【/g, "〔").replace(/】/g, "〕").trim();
  if (!content) return;
  const group = resolveDeviceInviteGroup(db, deviceCode, binding);
  if (group) {
    enqueueDifyNotice(db, deviceCode, archiveKey, content, group);
  } else {
    db.prepare("UPDATE agent_archive SET dify_notify_binding=?,dify_notify_content=? WHERE session_key=?")
      .run(binding, content, archiveKey);
  }
}

function enqueueDifyNotice(db: DatabaseSync, deviceCode: string, archiveKey: string, content: string, group: {
  conv_id: string; name: string;
}) {
  const customerId = ensureGroupConversation(db, deviceCode, group.conv_id, group.name);
  new DeviceBridgeStore(db).enqueue({
    deviceCode, customerId, content, idempotencyKey: notificationKey(archiveKey),
  }, { queueWhileOffline: true });
  db.prepare("UPDATE agent_archive SET dify_notify_content='' WHERE session_key=? AND dify_notify_content<>''").run(archiveKey);
}

export function queuePendingDifyGroupNotifications(db: DatabaseSync, deviceCode: string, accountId: string) {
  if (!accountId) return;
  const binding = deviceInviteGroupBinding(db, deviceCode);
  if (!binding) return;
  const readPending = db.prepare(`SELECT session_key, dify_notify_content FROM agent_archive
    WHERE dify_device_code=? AND dify_account_id=? AND dify_notify_binding=? AND interview_confirmed=1
      AND dify_notify_content<>'' ORDER BY updated_at,session_key LIMIT 25`);
  if (!readPending.get(deviceCode, accountId, binding)) return;
  const group = resolveDeviceInviteGroup(db, deviceCode, binding);
  if (!group) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const pending = readPending.all(deviceCode, accountId, binding) as { session_key: string; dify_notify_content: string }[];
    for (const row of pending) enqueueDifyNotice(db, deviceCode, row.session_key, row.dify_notify_content, group);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

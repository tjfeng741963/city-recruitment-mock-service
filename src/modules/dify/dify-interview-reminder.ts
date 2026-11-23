import type { DatabaseSync } from "node:sqlite";

export function queueInterviewReminder(db: DatabaseSync, input: {
  archiveKey: string; deviceCode: string; date: string; time: string; address: string;
}) {
  const minutes = Number(process.env.REA_DIFY_INTERVIEW_REMINDER_MINUTES);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) return;
  const appointment = Date.parse(`${input.date}T${input.time}:00+08:00`);
  const due = appointment - minutes*60_000;
  if (due <= Date.now()) return;
  const midnight = Date.parse(`${input.date}T00:00:00+08:00`);
  // This reminder says “today”, so even an early appointment is never announced the night before.
  db.prepare(`INSERT INTO dify_interview_reminders(archive_key,device_code,due_at,expires_at,interview_date,interview_time,interview_address)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(input.archiveKey,input.deviceCode,Math.max(due,midnight),appointment,input.date,input.time,input.address);
}

export function stopInterviewReminder(db: DatabaseSync, archiveKey: string) {
  db.prepare("UPDATE dify_interview_reminders SET suppressed=1 WHERE archive_key=?").run(archiveKey);
  db.prepare(`UPDATE bridge_commands SET status='failed' WHERE status='queued'
    AND id=(SELECT command_id FROM dify_interview_reminders WHERE archive_key=?)`).run(archiveKey);
}

import type { DatabaseSync } from 'node:sqlite';
import { faqIssues } from './kb-governance.js';

export interface PositionKnowledge { id: number; question: string; answer: string; scope: string }

/** Use validated shared answers and this position only; legacy entity IDs are not interchangeable. */
export function positionKnowledge(db: DatabaseSync, positionId: number, facts: Record<string, string>, verticalId:number|null=null): PositionKnowledge[] {
  const selected=verticalId&&db.prepare("SELECT 1 FROM vertical WHERE tenant_id=1 AND id=? AND status='enabled'").get(verticalId)?verticalId:0;
  const rows = db.prepare(`SELECT * FROM kb_faq WHERE tenant_id=1 AND status='enabled'
    AND ((scope_level='global' AND (vertical_id IS NULL OR vertical_id=?)) OR (scope_level='vertical' AND vertical_id=?) OR (scope_level='position' AND scope_position_id=?))
    ORDER BY CASE WHEN scope_level='position' THEN 0 WHEN vertical_id IS NOT NULL THEN 1 ELSE 2 END, priority DESC, id DESC`).all(selected,selected,positionId) as Array<Record<string, unknown>>;
  const aliases: Record<string, string> = { wage: 'wage_text', age: 'age_text', height: 'height_text',
    welfare: 'welfare_text', insurance: 'welfare_text', insurance_text: 'welfare_text', shift: 'hours_text',
    work: 'job_content', work_text: 'job_content', cert: 'cert_text', employer: 'factory_name', address: 'interview_address' };
  const result: PositionKnowledge[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (faqIssues(db, row).some(issue => !issue.code.startsWith("faq_media_"))) continue;
    let missing = false;
    const answer = String(row.answer || '').replace(/\{([^{}\n]+)\}/g, (_match, key: string) => {
      const value = facts[aliases[key] || key];
      if (!value) missing = true;
      return value || '';
    });
    const question = String(row.question || '').trim();
    if (missing || !answer.trim() || !question || seen.has(question)) continue;
    seen.add(question);
    result.push({ id: Number(row.id), question, answer, scope: String(row.scope_level) });
  }
  return result;
}

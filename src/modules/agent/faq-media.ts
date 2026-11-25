import type { DatabaseSync } from "node:sqlite";
import { difyMediaName, type MediaKind } from "../../shared/media-assets.js";
import type { PositionKnowledge } from "./position-knowledge.js";

type Asset = { id: number; name: string; kind: MediaKind; position_id: number; sha256: string; storage_path: string };
type MediaMessage = { type: MediaKind; name: string; content: string };

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    try { return stringList(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function resolveFaqMedia(db: DatabaseSync, row: Record<string, unknown>) {
  const references = stringList(row.media).filter(value => value.startsWith("asset:"));
  const assets: MediaMessage[] = [];
  const issues: Array<{ code: string; detail: string }> = [];
  if (!references.length) return { assets, issues };
  const positionId = Number(row.scope_position_id);
  if (row.scope_level !== "position" || !Number.isSafeInteger(positionId) || positionId <= 0) {
    return { assets, issues: [{ code: "faq_media_scope", detail: "随答案发送的图片和视频仅适用于岗位专属问答。" }] };
  }
  const lookup = db.prepare("SELECT id,name,kind,position_id,sha256,storage_path FROM media_assets WHERE id=? AND status='enabled'");
  for (const reference of references) {
    const parts = /^asset:([1-9]\d*):([a-f0-9]{64})$/.exec(reference);
    const id = Number(parts?.[1]);
    const asset = Number.isSafeInteger(id) ? lookup.get(id) as Asset | undefined : undefined;
    const name = asset && asset.sha256 === parts?.[2]
      && (asset.position_id === 0 || asset.position_id === positionId) && difyMediaName(asset);
    if (!asset || !name || !["image", "video"].includes(asset.kind)) {
      issues.push({ code: "faq_media_asset", detail: `素材 #${Number.isSafeInteger(id) ? id : "未知"}已失效、格式不支持或属于其他岗位，请重新选择。` });
      continue;
    }
    if (assets.some(item => item.type === asset.kind)) {
      issues.push({ code: "faq_media_count", detail: "每条问答最多选择一张图片和一个视频。" });
      continue;
    }
    assets.push({ type: asset.kind, name, content: `${asset.kind === "image" ? "图片" : "视频"} · ${asset.name}` });
  }
  assets.sort((a, b) => Number(a.type === "video") - Number(b.type === "video"));
  return { assets, issues };
}

export function faqMediaIssues(db: DatabaseSync, row: Record<string, unknown>) {
  return resolveFaqMedia(db, row).issues;
}

export const normalizeFaqUtterance = (text: string): string =>
  text.normalize("NFKC").trim().toLowerCase().replace(/[。！？?!]+$/u, "").trim();

export function faqMediaForQuestion(db: DatabaseSync, positionId: number, text: string, knowledge: PositionKnowledge[]) {
  const question = normalizeFaqUtterance(text);
  if (!question || /(?:别|不要|不用|不必).{0,10}(?:发|给|看)|取消发送/u.test(question)) return;
  const eligible = new Map(knowledge.filter(item => item.scope === "position").map(item => [item.id, item]));
  const rows = (db.prepare(`SELECT id,question,keywords,media,scope_level,scope_position_id FROM kb_faq
    WHERE tenant_id=1 AND scope_level='position' AND scope_position_id=? AND status='enabled'`).all(positionId) as Array<Record<string, unknown>>)
    .filter(row => eligible.has(Number(row.id)));
  const exact = rows.filter(row => normalizeFaqUtterance(String(row.question)) === question);
  const matches = exact.length ? exact : rows.filter(row =>
    stringList(row.keywords).some(keyword => normalizeFaqUtterance(keyword) === question));
  if (matches.length !== 1) return;
  const row = matches[0];
  const entry = eligible.get(Number(row.id));
  if (!entry) return;
  const { assets, issues } = resolveFaqMedia(db, row);
  if (!assets.length || issues.length) return;
  return { faq_id: entry.id, question: entry.question, answer: entry.answer,
    messages: [{ type: "text" as const, content: entry.answer }, ...assets] };
}

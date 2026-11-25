import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { faqMediaForQuestion, faqMediaIssues } from "../src/modules/agent/faq-media.js";

describe("岗位问答随答案发送", () => {
  it("keeps scope and order, rejects ambiguous matches and surfaces unavailable assets", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE media_assets(id INTEGER, name TEXT, kind TEXT, position_id INTEGER, status TEXT, sha256 TEXT, storage_path TEXT);
        CREATE TABLE kb_faq(id INTEGER, tenant_id INTEGER, scope_level TEXT, scope_position_id INTEGER, status TEXT, question TEXT, keywords TEXT, media TEXT);
        INSERT INTO kb_faq VALUES(3,1,'position',6,'enabled','环境怎么样？','[]','[]');`);
      const sha = "a".repeat(64);
      const refs = [`asset:7:${sha}`, `asset:8:${sha}`];
      db.prepare("INSERT INTO kb_faq VALUES(2,1,'position',5,'enabled','环境怎么样？',?,?)")
        .run(JSON.stringify(["现场"]), JSON.stringify(refs));
      const insert = db.prepare("INSERT INTO media_assets VALUES(?,?,?,?,'enabled',?,?)");
      insert.run(7, "现场.mp4", "video", 5, sha, "media/a.mp4");
      insert.run(8, "现场.jpg", "image", 0, sha, "media/a.jpg");
      const entries = [{ id:2, question:"环境怎么样？", answer:"这是现场。", scope:"position" }];
      expect(faqMediaForQuestion(db, 5, "环境怎么样?", entries)).toMatchObject({
        faq_id: 2, question: "环境怎么样？", answer: "这是现场。",
        messages: [{ type: "text" }, { type: "image" }, { type: "video" }],
      });
      expect(faqMediaForQuestion(db, 6, "环境怎么样？", entries)).toBeUndefined();
      expect(faqMediaForQuestion(db, 5, "不用发现场", entries)).toBeUndefined();
      db.prepare("INSERT INTO kb_faq VALUES(4,1,'position',5,'enabled','另一条',?,'[]')")
        .run(JSON.stringify(["现场", "环境怎么样"]));
      entries.push({ id:4, question:"另一条", answer:"其他内容。", scope:"position" });
      expect(faqMediaForQuestion(db, 5, "现场", entries)).toBeUndefined();
      expect(faqMediaForQuestion(db, 5, "环境怎么样", entries)?.faq_id).toBe(2);
      db.exec("UPDATE media_assets SET position_id=6 WHERE id=7");
      expect(faqMediaIssues(db, { scope_level:"position", scope_position_id:5, media:refs })).toContainEqual(
        expect.objectContaining({ code: "faq_media_asset" }),
      );
      expect(faqMediaForQuestion(db, 5, "环境怎么样？", entries)).toBeUndefined();
      db.exec("DELETE FROM media_assets WHERE id=7");
      insert.run(7, "新素材.mp4", "video", 5, "b".repeat(64), "media/b.mp4");
      expect(faqMediaForQuestion(db, 5, "环境怎么样？", entries)).toBeUndefined();
    } finally { db.close(); }
  });
});

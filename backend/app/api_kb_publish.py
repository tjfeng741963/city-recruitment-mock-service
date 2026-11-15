"""Explicit, atomic publication of shared FAQs. Never imports legacy entries or flow graphs."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError, OperationalError

from . import instance
from .deps import SessionDep, get_service_or_user
from .models import User
from .models_kb import KbFaq, Vertical
from .models_kb_publish import KbPublication, KbPublishedFaq, KbPublishState
from .services.kb_faq import _PLACEHOLDER_KEYS
from .services.kb_policy import shared_answer_allowed

router = APIRouter(prefix="/api/v1/kb/publish", tags=["knowledge-publication"])


async def publisher(user: Annotated[User | None, Depends(get_service_or_user)]):
    if user is not None and user.role != "admin":
        raise HTTPException(403, "需要管理员或可信服务身份")
    return user


Publisher = Annotated[User | None, Depends(publisher)]


class FaqIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source_id: int = Field(gt=0)
    vertical_code: str | None = Field(default=None, min_length=1, max_length=50)
    scope_level: Literal["global", "vertical"] = "global"
    question: str = Field(min_length=1, max_length=500)
    answer: str = Field(min_length=1, max_length=10000)
    keywords: list[str] = Field(default_factory=list, max_length=100)
    media: list[str] = Field(default_factory=list, max_length=30)
    priority: int = Field(default=0, ge=-100000, le=100000)
    status: Literal["enabled", "disabled"] = "enabled"


class PreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[FaqIn] = Field(default_factory=list, max_length=2000)
    rollback_of: str | None = Field(default=None, max_length=64)


class ApplyIn(PreviewIn):
    publication_id: str = Field(pattern=r"^[a-zA-Z0-9-]{1,64}$")
    expected_target: str
    expected_revision: str
    expected_generation: int
    payload_digest: str


def dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value) -> str:
    return hashlib.sha256(dump(value).encode()).hexdigest()


async def inventory(session):
    verticals = (await session.execute(select(Vertical).where(Vertical.tenant_id == 1).order_by(Vertical.id))).scalars().all()
    codes = {v.id: v.code for v in verticals}
    rows = (await session.execute(select(KbFaq).where(KbFaq.tenant_id == 1).order_by(KbFaq.id))).scalars().all()
    links = (await session.execute(select(KbPublishedFaq).order_by(KbPublishedFaq.source_id))).scalars().all()
    by_id = {row.id: row for row in rows}
    managed = []
    for link in links:
        row = by_id.get(link.faq_id)
        if row is None:
            raise HTTPException(409, "已发布问答被外部删除，请先核对发布归属")
        managed.append(dict(source_id=link.source_id, vertical_code=codes.get(row.vertical_id),
                            scope_level=row.scope_level, question=row.question, answer=row.answer,
                            keywords=json.loads(row.keywords), media=json.loads(row.media),
                            priority=row.priority, status=row.status))
    revision = digest({"faqs": [{c.name: getattr(row, c.name) for c in KbFaq.__table__.columns
                                 if c.name not in {"created_at", "updated_at"}} for row in rows],
                       "links": [(link.source_id, link.faq_id) for link in links],
                       "verticals": [(v.id, v.code, v.status) for v in verticals]})
    return managed, revision, {link.source_id: by_id[link.faq_id] for link in links}, verticals


async def desired(session, payload: PreviewIn):
    if payload.rollback_of:
        if payload.items:
            raise HTTPException(422, "回滚不得同时提交新内容")
        previous = await session.get(KbPublication, payload.rollback_of)
        if previous is None:
            raise HTTPException(404, "发布记录不存在")
        items = [FaqIn.model_validate(row) for row in json.loads(previous.before_json)]
    else:
        items = payload.items
    if len({row.source_id for row in items}) != len(items):
        raise HTTPException(422, "源问答编号重复")
    fields = {*_PLACEHOLDER_KEYS, *_PLACEHOLDER_KEYS.values()}
    render_fields = fields | {"address", "walk_guide", "employer", "interview_time"}
    pattern = re.compile(r"\{([^{}\n|]{1,40})(?:\|([^{}\n]{1,200}))?\}")
    for row in items:
        if row.scope_level == "vertical" and not row.vertical_code:
            raise HTTPException(422, "品类问答必须指定稳定品类编码")
        if not row.question.strip() or not row.answer.strip():
            raise HTTPException(422, "问题和答案不能为空")
        if row.status != "enabled":
            continue  # Disabled originals are retained for audit, never retrieved.
        if (not shared_answer_allowed(row.question, row.answer, keywords=row.keywords, media=row.media, fact_fields=fields)
                or any(m.group(1) not in render_fields or m.group(2) is not None for m in pattern.finditer(row.answer))
                or re.search(r"[{}]", pattern.sub("", row.answer))):
            raise HTTPException(422, f"问答 #{row.source_id} 含共享厂规、默认承诺或无效模板")
    return [row.model_dump() for row in sorted(items, key=lambda row: row.source_id)]


def changes(before, after):
    old = {row["source_id"]: row for row in before}
    new = {row["source_id"]: row for row in after}
    result = []
    for key in sorted(old.keys() | new.keys()):
        a, b = old.get(key), new.get(key)
        if a == b:
            continue
        # Missing managed FAQs are disabled, not physically deleted.
        if b is None and a["status"] == "disabled":
            continue
        result.append({"source_id": key, "action": "create" if a is None else "disable" if b is None or b["status"] == "disabled" else "update",
                       "before": a, "after": b})
    return result


@router.post("/preview")
async def preview(payload: PreviewIn, session: SessionDep, _user: Publisher):
    after = await desired(session, payload)
    before, revision, _, verticals = await inventory(session)
    for row in after:
        if row["status"] == "enabled" and any(v.code == row["vertical_code"] and v.status != "enabled" for v in verticals):
            raise HTTPException(422, "目标品类已停用，不能发布启用问答")
    state = await session.get(KbPublishState, 1)
    return {"target_id": instance.current()["install_id"], "target_revision": revision,
            "target_generation": state.generation, "payload_digest": digest(after),
            "items": after, "changes": changes(before, after), "managed_count": len(before)}


@router.post("/apply")
async def apply(payload: ApplyIn, session: SessionDep, user: Publisher):
    if instance.current()["install_id"] != payload.expected_target:
        raise HTTPException(409, "回复服务实例已变化，请重新预览")
    after = await desired(session, payload)
    wanted_digest = digest(after)
    if wanted_digest != payload.payload_digest:
        raise HTTPException(409, "待发布内容与预览不一致")
    previous = await session.get(KbPublication, payload.publication_id)
    if previous:
        if previous.digest != wanted_digest:
            raise HTTPException(409, "发布编号已被其他内容使用")
        return {**json.loads(previous.result_json), "replayed": True}
    try:
        locked = await session.execute(update(KbPublishState).where(
            KbPublishState.id == 1, KbPublishState.generation == payload.expected_generation
        ).values(generation=KbPublishState.generation + 1))
        if locked.rowcount != 1:
            raise HTTPException(409, "已有其他发布，请重新预览")
        before, revision, managed, verticals = await inventory(session)
        if revision != payload.expected_revision:
            raise HTTPException(409, "目标知识库已变化，请重新预览")
        by_code = {v.code: v for v in verticals}
        for item in after:
            code = item["vertical_code"]
            if code and code not in by_code:
                vertical = Vertical(tenant_id=1, code=code, name=code)
                session.add(vertical)
                await session.flush()
                by_code[code] = vertical
            if code and item["status"] == "enabled" and by_code[code].status != "enabled":
                raise HTTPException(422, "目标品类已停用")
            row = managed.get(item["source_id"])
            if row is None:
                row = KbFaq(tenant_id=1)
                session.add(row)
            row.vertical_id = by_code[code].id if code else None
            row.scope_level = item["scope_level"]
            row.scope_location_id = row.scope_employer_id = row.scope_position_id = None
            for name in ("question", "answer", "priority", "status"):
                setattr(row, name, item[name])
            row.keywords, row.media = dump(item["keywords"]), dump(item["media"])
            if item["source_id"] not in managed:
                await session.flush()
                session.add(KbPublishedFaq(source_id=item["source_id"], faq_id=row.id))
        new_ids = {row["source_id"] for row in after}
        for key, row in managed.items():
            if key not in new_ids:
                row.status = "disabled"
        await session.flush()
        actual, new_revision, _, _ = await inventory(session)
        result = {"publication_id": payload.publication_id, "target_id": payload.expected_target,
                  "target_revision": new_revision, "target_generation": payload.expected_generation + 1,
                  "payload_digest": wanted_digest, "changes": changes(before, after), "managed_count": len(actual),
                  "replayed": False}
        session.add(KbPublication(id=payload.publication_id, digest=wanted_digest, before_json=dump(before),
                                  after_json=dump(actual), result_json=dump(result), actor=user.username if user else "trusted-service"))
        await session.commit()
        return result
    except (IntegrityError, OperationalError):
        await session.rollback()
        raise HTTPException(409, "发布竞争或数据库未返回确认；请用原发布编号核对重试或查看记录") from None
    except HTTPException:
        await session.rollback()
        raise
    except Exception as error:
        await session.rollback()
        raise HTTPException(500, f"发布未取得持久化确认（{type(error).__name__}）；请用原发布编号核对重试") from None


@router.get("/history")
async def history(session: SessionDep, _user: Publisher):
    rows = (await session.execute(select(KbPublication).order_by(KbPublication.created_at.desc()).limit(30))).scalars().all()
    return {"items": [{"id": row.id, "created_at": row.created_at.replace(tzinfo=timezone.utc).isoformat(), "actor": row.actor,
                       "result": json.loads(row.result_json)} for row in rows]}

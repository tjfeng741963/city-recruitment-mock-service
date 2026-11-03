"""知识库 API：检索 + 分类/条目的增删改查。

检索接口是给 agent 用的（Python 内部或 Node 配置后台调用）；
增删改查是给配置后台用的。

每条规则都围绕一个前提：**事实不能由模型编**。因此：
- 岗位条目的结构化字段（工价/年龄/面试时间）在写入时就固定下来；
- 检索结果按 tier 标注命中层，日志里能查到"这条回复依据哪条知识"。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from .deps import AdminUser, CurrentUser, SessionDep
from .models_kb import DEFAULT_TENANT_ID, KbCategory, KbEntry, KbFragment
from .services.kb_search import SearchQuery, extract_age_from_query, search

router = APIRouter(prefix="/api/v1/kb", tags=["knowledge"])


# ─────────────────────────── schemas ───────────────────────────
class CategoryIn(BaseModel):
    label: str = Field(min_length=1, max_length=255)
    parent_id: int | None = None
    position: int = 0


class CategoryOut(BaseModel):
    id: int
    parent_id: int | None
    label: str
    position: int

    model_config = {"from_attributes": True}


class FragmentIn(BaseModel):
    kind: str = Field(default="text", pattern="^(text|image)$")
    content: str | None = None
    asset_id: int | None = None


class FragmentOut(BaseModel):
    id: int
    position: int
    kind: str
    content: str | None

    model_config = {"from_attributes": True}


class EntryIn(BaseModel):
    kind: str = Field(default="script", pattern="^(job|script)$")
    title: str = Field(min_length=1, max_length=500)
    category_id: int | None = None

    city: str | None = None
    district: str | None = None
    factory_name: str | None = None
    age_min: int | None = Field(default=None, ge=0, le=150)
    age_max: int | None = Field(default=None, ge=0, le=150)
    wage_min: float | None = None
    wage_max: float | None = None
    wage_unit: str | None = Field(default=None, pattern="^(hour|day|month)$")
    has_meal: bool | None = None
    has_dorm: bool | None = None
    interview_at: datetime | None = None
    valid_until: datetime | None = None

    body: str = ""
    fragments: list[FragmentIn] = Field(default_factory=list)


class EntryOut(BaseModel):
    id: int
    kind: str
    title: str
    category_id: int | None
    city: str | None
    age_min: int | None
    age_max: int | None
    wage_min: float | None
    wage_max: float | None
    wage_unit: str | None
    interview_at: datetime | None
    valid_until: datetime | None
    status: str
    body: str

    model_config = {"from_attributes": True}


class EntryStatusIn(BaseModel):
    status: str = Field(pattern="^(enabled|disabled|expired)$")


class SearchRequest(BaseModel):
    q: str | None = None
    city: str | None = None
    age: int | None = Field(default=None, ge=0, le=150)
    kind: str | None = Field(default=None, pattern="^(job|script)$")
    limit: int = Field(default=8, ge=1, le=50)


class SearchHitOut(BaseModel):
    tier: str
    score: float
    entry: EntryOut


class SearchResponse(BaseModel):
    hits: list[SearchHitOut]
    tiers_used: list[str]
    detected_age: int | None


# ─────────────────────────── 检索 ───────────────────────────
@router.post("/search", response_model=SearchResponse)
async def search_entries(
    payload: SearchRequest, session: SessionDep, user: CurrentUser
) -> SearchResponse:
    """三层漏斗检索。年龄从问法里自动识别，也可显式传入。"""
    del user  # 接口需要登录，但检索本身不按用户过滤
    age = payload.age if payload.age is not None else extract_age_from_query(payload.q)
    result = await search(
        session,
        SearchQuery(
            tenant_id=DEFAULT_TENANT_ID,
            city=payload.city,
            age=age,
            text=payload.q,
            kind=payload.kind,
            limit=payload.limit,
        ),
    )
    return SearchResponse(
        hits=[
            SearchHitOut(
                tier=h.tier, score=h.score, entry=EntryOut.model_validate(h.entry)
            )
            for h in result.hits
        ],
        tiers_used=list(result.tiers_used),
        detected_age=age,
    )


# ─────────────────────────── 分类 ───────────────────────────
@router.get("/categories", response_model=list[CategoryOut])
async def list_categories(session: SessionDep, user: CurrentUser) -> list[KbCategory]:
    del user
    rows = (
        await session.execute(
            select(KbCategory)
            .where(KbCategory.tenant_id == DEFAULT_TENANT_ID)
            .order_by(KbCategory.position, KbCategory.id)
        )
    ).scalars().all()
    return list(rows)


@router.post("/categories", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
async def create_category(
    payload: CategoryIn, session: SessionDep, admin: AdminUser
) -> KbCategory:
    del admin
    if payload.parent_id is not None:
        parent = await session.get(KbCategory, payload.parent_id)
        if parent is None or parent.tenant_id != DEFAULT_TENANT_ID:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "父分类不存在")
    category = KbCategory(
        tenant_id=DEFAULT_TENANT_ID,
        parent_id=payload.parent_id,
        label=payload.label,
        position=payload.position,
    )
    session.add(category)
    await session.commit()
    await session.refresh(category)
    return category


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(category_id: int, session: SessionDep, admin: AdminUser) -> None:
    del admin
    category = await session.get(KbCategory, category_id)
    if category is None or category.tenant_id != DEFAULT_TENANT_ID:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "分类不存在")
    await session.delete(category)
    await session.commit()


# ─────────────────────────── 条目 ───────────────────────────
def _build_search_text(payload: EntryIn) -> str:
    """全文检索用的拼接文本：标题 + 正文 + 岗位字段，全部参与匹配。"""
    parts = [payload.title, payload.body, payload.city or "", payload.factory_name or ""]
    return " ".join(p for p in parts if p).strip()


@router.get("/entries", response_model=list[EntryOut])
async def list_entries(
    session: SessionDep,
    user: CurrentUser,
    kind: str | None = Query(default=None, pattern="^(job|script)$"),
    city: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
) -> list[KbEntry]:
    del user
    stmt = select(KbEntry).where(KbEntry.tenant_id == DEFAULT_TENANT_ID)
    if kind:
        stmt = stmt.where(KbEntry.kind == kind)
    if city:
        stmt = stmt.where(KbEntry.city == city)
    rows = (
        await session.execute(stmt.order_by(KbEntry.updated_at.desc()).limit(limit))
    ).scalars().all()
    return list(rows)


@router.get("/entries/{entry_id}", response_model=EntryOut)
async def get_entry(entry_id: int, session: SessionDep, user: CurrentUser) -> KbEntry:
    del user
    entry = await session.get(KbEntry, entry_id)
    if entry is None or entry.tenant_id != DEFAULT_TENANT_ID:
        # 跨租户一律 404，不用 403——不能让对方知道这个 ID 存在
        raise HTTPException(status.HTTP_404_NOT_FOUND, "条目不存在")
    return entry


@router.get("/entries/{entry_id}/fragments", response_model=list[FragmentOut])
async def list_fragments(
    entry_id: int, session: SessionDep, user: CurrentUser
) -> list[KbFragment]:
    del user
    entry = await session.get(KbEntry, entry_id)
    if entry is None or entry.tenant_id != DEFAULT_TENANT_ID:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "条目不存在")
    rows = (
        await session.execute(
            select(KbFragment)
            .where(KbFragment.entry_id == entry_id)
            .order_by(KbFragment.position)
        )
    ).scalars().all()
    return list(rows)


@router.post("/entries", response_model=EntryOut, status_code=status.HTTP_201_CREATED)
async def create_entry(payload: EntryIn, session: SessionDep, admin: AdminUser) -> KbEntry:
    if payload.age_min is not None and payload.age_max is not None:
        if payload.age_min > payload.age_max:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "年龄下限不能大于上限")

    entry = KbEntry(
        tenant_id=DEFAULT_TENANT_ID,
        kind=payload.kind,
        title=payload.title,
        category_id=payload.category_id,
        city=payload.city,
        district=payload.district,
        factory_name=payload.factory_name,
        age_min=payload.age_min,
        age_max=payload.age_max,
        wage_min=payload.wage_min,
        wage_max=payload.wage_max,
        wage_unit=payload.wage_unit,
        has_meal=payload.has_meal,
        has_dorm=payload.has_dorm,
        interview_at=payload.interview_at,
        valid_until=payload.valid_until,
        body=payload.body,
        search_text=_build_search_text(payload),
    )
    del admin
    session.add(entry)
    await session.flush()
    for position, fragment in enumerate(payload.fragments):
        session.add(
            KbFragment(
                entry_id=entry.id,
                position=position,
                kind=fragment.kind,
                content=fragment.content,
                asset_id=fragment.asset_id,
            )
        )
    await session.commit()
    await session.refresh(entry)
    return entry


@router.put("/entries/{entry_id}", response_model=EntryOut)
async def update_entry(
    entry_id: int, payload: EntryIn, session: SessionDep, admin: AdminUser
) -> KbEntry:
    del admin
    entry = await session.get(KbEntry, entry_id)
    if entry is None or entry.tenant_id != DEFAULT_TENANT_ID:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "条目不存在")
    if (
        payload.age_min is not None
        and payload.age_max is not None
        and payload.age_min > payload.age_max
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "年龄下限不能大于上限")

    entry.kind = payload.kind
    entry.title = payload.title
    entry.category_id = payload.category_id
    entry.city = payload.city
    entry.district = payload.district
    entry.factory_name = payload.factory_name
    entry.age_min = payload.age_min
    entry.age_max = payload.age_max
    entry.wage_min = payload.wage_min
    entry.wage_max = payload.wage_max
    entry.wage_unit = payload.wage_unit
    entry.has_meal = payload.has_meal
    entry.has_dorm = payload.has_dorm
    entry.interview_at = payload.interview_at
    entry.valid_until = payload.valid_until
    entry.body = payload.body
    entry.search_text = _build_search_text(payload)
    entry.updated_at = datetime.now(timezone.utc)

    await session.execute(delete(KbFragment).where(KbFragment.entry_id == entry_id))
    for position, fragment in enumerate(payload.fragments):
        session.add(
            KbFragment(
                entry_id=entry.id,
                position=position,
                kind=fragment.kind,
                content=fragment.content,
                asset_id=fragment.asset_id,
            )
        )
    await session.commit()
    await session.refresh(entry)
    return entry


@router.patch("/entries/{entry_id}/status", response_model=EntryOut)
async def set_entry_status(
    entry_id: int, payload: EntryStatusIn, session: SessionDep, admin: AdminUser
) -> KbEntry:
    del admin
    entry = await session.get(KbEntry, entry_id)
    if entry is None or entry.tenant_id != DEFAULT_TENANT_ID:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "条目不存在")
    entry.status = payload.status
    await session.commit()
    await session.refresh(entry)
    return entry


@router.delete("/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(entry_id: int, session: SessionDep, admin: AdminUser) -> None:
    del admin
    entry = await session.get(KbEntry, entry_id)
    if entry is None or entry.tenant_id != DEFAULT_TENANT_ID:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "条目不存在")
    await session.delete(entry)
    await session.commit()

"""Isolated ownership and audit trail for the console's shared FAQ publications."""
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base
from .models_kb import BigIntPK


def publication_now() -> datetime:
    # 首次部署已建成 timestamp without time zone。保持列兼容，以 UTC 无偏移值写入；
    # asyncpg 不接受向该列绑定带时区 datetime，SQLite 测试则不会报错。
    return datetime.now(timezone.utc).replace(tzinfo=None)


class KbPublishedFaq(Base):
    __tablename__ = "kb_published_faq"
    source_id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    faq_id: Mapped[int] = mapped_column(Integer, unique=True)


class KbPublishState(Base):
    __tablename__ = "kb_publish_state"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    generation: Mapped[int] = mapped_column(Integer, default=0)


class KbPublication(Base):
    __tablename__ = "kb_publication"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    digest: Mapped[str] = mapped_column(String(64))
    before_json: Mapped[str] = mapped_column(Text)
    after_json: Mapped[str] = mapped_column(Text)
    result_json: Mapped[str] = mapped_column(Text)
    actor: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), default=publication_now)

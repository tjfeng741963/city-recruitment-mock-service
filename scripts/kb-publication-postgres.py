"""Regression against disposable PostgreSQL, including the deployed timestamp schema."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit
import uuid


async def main():
    url = os.environ.get("KB_PUBLICATION_TEST_DATABASE_URL", "")
    parsed = urlsplit(url)
    if parsed.hostname not in {"127.0.0.1", "localhost"} or not parsed.path.startswith("/kb_publish_test"):
        raise RuntimeError("A disposable loopback kb_publish_test database is required")
    os.environ.update(APP_DATABASE_URL=url, APP_JWT_SECRET="postgres-integration-test-only-32-characters",
                      APP_OUTBOX_WORKER="false", APP_SYNC_WORKER="false", APP_DEVICE_WORKER="false",
                      APP_LEAD_WORKER="false", FLOW_PROFILE_TOKEN="postgres-test-service-key")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
    import asyncpg
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import select, text
    from app.db import engine, init_db, SessionLocal
    from app.main import app
    from app.models_kb import KbFaq
    from app.models_kb_publish import KbPublication, KbPublishState

    # Reproduce the original failure with asyncpg's real timestamp codec.
    connection = await asyncpg.connect(url.replace("postgresql+asyncpg:", "postgresql:", 1))
    try:
        try:
            await connection.fetchval("SELECT $1::timestamp without time zone", datetime.now(timezone.utc))
        except asyncpg.DataError as error:
            assert "offset-naive" in str(error) and "offset-aware" in str(error)
        else:
            raise AssertionError("The original timestamp mismatch was not reproduced")
    finally:
        await connection.close()
    await init_db()
    async with SessionLocal() as session:
        sql_type = await session.scalar(text("SELECT data_type FROM information_schema.columns WHERE table_name='kb_publication' AND column_name='created_at'"))
        assert sql_type == "timestamp without time zone", sql_type
        assert not (await session.execute(select(KbPublication))).scalars().all(), "Database must be fresh"
    headers = {"X-Profile-Token": "postgres-test-service-key"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers=headers) as client:
        async def preview(items, **kwargs):
            response = await client.post("/api/v1/kb/publish/preview", json={"items": items, **kwargs})
            assert response.status_code == 200, response.text
            return response.json()
        async def apply(plan, **kwargs):
            body = {"items": plan["items"], "publication_id": uuid.uuid4().hex,
                    "expected_target": plan["target_id"], "expected_revision": plan["target_revision"],
                    "expected_generation": plan["target_generation"], "payload_digest": plan["payload_digest"], **kwargs}
            return await client.post("/api/v1/kb/publish/apply", json=body)
        item = {"source_id": 16, "question": "工资多少", "answer": "{wage}", "keywords": ["工资"],
                "scope_level": "global", "vertical_code": "subway"}
        plan = await preview([item])
        first = await apply(plan)
        assert first.status_code == 200, first.text
        replay = await apply(plan, publication_id=first.json()["publication_id"])
        assert replay.status_code == 200 and replay.json()["replayed"], replay.text
        async with SessionLocal() as session:
            rows = (await session.execute(select(KbFaq))).scalars().all()
            logs = (await session.execute(select(KbPublication))).scalars().all()
            assert len(rows) == len(logs) == 1
            assert rows[0].answer == "{wage}" and logs[0].created_at is not None
            assert (await session.get(KbPublishState, 1)).generation == 1
        stopped = await apply(await preview([{**item, "status": "disabled"}]))
        assert stopped.status_code == 200, stopped.text
        rollback_of = stopped.json()["publication_id"]
        rollback = await preview([], rollback_of=rollback_of)
        restored = await apply(rollback, items=[], rollback_of=rollback_of)
        assert restored.status_code == 200, restored.text
        history = (await client.get("/api/v1/kb/publish/history")).json()["items"]
        assert len(history) == 3 and all(row["created_at"].endswith("+00:00") for row in history)
    await engine.dispose()
    print("PASS PostgreSQL timestamp reproduction, publication, replay, disable, rollback and UTC audit")


if __name__ == "__main__":
    asyncio.run(main())

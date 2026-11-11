"""知识库 API 的端到端用例：建分类 → 建条目 → 检索命中 → 改状态 → 删除。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from httpx import AsyncClient


def _job_payload(**overrides) -> dict:
    payload = {
        "kind": "job",
        "title": "广州电子厂",
        "city": "广州",
        "age_min": 18,
        "age_max": 55,
        "wage_min": 20,
        "wage_max": 22,
        "wage_unit": "hour",
        "has_meal": True,
        "has_dorm": True,
        "body": "18-55岁 20-22元/小时 包吃住",
        "fragments": [{"kind": "text", "content": "18-55岁 20-22元/小时"}],
    }
    payload.update(overrides)
    return payload


class TestCategoryApi:
    async def test_create_and_list(self, admin_client: AsyncClient) -> None:
        resp = await admin_client.post("/api/v1/kb/categories", json={"label": "广州工厂"})
        assert resp.status_code == 201, resp.text
        category_id = resp.json()["id"]

        listed = await admin_client.get("/api/v1/kb/categories")
        assert listed.status_code == 200
        assert any(c["id"] == category_id for c in listed.json())

    async def test_requires_auth(self, client: AsyncClient) -> None:
        resp = await client.post("/api/v1/kb/categories", json={"label": "x"})
        assert resp.status_code == 401


class TestEntryApi:
    async def test_create_and_get(self, admin_client: AsyncClient) -> None:
        created = await admin_client.post("/api/v1/kb/entries", json=_job_payload())
        assert created.status_code == 201, created.text
        entry = created.json()
        assert entry["kind"] == "job"
        assert entry["age_max"] == 55

        fetched = await admin_client.get(f"/api/v1/kb/entries/{entry['id']}")
        assert fetched.status_code == 200
        assert fetched.json()["title"] == "广州电子厂"

        fragments = await admin_client.get(
            f"/api/v1/kb/entries/{entry['id']}/fragments"
        )
        assert fragments.status_code == 200
        assert len(fragments.json()) == 1

    async def test_inverted_age_rejected(self, admin_client: AsyncClient) -> None:
        resp = await admin_client.post(
            "/api/v1/kb/entries", json=_job_payload(age_min=60, age_max=20)
        )
        assert resp.status_code == 422

    async def test_missing_entry_returns_404(self, admin_client: AsyncClient) -> None:
        resp = await admin_client.get("/api/v1/kb/entries/999999")
        assert resp.status_code == 404

    async def test_status_transition(self, admin_client: AsyncClient) -> None:
        created = await admin_client.post("/api/v1/kb/entries", json=_job_payload())
        entry_id = created.json()["id"]
        resp = await admin_client.patch(
            f"/api/v1/kb/entries/{entry_id}/status", json={"status": "disabled"}
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "disabled"

    async def test_delete(self, admin_client: AsyncClient) -> None:
        created = await admin_client.post("/api/v1/kb/entries", json=_job_payload())
        entry_id = created.json()["id"]
        deleted = await admin_client.delete(f"/api/v1/kb/entries/{entry_id}")
        assert deleted.status_code == 204
        assert (
            await admin_client.get(f"/api/v1/kb/entries/{entry_id}")
        ).status_code == 404


class TestSearchApi:
    async def test_search_by_city(self, admin_client: AsyncClient) -> None:
        await admin_client.post("/api/v1/kb/entries", json=_job_payload())
        resp = await admin_client.post("/api/v1/kb/search", json={"city": "广州"})
        assert resp.status_code == 200
        body = resp.json()
        assert any(h["entry"]["title"] == "广州电子厂" for h in body["hits"])
        assert "sql" in body["tiers_used"]

    async def test_age_detected_from_question(self, admin_client: AsyncClient) -> None:
        """核心场景：'我52了还能去吗' 必须被识别出 52 岁。"""
        await admin_client.post("/api/v1/kb/entries", json=_job_payload())
        await admin_client.post(
            "/api/v1/kb/entries", json=_job_payload(title="卡45的厂", age_max=45)
        )
        resp = await admin_client.post(
            "/api/v1/kb/search", json={"q": "我52了还能去吗", "city": "广州"}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["detected_age"] == 52
        titles = {h["entry"]["title"] for h in body["hits"]}
        assert "卡45的厂" not in titles
        assert "广州电子厂" in titles

    async def test_expired_entry_not_returned(self, admin_client: AsyncClient) -> None:
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        await admin_client.post(
            "/api/v1/kb/entries", json=_job_payload(title="过期厂", valid_until=past)
        )
        resp = await admin_client.post("/api/v1/kb/search", json={"city": "广州"})
        titles = {h["entry"]["title"] for h in resp.json()["hits"]}
        assert "过期厂" not in titles

    async def test_search_requires_login(self, client: AsyncClient) -> None:
        resp = await client.post("/api/v1/kb/search", json={"q": "x"})
        assert resp.status_code == 401


class TestTenantBoundary:
    async def test_unknown_id_is_404_not_403(self, admin_client: AsyncClient) -> None:
        """跨租户访问一律 404，不泄露 ID 是否存在。"""
        resp = await admin_client.get("/api/v1/kb/entries/888888")
        assert resp.status_code == 404


class TestServiceToken:
    """Node 侧自动回复链路没有用户身份，用 X-Service-Token 直连。"""

    async def test_search_with_valid_service_token(
        self, client: AsyncClient, monkeypatch
    ) -> None:
        from app.settings import settings

        monkeypatch.setattr(settings, "kb_service_token", "svc-secret")
        resp = await client.post(
            "/api/v1/kb/search",
            json={"q": "广州"},
            headers={"X-Service-Token": "svc-secret"},
        )
        assert resp.status_code == 200

    async def test_wrong_service_token_rejected(self, client: AsyncClient, monkeypatch) -> None:
        from app.settings import settings

        monkeypatch.setattr(settings, "kb_service_token", "svc-secret")
        resp = await client.post(
            "/api/v1/kb/search",
            json={"q": "广州"},
            headers={"X-Service-Token": "wrong"},
        )
        assert resp.status_code == 401

    async def test_disabled_when_not_configured(self, client: AsyncClient, monkeypatch) -> None:
        """服务令牌留空时这条路径必须关闭，不能默认放行。"""
        from app.settings import settings

        monkeypatch.setattr(settings, "kb_service_token", "")
        resp = await client.post(
            "/api/v1/kb/search",
            json={"q": "广州"},
            headers={"X-Service-Token": ""},
        )
        assert resp.status_code == 401

    async def test_create_entry_accepts_service_token(self, client: AsyncClient, monkeypatch) -> None:
        """「未知问题转知识库」后，写条目也接受服务间令牌（契约 2026-11-11）。"""
        from app.settings import settings

        monkeypatch.setattr(settings, "kb_service_token", "svc-secret")
        resp = await client.post(
            "/api/v1/kb/entries",
            json={"kind": "script", "title": "x", "body": "y"},
            headers={"X-Service-Token": "svc-secret"},
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["status"] == "enabled"  # 模型默认值不变

    async def test_create_entry_accepts_profile_token(self, client: AsyncClient, monkeypatch) -> None:
        """4222 的 convert 用 X-Profile-Token（= FLOW_PROFILE_TOKEN 共享密钥）调 8090。"""
        monkeypatch.setenv("FLOW_PROFILE_TOKEN", "svc-profile-tok")
        resp = await client.post(
            "/api/v1/kb/entries",
            json={"kind": "script", "title": "体检报销吗", "body": "先自付后报销。", "status": "enabled"},
            headers={"X-Profile-Token": "svc-profile-tok"},
        )
        assert resp.status_code == 201, resp.text

        wrong = await client.post(
            "/api/v1/kb/entries",
            json={"kind": "script", "title": "体检报销吗", "body": "x"},
            headers={"X-Profile-Token": "wrong"},
        )
        assert wrong.status_code == 401

        # 未配置 FLOW_PROFILE_TOKEN 时这条通道整体关闭
        monkeypatch.delenv("FLOW_PROFILE_TOKEN", raising=False)
        closed = await client.post(
            "/api/v1/kb/entries",
            json={"kind": "script", "title": "体检报销吗", "body": "x"},
            headers={"X-Profile-Token": "svc-profile-tok"},
        )
        assert closed.status_code == 401

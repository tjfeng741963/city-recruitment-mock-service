"""实例身份（install_id）的持久化与接口。"""

from __future__ import annotations

import json

from app import instance


def test_generates_stable_id(tmp_path):
    path = tmp_path / "instance.json"
    first = instance.load_or_create(path)
    second = instance.load_or_create(path)

    assert first["install_id"]
    assert first["install_id"] == second["install_id"], "同一文件必须复用同一个 id"
    assert path.is_file()


def test_recovers_from_corrupt_file(tmp_path):
    path = tmp_path / "instance.json"
    path.write_text("{ this is not json", encoding="utf-8")

    data = instance.load_or_create(path)

    assert data["install_id"], "文件损坏时要能重建，不能阻塞启动"
    # 重建后写入的是合法 JSON
    assert json.loads(path.read_text(encoding="utf-8"))["install_id"] == data["install_id"]


def test_keeps_tenant_placeholder(tmp_path):
    path = tmp_path / "instance.json"
    data = instance.load_or_create(path)

    assert data["tenant_id"] is None, "服务器端接入前该字段为空"
    assert data["name"] == ""


def test_public_view_hides_nothing_but_is_minimal(tmp_path, monkeypatch):
    path = tmp_path / "instance.json"
    created = instance.load_or_create(path)
    monkeypatch.setattr(instance, "INSTANCE_FILE", path)

    view = instance.public_view()

    assert set(view) == {"install_id", "created_at", "tenant_id", "name"}
    assert view["install_id"] == created["install_id"]


async def test_instance_endpoint(client):
    resp = await client.get("/api/v1/instance")

    assert resp.status_code == 200
    body = resp.json()
    assert body["install_id"]
    assert len(body["install_id"]) == 36  # UUID

from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))
from brain import Brain


def use_transport(client, handler):
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(handler))


def test_opening_refreshes_after_sixty_seconds_and_returns_independent_snapshots(tmp_path, monkeypatch):
    now = [100.0]
    monkeypatch.setattr('brain.time.monotonic', lambda: now[0])
    replies = [
        {"position_id": 22, "opening_version": "a" * 64, "items": [{"seq": 1, "kind": "text", "content": "旧要求", "delay_ms": 0}]},
        {"position_id": 25, "opening_version": "b" * 64, "items": [{"seq": 1, "kind": "text", "content": "新要求", "delay_ms": 2500}]},
    ]
    calls = []
    client = Brain("https://flow.test", "pc", "test-only", flow_cache_path=tmp_path / "cache.json")
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=replies.pop(0))
    use_transport(client, handler)
    first = client.opening()
    first["items"][0]["content"] = "caller mutation"
    assert client.opening()["items"][0]["content"] == "旧要求"
    assert len(calls) == 1
    now[0] += 59
    assert client.opening()["position_id"] == 22
    now[0] += 1
    second = client.opening()
    assert second["position_id"] == 25
    assert second["version"] == "b" * 64
    assert second["synced_at"]
    assert len(calls) == 2
    assert first["items"][0]["delay_ms"] == 0
    client.close()


def test_opening_network_failure_keeps_good_cache_but_reports_stale_and_empty_success_clears_it(tmp_path):
    client = Brain("https://flow.test", "pc", "test-only", flow_cache_path=tmp_path / "cache.json")
    use_transport(client, lambda _: httpx.Response(200, json={"position_id": 22, "opening_version": "a" * 64, "items": [{"content": "旧要求"}]}))
    first = client.opening()
    def offline(request):
        raise httpx.ConnectError("sensitive server detail", request=request)
    use_transport(client, offline)
    stale = client.opening(force=True)
    assert stale["items"] == first["items"]
    assert client.sync_status()["opening"]["state"] == "stale"
    assert client.sync_status()["opening"]["error"] == "network"
    assert client.sync_status()["opening"]["synced_at"] == first["synced_at"]
    use_transport(client, lambda _: httpx.Response(200, json={"position_id": 22, "opening_version": "b" * 64, "items": []}))
    assert client.opening(force=True)["items"] == []
    assert client.sync_status()["opening"]["state"] == "synced"
    assert client.sync_status()["opening"]["version"] == "b" * 64
    client.close()


@pytest.mark.parametrize("status", [401, 403])
def test_opening_revocation_blocks_cached_messages_and_recovers_only_after_success(tmp_path, status):
    client = Brain("https://flow.test", "pc", "test-only", flow_cache_path=tmp_path / "cache.json")
    use_transport(client, lambda _: httpx.Response(200, json={"position_id": 22, "opening_version": "a" * 64, "items": [{"content": "旧要求"}]}))
    client.opening()
    use_transport(client, lambda _: httpx.Response(status))
    assert client.opening(force=True)["blocked"] is True
    assert client.opening()["items"] == []
    assert client.sync_status()["opening"]["state"] == "blocked"
    assert client.sync_status()["opening"]["error"] == "auth"
    def offline(request):
        raise httpx.ConnectError("offline", request=request)
    use_transport(client, offline)
    assert client.opening(force=True)["blocked"] is True
    client.close()


def test_flow_summary_uses_successful_config_version_and_network_failure_is_stale(tmp_path):
    client = Brain("https://flow.test", "pc", "test-only", flow_cache_path=tmp_path / "cache.json")
    use_transport(client, lambda _: httpx.Response(200, json={"position_id": 25, "version": 7, "status": "enabled", "nodes": [{"node_key": "intro"}], "edges": []}))
    client.flow()
    assert client.sync_status()["flow"]["version"] == 7
    def offline(request):
        raise httpx.ConnectError("offline", request=request)
    use_transport(client, offline)
    assert client.flow(force=True)["version"] == 7
    assert client.sync_status()["flow"]["state"] == "stale"
    assert client.sync_status()["flow"]["error"] == "network"
    client.close()


def test_config_sync_refreshes_both_configs_in_background_and_posts_sanitized_summaries(tmp_path, monkeypatch):
    now = [100.0]
    monkeypatch.setattr('brain.time.monotonic', lambda: now[0])
    client = Brain("https://flow.test", "pc", "test-only", flow_cache_path=tmp_path / "cache.json")
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.path.endswith('/flow'):
            return httpx.Response(200, json={"position_id": 25, "version": 7, "status": "enabled", "nodes": [{"parts": [{"body": "private text"}]}]})
        if request.url.path.endswith('/opening'):
            return httpx.Response(200, json={"position_id": 25, "opening_version": "a" * 64, "items": [{"content": "private opening"}]})
        return httpx.Response(200, json={"ok": True})
    use_transport(client, handler)
    assert client.report_config_sync("b" * 40) is True
    assert [r.url.path.rsplit('/', 1)[-1] for r in requests] == ['flow', 'opening', 'config-sync']
    payload = json.loads(requests[-1].content)
    assert payload['client_commit'] == "b" * 40
    assert payload['flow']['version'] == 7
    assert payload['opening']['version'] == "a" * 64
    assert 'private' not in json.dumps(payload)
    assert 'test-only' not in json.dumps(payload)
    assert client.report_config_sync("invalid") is True
    assert len(requests) == 3
    now[0] += 60
    assert client.report_config_sync("invalid") is True
    assert 'client_commit' not in json.loads(requests[-1].content)
    client.close()


def test_sender_reads_cached_snapshot_without_waiting_for_reporter_refresh(tmp_path):
    client = Brain("https://flow.test", "pc", "test-only", flow_cache_path=tmp_path / "cache.json")
    use_transport(client, lambda _: httpx.Response(200, json={"position_id": 22, "opening_version": "a" * 64, "items": [{"content": "旧要求"}]}))
    client.opening()
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    received = []
    def delayed(request):
        entered.set()
        assert release.wait(2)
        return httpx.Response(200, json={"position_id": 22, "opening_version": "b" * 64, "items": [{"content": "新要求"}]} )
    use_transport(client, delayed)
    refresher = threading.Thread(target=lambda: client.opening(force=True))
    refresher.start()
    assert entered.wait(1)
    def sender():
        received.append(client.opening())
        finished.set()
    reader = threading.Thread(target=sender)
    reader.start()
    try:
        assert finished.wait(0.5), "sender waited for the background config network request"
        assert received[0]["items"][0]["content"] == "旧要求"
    finally:
        release.set()
        reader.join(2)
        refresher.join(2)
        client.close()


def test_flow_revocation_remains_blocked_across_restart_until_success(tmp_path):
    path = tmp_path / "cache.json"
    client = Brain("https://flow.test", "pc", "test-only", flow_cache_path=path)
    use_transport(client, lambda _: httpx.Response(200, json={"position_id": 25, "version": 7, "status": "enabled", "nodes": [{"node_key": "intro"}]}))
    client.flow()
    use_transport(client, lambda _: httpx.Response(403))
    assert client.flow(force=True)["blocked"]
    client.close()

    restarted = Brain("https://flow.test", "pc", "test-only", flow_cache_path=path)
    def offline(request):
        raise httpx.ConnectError("offline", request=request)
    use_transport(restarted, offline)
    assert restarted.flow()["blocked"] is True
    assert restarted.sync_status()["flow"]["state"] == "blocked"
    restarted.close()


def test_flow_cache_persists_is_scoped_and_refreshes_disabled_flow(tmp_path):
    path = tmp_path / "flow.remote.json"
    client = Brain("https://flow.test", "pc", "test-only", flow_cache_path=path)
    replies = [{"version": 1, "nodes": [{"node_key": "intro"}]}, {"version": 2, "status": "disabled", "nodes": []}]
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=replies.pop(0))
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
    assert client.flow()["version"] == 1
    assert client.flow()["version"] == 1
    assert len(calls) == 1
    assert "test-only" not in path.read_text(encoding="utf-8")
    assert client.flow(force=True)["nodes"] == []
    client.close()

    restarted = Brain("https://flow.test", "pc", "test-only", flow_cache_path=path)
    def offline(request):
        raise httpx.ConnectError("offline", request=request)
    restarted._client.close()
    restarted._client = httpx.Client(transport=httpx.MockTransport(offline))
    assert restarted.flow()["version"] == 2
    restarted.close()
    other = Brain("https://flow.test", "other", "test-only", flow_cache_path=path)
    other._client.close()
    other._client = httpx.Client(transport=httpx.MockTransport(offline))
    assert not other.flow()["ok"]
    other.close()


def test_revoked_device_does_not_use_cached_flow_and_empty_summary_is_sent(tmp_path):
    path = tmp_path / "flow.remote.json"
    path.write_text(json.dumps({"base_url":"https://flow.test", "device_code":"pc", "flow":{"version":1,"nodes":[{}]}}))
    client = Brain("https://flow.test", "pc", "test-only", flow_cache_path=path)
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(403)))
    assert client.flow()["blocked"]
    client.close()
    requests = []
    def chat(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"ok":True,"reply":{"messages":[{"type":"text","content":"好"}]}})
    client._client = httpx.Client(transport=httpx.MockTransport(chat))
    assert client.chat("你好", "S:1", sent_summary=[])["ok"]
    assert requests[0]["sent_summary"] == []
    client.close()

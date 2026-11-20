from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))
from brain import Brain


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

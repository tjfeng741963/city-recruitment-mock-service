"""客户端 brain._reply_flow 把本地聊天记录带给 /flow/answer。"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from tests.agent_loader import AGENT_DIR


@pytest.fixture
def brain():
    spec = importlib.util.spec_from_file_location("brain_under_test", AGENT_DIR / "brain.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    b = module.Brain("http://brain-test", mode="flow", device_code="pc-win-01", history_limit=6)
    b._token = "t"
    b._token_at = __import__("time").time()
    calls: list[dict] = []

    class Resp:
        status_code = 200

        def json(self):
            return {"reply": "好的", "stage": "send_info", "parts": [], "finished": False}

        @property
        def text(self):
            return ""

    def post(url, json=None, headers=None, **kw):
        calls.append({"url": url, "json": json})
        return Resp()

    b._client = type("FakeClient", (), {"post": staticmethod(post)})()
    # staticmethod 拿不到闭包，直接绑实例方法
    b._client.post = post  # type: ignore[method-assign]
    return b, calls


def test_flow_payload_carries_dialogue_history(brain):
    b, calls = brain
    dialogue = [
        {"role": "customer", "text": "你好", "at": "11-16 16:00"},
        {"role": "agent", "text": "你好，想找哪里的厂"},
        {"role": "customer", "text": "   "},
        {"role": "customer", "text": "广州有没有厂"},
    ]
    res = b.reply("在招人吗", ["旧格式历史"], session_key="S:c1", dialogue=dialogue)
    assert res["ok"] is True
    body = calls[0]["json"]
    assert body["history"] == [
        {"role": "customer", "text": "你好"},
        {"role": "agent", "text": "你好，想找哪里的厂"},
        {"role": "customer", "text": "广州有没有厂"},
    ]
    assert body["device_code"] == "pc-win-01"


def test_flow_payload_without_dialogue_stays_backward_compatible(brain):
    b, calls = brain
    b.reply("在吗", None, session_key="S:c1")
    body = calls[0]["json"]
    assert "history" not in body
    assert body["text"] == "在吗"


def test_flow_dialogue_is_trimmed_to_history_limit(brain):
    b, calls = brain
    dialogue = [{"role": "customer", "text": f"m{i}"} for i in range(20)]
    b.reply("继续", None, session_key="S:c1", dialogue=dialogue)
    body = calls[0]["json"]
    assert len(body["history"]) == 12  # history_limit * 2
    assert body["history"][0]["text"] == "m8"

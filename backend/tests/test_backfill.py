"""补录脚本的纯函数测试：解析器 / 确定性抽取 / GET 对比剔除 / 指纹幂等。

不碰网络、不碰库；HTTP 相关用 httpx.MockTransport 注入。
"""

from __future__ import annotations

import json

import httpx
import pytest

from scripts.backfill_profiles import (
    ChatBlock,
    build_push_profile,
    drop_filled_keys,
    extract_slots_deterministic,
    fetch_current,
    fingerprint,
    flatten_current,
    is_done,
    load_state,
    merge_llm_slots,
    parse_blocks,
    parse_llm_json,
    push_profile,
    render_transcript,
    save_state,
)


# ─────────────────────────── 解析器 ───────────────────────────
def test_parse_role_aliases():
    text = """设备: pc-win-01
客户昵称: 小张
我: 想去哪个城市？
顾问: 深圳，工厂直招
客户: 好的"""
    blocks, skipped = parse_blocks(text)
    assert not skipped
    assert len(blocks) == 1
    assert blocks[0].messages == [
        ("customer", "想去哪个城市？"),
        ("operator", "深圳，工厂直招"),
        ("customer", "好的"),
    ]


def test_parse_block_separator_and_headers():
    text = """===== 会话 1 =====
设备: pc-win-01
客户昵称: 张小姐
时间: 2026-11-10 10:20
客户: 广州

===== 会话 2 =====
设备：pc-win-02
客户昵称：老王
客户：深圳的活"""
    blocks, skipped = parse_blocks(text)
    assert not skipped
    assert [b.nickname for b in blocks] == ["张小姐", "老王"]
    assert blocks[0].device == "pc-win-01" and blocks[0].time_text == "2026-11-10 10:20"
    # 全角冒号同样支持
    assert blocks[1].device == "pc-win-02"


def test_parse_skips_dirty_blocks():
    text = """客户昵称: 没有客户发言的块
运营: 在吗

===== 会话 2 =====

客户: 光秃秃没有昵称的块"""
    blocks, skipped = parse_blocks(text)
    assert not blocks
    assert len(skipped) == 2
    assert any("客户昵称" in item.reason for item in skipped)
    assert any("客户发言" in item.reason for item in skipped)


def test_parse_dirty_lines_recorded_as_warnings():
    text = """客户昵称: 小李
客户: 你好
这行没有角色前缀"""
    blocks, _ = parse_blocks(text)
    assert len(blocks) == 1
    assert blocks[0].messages == [("customer", "你好")]
    assert any("没有角色前缀" in warning for warning in blocks[0].warnings)


# ─────────────────────────── 确定性抽取 ───────────────────────────
def test_extract_name_phone_city_district():
    messages = [("customer", "我叫张丽，手机13512345678，想去广州，番禺区")]
    slots = extract_slots_deterministic(messages)
    assert slots["name"] == "张丽"
    assert slots["phone"] == "13512345678"
    assert slots["city"] == "广州"
    assert slots["district"] == "番禺区"


def test_extract_ignores_operator_lines():
    messages = [
        ("operator", "请报一下电话"),
        ("customer", "我先看看"),
    ]
    slots = extract_slots_deterministic(messages)
    assert "phone" not in slots
    assert "name" not in slots


# ─────────────────────────── LLM 补抽的纯函数部分 ───────────────────────────
def test_parse_llm_json_strips_fences():
    content = '```json\n{"city": "广州", "gender": "女", "name": "张丽"}\n```'
    assert parse_llm_json(content)["city"] == "广州"
    assert parse_llm_json("前置说明\n{\"phone\": \"13512345678\"}")["phone"] == "13512345678"
    assert parse_llm_json("完全不是 JSON") == {}


def test_merge_llm_slots_fills_only_empty():
    slots = {"name": "张丽", "phone": "13512345678"}
    merge_llm_slots(slots, {"city": "广州", "gender": "女", "name": "不该覆盖", "gender_bad": "x"})
    assert slots["city"] == "广州"
    assert slots["gender"] == "女"
    assert slots["name"] == "张丽"  # 已有值不被 LLM 覆盖
    merge_llm_slots(slots, {"gender": "未知"})  # 非法性别被丢掉
    assert slots["gender"] == "女"


@pytest.mark.asyncio
async def test_extract_all_llm_with_mock_provider():
    from scripts.backfill_profiles import extract_all_llm

    class FakeProvider:
        async def complete(self, messages, **kwargs):
            return '{"city": "深圳", "notes": "要长白班"}'

    blocks = [
        ChatBlock(nickname="a", messages=[("customer", "深圳的活")]),
        ChatBlock(nickname="b", messages=[("customer", "嗯")]),
    ]
    results = await extract_all_llm(FakeProvider(), blocks)
    assert results[0] == {"city": "深圳", "notes": "要长白班"}
    assert render_transcript(blocks[0].messages) == "客户: 深圳的活"


# ─────────────────────────── GET 对比剔除 ───────────────────────────
def _current(**overrides):
    body = {
        "name": "已有姓名",
        "phone": "",
        "remark": "人工写的备注",
        "city": "",
        "profile": {"gender": "男"},
    }
    body.update(overrides)
    return body


def test_drop_filled_keys_name_not_pushed_empty_city_kept():
    profile = {"name": "新名字", "city": "广州", "phone": "13512345678", "gender": "女"}
    out = drop_filled_keys(profile, _current())
    assert "name" not in out  # 系统里已有姓名 → 不推
    assert "gender" not in out  # profile_json 里已有性别 → 不推
    assert out["city"] == "广州"  # 空字段照推
    assert out["phone"] == "13512345678"


def test_drop_filled_keys_notes_maps_remark():
    profile = {"notes": "脚本备注"}
    assert drop_filled_keys(profile, _current()) == {}  # remark 已非空
    assert drop_filled_keys(profile, _current(remark="")) == {"notes": "脚本备注"}


def test_flatten_current_columns_win_over_profile_json():
    body = {"city": "深圳", "profile": {"city": "广州", "job_title": "普工"}}
    flat = flatten_current(body)
    assert flat["city"] == "深圳"  # 列值是权威
    assert flat["job_title"] == "普工"


def test_drop_filled_keys_no_current_returns_all():
    profile = {"city": "广州"}
    assert drop_filled_keys(profile, {}) == profile


# ─────────────────────────── HTTP（MockTransport） ───────────────────────────
@pytest.mark.asyncio
async def test_fetch_current_404_and_ok():
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("external_conversation_id") == "ghost":
            return httpx.Response(404, json={"detail": "conversation not found"})
        return httpx.Response(200, json={"name": "张丽", "city": "广州"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        status, body = await fetch_current(client, "tok", "pc-win-01", "real")
        assert status == 200 and body["name"] == "张丽"
        status, body = await fetch_current(client, "tok", "pc-win-01", "ghost")
        assert status == 404 and body == {}


@pytest.mark.asyncio
async def test_push_profile_returns_status_code():
    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["token"] = request.headers.get("x-profile-token")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        status = await push_profile(client, "tok", "pc-win-01", "sk1", {"city": "广州"})
        assert status == 200
        assert seen["token"] == "tok"
        assert seen["body"]["external_conversation_id"] == "sk1"
        assert seen["body"]["profile"] == {"city": "广州"}


# ─────────────────────────── 组装与幂等 ───────────────────────────
def test_build_push_profile_drops_stage():
    slots = {"city": "广州", "name": "张丽", "phone": "13512345678"}
    profile = build_push_profile(slots)
    assert "stage" not in profile  # 不推进状态机
    assert profile["name"] == "张丽"


def test_build_push_profile_explicit_job_title_wins():
    slots = {"city": "广州", "job_title": "钟村电子厂 组装工"}
    profile = build_push_profile(slots)
    assert profile["job_title"] == "钟村电子厂 组装工"
    assert profile["factory_name"] == "钟村电子厂"


def test_fingerprint_stable_and_discriminating():
    messages = [("customer", "广州，我叫张丽"), ("operator", "好的")]
    fp = fingerprint("张小姐", messages)
    assert fp == fingerprint("张小姐", list(messages))
    assert fp != fingerprint("老王", messages)
    assert fp != fingerprint("张小姐", [("customer", "别的首条消息")])


def test_state_roundtrip_and_skip(tmp_path):
    path = tmp_path / "state.json"
    assert load_state(path) == {}
    save_state(path, {"abc": {"result": "ok"}, "bad": {"result": "failed"}})
    state = load_state(path)
    assert is_done(state, "abc")
    assert not is_done(state, "bad")  # 失败的不跳过，允许重跑
    assert not is_done(state, "missing")
